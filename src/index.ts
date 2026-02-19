/**
 * WOPR WhatsApp Plugin - Baileys-based WhatsApp Web integration
 */

import fs, { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	type AnyMessageContent,
	type AuthenticationState,
	BufferJSON,
	type Contact,
	DisconnectReason,
	downloadMediaMessage,
	extensionForMediaMessage,
	fetchLatestBaileysVersion,
	type GroupMetadata,
	getContentType,
	makeCacheableSignalKeyStore,
	makeWASocket,
	useMultiFileAuthState,
	type WAMessage,
	type WASocket,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import winston from "winston";
import { useStorageAuthState } from "./auth-state.js";
import { DEFAULT_REACTION_EMOJIS, ReactionStateMachine } from "./reactions.js";
import { DEFAULT_RETRY_CONFIG, type RetryConfig, withRetry } from "./retry.js";
import type { PluginContextWithStorage, PluginStorageAPI } from "./storage.js";
import {
	WHATSAPP_CREDS_SCHEMA,
	WHATSAPP_CREDS_TABLE,
	WHATSAPP_KEYS_SCHEMA,
	WHATSAPP_KEYS_TABLE,
} from "./storage.js";
import { StreamManager } from "./streaming.js";
import type {
	AgentIdentity,
	ChannelCommand,
	ChannelCommandContext,
	ChannelMessageContext,
	ChannelMessageParser,
	ChannelProvider,
	ChannelRef,
	ConfigField,
	ConfigSchema,
	PluginInjectOptions,
	PluginManifest,
	StreamMessage,
	WOPRPlugin,
	WOPRPluginContext,
} from "./types.js";
import {
	createWhatsAppWebMCPExtension,
	type WhatsAppWebMCPExtension,
} from "./whatsapp-extension.js";

// Media types that WhatsApp supports for incoming messages
const MEDIA_MESSAGE_TYPES = [
	"imageMessage",
	"documentMessage",
	"audioMessage",
	"videoMessage",
	"stickerMessage",
] as const;

// WhatsApp media size limits (bytes)
const MEDIA_SIZE_LIMITS: Record<string, number> = {
	image: 16 * 1024 * 1024, // 16 MB
	video: 64 * 1024 * 1024, // 64 MB
	audio: 16 * 1024 * 1024, // 16 MB
	document: 100 * 1024 * 1024, // 100 MB
	sticker: 500 * 1024, // 500 KB
};

// WhatsApp-specific types
interface WhatsAppMessage {
	id: string;
	from: string;
	fromMe: boolean;
	timestamp: number;
	text?: string;
	mediaType?: string;
	mediaPath?: string;
	caption?: string;
	quotedMessage?: WhatsAppMessage;
	isGroup: boolean;
	groupName?: string;
	sender?: string;
	participant?: string;
}

interface WhatsAppConfig {
	accountId?: string;
	authDir?: string;
	dmPolicy?: "allowlist" | "blocklist" | "open" | "disabled";
	allowFrom?: string[];
	selfChatMode?: boolean;
	ownerNumber?: string;
	verbose?: boolean;
	pairingRequests?: Record<
		string,
		{ code: string; name: string; requestedAt: number }
	>;
	retry?: Partial<RetryConfig>;
}

// Per-session state (mirrors Discord plugin's SessionState)
interface SessionState {
	thinkingLevel: string;
	messageCount: number;
	model: string;
}

const sessionStates = new Map<string, SessionState>();

export function getSessionState(sessionKey: string): SessionState {
	if (!sessionStates.has(sessionKey)) {
		sessionStates.set(sessionKey, {
			thinkingLevel: "medium",
			messageCount: 0,
			model: "claude-sonnet-4-20250514",
		});
	}
	return sessionStates.get(sessionKey)!;
}

// Module-level state
let socket: WASocket | null = null;
let ctx: WOPRPluginContext | null = null;
let config: WhatsAppConfig = {};
let agentIdentity: AgentIdentity = { name: "WOPR", emoji: "👀" };
let storage: PluginStorageAPI | null = null;
const contacts: Map<string, Contact> = new Map();
const groups: Map<string, GroupMetadata> = new Map();
const messageCache: Map<string, WhatsAppMessage> = new Map();
const sessionOverrides: Map<string, string> = new Map();
let logger: winston.Logger;

// WebMCP extension state
let webmcpExtension: WhatsAppWebMCPExtension | null = null;
let connectTime: number | null = null;
let totalMessageCount = 0;

// Stream manager for active streaming sessions
const streamManager = new StreamManager();

// Typing indicator refresh interval (composing status expires after ~10s in WhatsApp)
const TYPING_REFRESH_MS = 5000;

// Active typing intervals tracked for cleanup during shutdown/logout
const activeTypingIntervals: Set<NodeJS.Timeout> = new Set();

// Ref-counting per jid to handle concurrent typing indicators
const typingRefCounts: Map<
	string,
	{ count: number; interval: NodeJS.Timeout }
> = new Map();

// ============================================================================
// Channel Provider (cross-plugin command/parser registration)
// ============================================================================

const registeredCommands: Map<string, ChannelCommand> = new Map();
const registeredParsers: Map<string, ChannelMessageParser> = new Map();

/**
 * WhatsApp Channel Provider - allows other plugins to register commands
 * and message parsers on the WhatsApp channel.
 */
const whatsappChannelProvider: ChannelProvider = {
	id: "whatsapp",

	registerCommand(cmd: ChannelCommand): void {
		registeredCommands.set(cmd.name, cmd);
		logger?.info(`Channel command registered: ${cmd.name}`);
	},

	unregisterCommand(name: string): void {
		registeredCommands.delete(name);
	},

	getCommands(): ChannelCommand[] {
		return Array.from(registeredCommands.values());
	},

	addMessageParser(parser: ChannelMessageParser): void {
		registeredParsers.set(parser.id, parser);
		logger?.info(`Message parser registered: ${parser.id}`);
	},

	removeMessageParser(id: string): void {
		registeredParsers.delete(id);
	},

	getMessageParsers(): ChannelMessageParser[] {
		return Array.from(registeredParsers.values());
	},

	async send(channel: string, content: string): Promise<void> {
		await sendMessageInternal(channel, content);
	},

	getBotUsername(): string {
		return agentIdentity.name || "WOPR";
	},
};

// ============================================================================
// WhatsApp Extension (for cross-plugin notifications)
// ============================================================================

/**
 * Extension object exposed via ctx.registerExtension("whatsapp", ...).
 * Other plugins can use this to send messages through WhatsApp.
 */
const whatsappExtension = {
	send: async (to: string, message: string): Promise<void> => {
		if (!socket) throw new Error("WhatsApp socket is not connected");
		await sendMessageInternal(to, message);
	},
	isConnected: (): boolean => socket !== null,
};

// Attachments directory for downloaded media
const WOPR_HOME =
	process.env.WOPR_HOME || path.join(process.env.HOME || "~", ".wopr");
const ATTACHMENTS_DIR = path.join(WOPR_HOME, "attachments", "whatsapp");

// Maximum download size (default 100 MB, configurable via env)
const MAX_MEDIA_BYTES =
	Number(process.env.WOPR_WA_MAX_MEDIA_BYTES) || 100 * 1024 * 1024;

/** Return true if `filePath` resolves inside `allowedDir` (realpath check). */
async function isInsideDir(
	filePath: string,
	allowedDir: string,
): Promise<boolean> {
	try {
		const resolvedFile = await realpath(filePath);
		const resolvedDir = await realpath(allowedDir);
		return (
			resolvedFile.startsWith(resolvedDir + path.sep) ||
			resolvedFile === resolvedDir
		);
	} catch {
		return false;
	}
}

/** Sanitize a filename: strip path separators, control chars, and fallback to a hash. */
export function sanitizeFilename(name: string): string {
	// Remove anything that isn't alphanumeric, dot, dash, or underscore
	const clean = name.replace(/[^a-zA-Z0-9._-]/g, "_");
	if (!clean || clean === "." || clean === "..") {
		return `file_${Date.now()}`;
	}
	return clean;
}

// Initialize winston logger
function initLogger(): winston.Logger {
	return winston.createLogger({
		level: "debug",
		format: winston.format.combine(
			winston.format.timestamp(),
			winston.format.errors({ stack: true }),
			winston.format.json(),
		),
		defaultMeta: { service: "wopr-plugin-whatsapp" },
		transports: [
			new winston.transports.File({
				filename: path.join(WOPR_HOME, "logs", "whatsapp-plugin-error.log"),
				level: "error",
			}),
			new winston.transports.File({
				filename: path.join(WOPR_HOME, "logs", "whatsapp-plugin.log"),
				level: "debug",
			}),
			new winston.transports.Console({
				format: winston.format.combine(
					winston.format.colorize(),
					winston.format.simple(),
				),
				level: "warn",
			}),
		],
	});
}

// Config schema for the plugin
export const configSchema: ConfigSchema = {
	title: "WhatsApp Integration",
	description: "Configure WhatsApp Web integration using Baileys",
	fields: [
		{
			name: "accountId",
			type: "text",
			label: "Account ID",
			placeholder: "default",
			default: "default",
			description: "Unique identifier for this WhatsApp account",
		},
		{
			name: "dmPolicy",
			type: "select",
			label: "DM Policy",
			placeholder: "allowlist",
			default: "allowlist",
			description:
				"How to handle direct messages: allowlist, open, or disabled",
		},
		{
			name: "allowFrom",
			type: "array",
			label: "Allowed Numbers",
			placeholder: "+1234567890",
			description: "Phone numbers allowed to DM (E.164 format)",
		},
		{
			name: "selfChatMode",
			type: "boolean",
			label: "Self-Chat Mode",
			default: false,
			description:
				"Enable for personal phone numbers (prevents spamming contacts)",
		},
		{
			name: "ownerNumber",
			type: "text",
			label: "Owner Number",
			placeholder: "+1234567890",
			description: "Your phone number for self-chat mode",
		},
		{
			name: "verbose",
			type: "boolean",
			label: "Verbose Logging",
			default: false,
			description: "Enable detailed Baileys logging",
		},
		{
			name: "pairingRequests",
			type: "object",
			label: "Pairing Requests",
			hidden: true,
			default: {},
		} as ConfigField,
	],
};

// Refresh identity from workspace
async function refreshIdentity(): Promise<void> {
	if (!ctx) return;
	try {
		const identity = await ctx.getAgentIdentity();
		if (identity) {
			agentIdentity = { ...agentIdentity, ...identity };
			logger.info("Identity refreshed:", agentIdentity.name);
		}
	} catch (e) {
		logger.warn("Failed to refresh identity:", String(e));
	}
}

function getAuthDir(accountId: string): string {
	if (config.authDir) {
		return path.join(config.authDir, accountId);
	}
	return path.join(os.homedir(), ".wopr", "credentials", "whatsapp", accountId);
}

async function hasCredentials(accountId: string): Promise<boolean> {
	// Check Storage API first
	if (storage) {
		try {
			const val = await storage.get(WHATSAPP_CREDS_TABLE, accountId);
			if (val != null) return true;
		} catch {
			// Storage failed, fall through to filesystem
		}
	}

	// Fallback: check filesystem
	const authDir = getAuthDir(accountId);
	const credsPath = path.join(authDir, "creds.json");

	try {
		await fs.access(credsPath);
		return true;
	} catch {
		return false;
	}
}

async function ensureAuthDir(accountId: string): Promise<void> {
	const authDir = getAuthDir(accountId);
	try {
		await fs.mkdir(authDir, { recursive: true });
	} catch {
		// Directory already exists
	}
}

// Helper to read creds.json safely
function readCredsJsonRaw(filePath: string): string | null {
	try {
		const fsSync = require("node:fs");
		if (!fsSync.existsSync(filePath)) return null;
		const stats = fsSync.statSync(filePath);
		if (!stats.isFile() || stats.size <= 1) return null;
		return fsSync.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

// Maybe restore credentials from backup
function maybeRestoreCredsFromBackup(authDir: string): void {
	const credsPath = path.join(authDir, "creds.json");
	const backupPath = path.join(authDir, "creds.json.bak");

	try {
		const fsSync = require("node:fs");
		if (!fsSync.existsSync(credsPath) && fsSync.existsSync(backupPath)) {
			const raw = readCredsJsonRaw(backupPath);
			if (raw) {
				try {
					JSON.parse(raw); // Validate
					fsSync.copyFileSync(backupPath, credsPath);
					logger.info("Restored credentials from backup");
				} catch {
					// Invalid backup
				}
			}
		}
	} catch {
		// Ignore
	}
}

/**
 * Migrate legacy filesystem-based auth state into the Storage API.
 * Runs once per account — if creds already exist in storage, it's a no-op.
 * After successful migration, renames the legacy dir to `.migrated`.
 */
async function maybeRunMigration(accountId: string): Promise<void> {
	if (!storage) return;

	// Skip if storage already has creds for this account
	const existing = await storage.get(WHATSAPP_CREDS_TABLE, accountId);
	if (existing != null) return;

	const authDir = getAuthDir(accountId);
	const credsPath = path.join(authDir, "creds.json");

	const credsRaw = readCredsJsonRaw(credsPath);
	if (!credsRaw) return; // No legacy creds to migrate

	try {
		const creds = JSON.parse(credsRaw);

		// Migrate signal key files FIRST (anything that isn't creds.json or .bak)
		// Keys are migrated before creds so creds acts as the "migration complete" marker.
		// If we crash before writing creds, migration will re-run safely on next startup.
		const entries = await fs.readdir(authDir);
		for (const entry of entries) {
			if (entry === "creds.json" || entry === "creds.json.bak") continue;
			const filePath = path.join(authDir, entry);
			try {
				const stat = await fs.stat(filePath);
				if (!stat.isFile()) continue;
				const raw = await fs.readFile(filePath, "utf-8");
				const value = JSON.parse(raw);
				// Serialize through BufferJSON to preserve Buffer instances
				const serializedValue = JSON.parse(
					JSON.stringify(value, BufferJSON.replacer),
				);
				// Key files are typically named like "pre-key-1.json"
				const keyName = entry.replace(/\.json$/, "");
				const storageKey = `${accountId}:${keyName}`;
				await storage.put(WHATSAPP_KEYS_TABLE, storageKey, serializedValue);
			} catch {
				// Skip files that can't be parsed
			}
		}

		// Write creds LAST — this is the "migration complete" marker.
		// If we crash before this point, migration will re-run on next startup
		// and re-migrate any keys that were successfully written, which is safe.
		const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
		await storage.put(WHATSAPP_CREDS_TABLE, accountId, serialized);
		logger.info(`Migrated creds for account ${accountId} to Storage API`);

		// Rename legacy dir to mark migration complete; fall back to removal
		const migratedDir = `${authDir}.migrated`;
		try {
			await fs.rename(authDir, migratedDir);
			logger.info(`Renamed legacy auth dir to ${migratedDir}`);
		} catch {
			logger.warn(`Could not rename legacy auth dir, removing instead`);
			try {
				await fs.rm(authDir, { recursive: true, force: true });
			} catch (rmErr) {
				logger.warn(
					`Could not remove legacy auth dir ${authDir}: ${String(rmErr)}`,
				);
			}
		}
	} catch (err) {
		logger.error(`Migration failed for account ${accountId}: ${String(err)}`);
	}
}

// Get status code from disconnect error
function getStatusCode(err: any): number | undefined {
	return err?.output?.statusCode ?? err?.status;
}

// Convert phone number or JID to JID format
export function toJid(phoneOrJid: string): string {
	if (phoneOrJid.includes("@")) {
		return phoneOrJid;
	}
	const normalized = phoneOrJid.replace(/[^0-9]/g, "");
	return `${normalized}@s.whatsapp.net`;
}

// Check if sender is allowed based on DM policy
export function isAllowed(from: string, isGroup: boolean): boolean {
	if (isGroup) return true; // Groups are always allowed

	const policy = config.dmPolicy || "allowlist";

	switch (policy) {
		case "disabled":
			return false;
		case "open":
			return true;
		case "allowlist": {
			const allowed = config.allowFrom || [];
			if (allowed.includes("*")) return true;

			const phone = from.split("@")[0];
			return allowed.some((num) => {
				const normalized = num.replace(/[^0-9]/g, "");
				return phone === normalized || phone.endsWith(normalized);
			});
		}
		default:
			return true;
	}
}

// Extract text from WhatsApp message
export function extractText(msg: WAMessage): string | undefined {
	const content = msg.message;
	if (!content) return undefined;

	if (content.conversation) {
		return content.conversation;
	} else if (content.extendedTextMessage?.text) {
		return content.extendedTextMessage.text;
	} else if (content.imageMessage?.caption) {
		return content.imageMessage.caption;
	} else if (content.videoMessage?.caption) {
		return content.videoMessage.caption;
	} else if (content.documentMessage?.caption) {
		return content.documentMessage.caption;
	}
	return undefined;
}

// Ensure attachments directory exists
async function ensureAttachmentsDir(): Promise<void> {
	try {
		await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });
	} catch {
		// Directory already exists
	}
}

// Detect if a message contains media and return the media type key
function getMediaType(
	msg: WAMessage,
): (typeof MEDIA_MESSAGE_TYPES)[number] | null {
	const content = msg.message;
	if (!content) return null;

	const contentType = getContentType(content);
	if (!contentType) return null;

	for (const mt of MEDIA_MESSAGE_TYPES) {
		if (contentType === mt) return mt;
	}
	return null;
}

// Extract declared file size from WhatsApp message metadata (before downloading)
function getMediaFileLength(msg: WAMessage): number | null {
	const content = msg.message;
	if (!content) return null;

	const sub =
		content.imageMessage ||
		content.videoMessage ||
		content.audioMessage ||
		content.documentMessage ||
		content.stickerMessage;
	if (!sub) return null;

	const len = (sub as Record<string, unknown>).fileLength;
	if (typeof len === "number" && len > 0) return len;
	if (typeof len === "string" && Number(len) > 0) return Number(len);
	// Baileys may expose fileLength as Long
	if (
		len &&
		typeof (len as { toNumber?: () => number }).toNumber === "function"
	) {
		return (len as { toNumber: () => number }).toNumber();
	}
	return null;
}

// Download media from a WhatsApp message and save to disk
// Returns the file path on success, or null on failure
async function downloadWhatsAppMedia(msg: WAMessage): Promise<string | null> {
	try {
		// Pre-download size check from message metadata
		const declaredSize = getMediaFileLength(msg);
		if (declaredSize !== null && declaredSize > MAX_MEDIA_BYTES) {
			logger.warn(
				`Media too large per metadata (${declaredSize} bytes, limit ${MAX_MEDIA_BYTES}), skipping download`,
			);
			return null;
		}

		await ensureAttachmentsDir();

		const ext = sanitizeFilename(
			extensionForMediaMessage(msg.message!) || "bin",
		);
		const timestamp = Date.now();
		const rawSenderId = (
			msg.key.participant ||
			msg.key.remoteJid ||
			"unknown"
		).split("@")[0];
		const senderId = sanitizeFilename(rawSenderId);
		const filename = `${timestamp}-${senderId}.${ext}`;
		const filepath = path.join(ATTACHMENTS_DIR, filename);

		const buffer = await downloadMediaMessage(msg, "buffer", {});

		// Post-download safety net: verify actual size
		if (buffer.length > MAX_MEDIA_BYTES) {
			logger.warn(
				`Media too large after download (${buffer.length} bytes, limit ${MAX_MEDIA_BYTES}), skipping`,
			);
			return null;
		}

		await fs.writeFile(filepath, buffer);

		logger.info(`Media saved: ${filename} (${buffer.length} bytes)`);
		return filepath;
	} catch (err) {
		logger.error(`Failed to download media: ${String(err)}`);
		return null;
	}
}

// Determine the media category (image, audio, document, video, sticker)
export function mediaCategory(mediaType: string): string {
	if (mediaType === "imageMessage") return "image";
	if (mediaType === "audioMessage") return "audio";
	if (mediaType === "videoMessage") return "video";
	if (mediaType === "stickerMessage") return "sticker";
	return "document";
}

// Run registered message parsers against an incoming message
async function runMessageParsers(waMsg: WhatsAppMessage): Promise<void> {
	if (!waMsg.text) return;

	for (const parser of registeredParsers.values()) {
		try {
			const matches =
				typeof parser.pattern === "function"
					? parser.pattern(waMsg.text)
					: parser.pattern.test(waMsg.text);

			if (matches) {
				const parserCtx: ChannelMessageContext = {
					channel: waMsg.from,
					channelType: "whatsapp",
					sender: waMsg.sender || waMsg.from.split("@")[0],
					content: waMsg.text,
					reply: async (msg: string) => {
						await sendMessageInternal(waMsg.from, msg);
					},
					getBotUsername: () => whatsappChannelProvider.getBotUsername(),
				};
				await parser.handler(parserCtx);
			}
		} catch (e) {
			logger.error(`Message parser ${parser.id} error: ${e}`);
		}
	}
}

// Process incoming message
async function handleIncomingMessage(msg: WAMessage): Promise<void> {
	if (!socket || !ctx) return;

	const messageId = msg.key.id || `${Date.now()}-${Math.random()}`;
	const from = msg.key.remoteJid || "";
	const fromMe = msg.key.fromMe || false;
	const timestamp = msg.messageTimestamp
		? Number(msg.messageTimestamp) * 1000
		: Date.now();
	const isGroup = from.endsWith("@g.us");
	const participant = msg.key.participant || undefined;

	// Skip messages from self
	if (fromMe) return;

	// Check DM policy
	if (!isAllowed(from, isGroup)) {
		logger.info(`Message from ${from} blocked by DM policy`);
		return;
	}

	// Track total messages processed (for WebMCP stats)
	totalMessageCount++;

	// Interrupt any active stream for this chat (user sent a new message mid-stream)
	const jid = toJid(from);
	if (streamManager.interrupt(jid)) {
		logger.info(`Stream interrupted by new message from ${from}`);
	}

	const text = extractText(msg);

	// Get sender name
	let sender: string | undefined;
	if (participant) {
		const contact = contacts.get(participant);
		sender = contact?.notify || contact?.name || participant.split("@")[0];
	} else {
		const contact = contacts.get(from);
		sender = contact?.notify || contact?.name || from.split("@")[0];
	}

	// Get group name
	let groupName: string | undefined;
	if (isGroup) {
		const group = groups.get(from);
		groupName = group?.subject;
	}

	// Detect and download media
	let mediaPath: string | undefined;
	let mediaType: string | undefined;
	const detectedMediaType = getMediaType(msg);
	if (detectedMediaType) {
		mediaType = mediaCategory(detectedMediaType);
		const downloaded = await downloadWhatsAppMedia(msg);
		if (downloaded) {
			mediaPath = downloaded;
		} else {
			// Notify user that media could not be processed
			try {
				await sendMessageInternal(
					from,
					"Sorry, I could not process that media file.",
					msg,
				);
			} catch (notifyErr) {
				logger.error(
					`Failed to send media error notification: ${String(notifyErr)}`,
				);
			}
		}
	}

	const waMessage: WhatsAppMessage = {
		id: messageId,
		from,
		fromMe,
		timestamp,
		text,
		mediaType,
		mediaPath,
		isGroup,
		sender,
		groupName,
		participant,
	};

	// Cache for reaction handling
	messageCache.set(messageId, waMessage);

	// Create channel info
	const channelInfo: ChannelRef = {
		type: "whatsapp",
		id: from,
		name: groupName || (isGroup ? "Group" : "WhatsApp DM"),
	};

	// Log message for context
	const logOptions: { from?: string; channel?: ChannelRef } = {
		from: sender || from,
		channel: channelInfo,
	};

	const defaultKey = `whatsapp-${from}`;
	const sessionKey = sessionOverrides.get(defaultKey) || defaultKey;
	const logText = text || (mediaType ? `[${mediaType}]` : "[media]");
	ctx.logMessage(sessionKey, logText, logOptions);

	// Create reaction state machine for this message
	const reactionSM = new ReactionStateMachine(
		from,
		messageId,
		sendReactionInternal,
		logger,
	);

	// Set queued state when message enters the pipeline
	await reactionSM.transition("queued");

	// Check for !command prefix before injecting
	if (text) {
		try {
			const handled = await handleTextCommand(waMessage, sessionKey, msg);
			if (handled) {
				// Command was handled directly — mark done
				await reactionSM.transition("active");
				await reactionSM.transition("done");
			} else {
				// Run registered message parsers from other plugins
				await runMessageParsers(waMessage);

				// Not a command — track message count and inject into WOPR
				const state = getSessionState(sessionKey);
				state.messageCount++;
				await injectMessage(waMessage, sessionKey, reactionSM, msg);
			}
		} catch (e) {
			logger.error(`Command handler error: ${e}`);
			await injectMessage(waMessage, sessionKey, reactionSM, msg);
		}
		return;
	}

	// No text — skip if no media either
	if (!mediaPath) {
		await reactionSM.transition("active");
		await reactionSM.transition("done");
		return;
	}

	// Media only — inject into WOPR, then clean up temp media
	try {
		await injectMessage(waMessage, sessionKey, reactionSM, msg);
	} finally {
		// Clean up downloaded media after processing
		if (mediaPath) {
			fs.unlink(mediaPath).catch((err) => {
				logger.warn(
					`Failed to clean up temp media ${mediaPath}: ${String(err)}`,
				);
			});
		}
	}
}

// Send reaction internally (with retry)
async function sendReactionInternal(
	chatJid: string,
	messageId: string,
	emoji: string,
): Promise<void> {
	if (!socket) return;

	await withRetry(
		() => {
			if (!socket) throw new Error("WhatsApp not connected");
			return socket.sendMessage(chatJid, {
				react: {
					text: emoji,
					key: {
						remoteJid: chatJid,
						id: messageId,
						fromMe: false,
					},
				},
			});
		},
		`sendReaction to ${chatJid}`,
		logger,
		config.retry,
	);
}

// Parse a !command from message text. Returns null if not a command.
export function parseCommand(
	text: string,
): { name: string; args: string } | null {
	const match = text.match(/^!(\w+)(?:\s+(.*))?$/s);
	if (!match) return null;
	return { name: match[1].toLowerCase(), args: (match[2] || "").trim() };
}

// Handle text commands (!status, !new, !model, etc.)
// Returns true if the message was handled as a command.
async function handleTextCommand(
	waMsg: WhatsAppMessage,
	sessionKey: string,
	rawMsg?: WAMessage,
): Promise<boolean> {
	if (!ctx || !waMsg.text) return false;

	const cmd = parseCommand(waMsg.text);
	if (!cmd) return false;

	const state = getSessionState(sessionKey);

	logger.info(
		`Command received: !${cmd.name} from ${waMsg.sender || waMsg.from}`,
	);

	switch (cmd.name) {
		case "status": {
			const response =
				`*Session Status*\n\n` +
				`*Session:* ${sessionKey}\n` +
				`*Thinking Level:* ${state.thinkingLevel}\n` +
				`*Model:* ${state.model}\n` +
				`*Messages:* ${state.messageCount}`;
			await sendMessageInternal(waMsg.from, response, rawMsg);
			return true;
		}

		case "new":
		case "reset": {
			sessionStates.delete(sessionKey);
			await sendMessageInternal(
				waMsg.from,
				"*Session Reset*\n\nLocal session state (thinking level, model preference, message count) has been cleared. Note: WOPR core conversation context is not affected.",
				rawMsg,
			);
			return true;
		}

		case "compact": {
			await sendMessageInternal(
				waMsg.from,
				"*Compacting Session*\n\nTriggering context compaction...",
				rawMsg,
			);
			try {
				const result = await ctx.inject(sessionKey, "/compact", {
					silent: true,
				});
				await sendMessageInternal(
					waMsg.from,
					`*Session Compacted*\n\n${result || "Context has been compacted."}`,
					rawMsg,
				);
			} catch {
				await sendMessageInternal(
					waMsg.from,
					"Failed to compact session.",
					rawMsg,
				);
			}
			return true;
		}

		case "think": {
			const validLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
			const level = cmd.args.toLowerCase();
			if (!level || !validLevels.includes(level)) {
				await sendMessageInternal(
					waMsg.from,
					`*Thinking Level*\n\nCurrent: ${state.thinkingLevel}\n\nUsage: !think <level>\nLevels: ${validLevels.join(", ")}`,
					rawMsg,
				);
				return true;
			}
			state.thinkingLevel = level;
			await sendMessageInternal(
				waMsg.from,
				`*Thinking level set to:* ${level}`,
				rawMsg,
			);
			return true;
		}

		case "model": {
			if (!cmd.args) {
				await sendMessageInternal(
					waMsg.from,
					`*Current Model:* ${state.model}\n\nUsage: !model <name>\nExamples: !model opus, !model haiku, !model sonnet`,
					rawMsg,
				);
				return true;
			}
			const modelChoice = cmd.args.toLowerCase();
			// Use ctx.setSessionProvider if available, otherwise just track locally
			const ctxAny = ctx as any;
			if (typeof ctxAny.setSessionProvider === "function") {
				try {
					// Try to resolve model via provider registry (same as Discord plugin)
					const providerIds = [
						"anthropic",
						"openai",
						"kimi",
						"opencode",
						"codex",
					];
					let resolved: { provider: string; id: string; name: string } | null =
						null;
					for (const pid of providerIds) {
						const provider =
							typeof ctxAny.getProvider === "function"
								? ctxAny.getProvider(pid)
								: undefined;
						if (!provider?.supportedModels) continue;
						for (const modelId of provider.supportedModels as string[]) {
							if (modelId === modelChoice || modelId.includes(modelChoice)) {
								resolved = { provider: pid, id: modelId, name: modelId };
								break;
							}
						}
						if (resolved) break;
					}
					if (!resolved) {
						await sendMessageInternal(
							waMsg.from,
							`Unknown model: ${modelChoice}\n\nTry: opus, haiku, sonnet, gpt`,
							rawMsg,
						);
						return true;
					}
					await ctxAny.setSessionProvider(sessionKey, resolved.provider, {
						model: resolved.id,
					});
					state.model = resolved.id;
					await sendMessageInternal(
						waMsg.from,
						`*Model switched to:* ${resolved.id}`,
						rawMsg,
					);
				} catch (e) {
					await sendMessageInternal(
						waMsg.from,
						`Failed to switch model: ${e}`,
						rawMsg,
					);
				}
			} else {
				// Fallback: just store the preference locally
				state.model = modelChoice;
				await sendMessageInternal(
					waMsg.from,
					`*Model preference set to:* ${modelChoice}\n\n(Note: model switching requires WOPR core support)`,
					rawMsg,
				);
			}
			return true;
		}

		case "session": {
			const defaultKey = `whatsapp-${waMsg.from}`;
			if (!cmd.args) {
				await sendMessageInternal(
					waMsg.from,
					`*Current Session:* ${sessionKey}\n\nUsage: !session <name>\nUse !session default to reset to the default session.`,
					rawMsg,
				);
				return true;
			}
			if (cmd.args === "default") {
				sessionOverrides.delete(defaultKey);
				await sendMessageInternal(
					waMsg.from,
					`*Session reset to default:* ${defaultKey}`,
					rawMsg,
				);
			} else {
				const newKey = `${defaultKey}/${cmd.args}`;
				sessionOverrides.set(defaultKey, newKey);
				await sendMessageInternal(
					waMsg.from,
					`*Switched to session:* ${newKey}\n\nNote: Each session maintains separate context. Use !session default to switch back.`,
					rawMsg,
				);
			}
			return true;
		}

		case "cancel": {
			const ctxAny2 = ctx as any;
			let cancelled = false;
			if (typeof ctxAny2.cancelInject === "function") {
				try {
					cancelled = ctxAny2.cancelInject(sessionKey);
				} catch (e) {
					logger.warn(`cancelInject failed: ${e}`);
				}
			}
			if (cancelled) {
				await sendMessageInternal(
					waMsg.from,
					"*Cancelled*\n\nThe current response has been stopped.",
					rawMsg,
				);
			} else {
				await sendMessageInternal(
					waMsg.from,
					"Nothing to cancel. No response is currently in progress.",
					rawMsg,
				);
			}
			return true;
		}

		case "help": {
			const helpText =
				`*${agentIdentity.name || "WOPR"} WhatsApp Commands*\n\n` +
				`*!status* - Show session status\n` +
				`*!new* or *!reset* - Start fresh session\n` +
				`*!compact* - Summarize conversation\n` +
				`*!think <level>* - Set thinking level (off/minimal/low/medium/high/xhigh)\n` +
				`*!model <model>* - Switch AI model (sonnet/opus/haiku)\n` +
				`*!cancel* - Stop the current AI response\n` +
				`*!session <name>* - Switch to named session\n` +
				`*!help* - Show this help\n\n` +
				`Send any other message to chat with ${agentIdentity.name || "WOPR"}!`;
			await sendMessageInternal(waMsg.from, helpText, rawMsg);
			return true;
		}

		default: {
			// Check registered channel commands from other plugins
			const channelCmd = registeredCommands.get(cmd.name);
			if (channelCmd) {
				const commandCtx: ChannelCommandContext = {
					channel: waMsg.from,
					channelType: "whatsapp",
					sender: waMsg.sender || waMsg.from.split("@")[0],
					args: cmd.args ? cmd.args.split(/\s+/) : [],
					reply: async (msg: string) => {
						await sendMessageInternal(waMsg.from, msg);
					},
					getBotUsername: () => whatsappChannelProvider.getBotUsername(),
				};
				await channelCmd.handler(commandCtx);
				return true;
			}
			// Not a recognized command, treat as normal message
			return false;
		}
	}
}

// Start typing indicator with auto-refresh and ref-counting
function startTypingIndicator(jid: string): void {
	const existing = typingRefCounts.get(jid);
	if (existing) {
		existing.count++;
		return;
	}

	if (!socket) return;

	const sock = socket;
	// Send initial composing presence
	sock.sendPresenceUpdate("composing", jid).catch(() => {});

	// Refresh every TYPING_REFRESH_MS since WhatsApp composing status expires
	const interval = setInterval(() => {
		// Guard against stale socket reference
		if (socket !== sock) {
			clearInterval(interval);
			activeTypingIntervals.delete(interval);
			typingRefCounts.delete(jid);
			return;
		}
		sock.sendPresenceUpdate("composing", jid).catch(() => {});
	}, TYPING_REFRESH_MS);
	interval.unref();

	activeTypingIntervals.add(interval);
	typingRefCounts.set(jid, { count: 1, interval });
}

// Stop typing indicator with ref-counting
function stopTypingIndicator(jid: string): void {
	const existing = typingRefCounts.get(jid);
	if (!existing) return;

	existing.count--;
	if (existing.count > 0) return;

	// Last reference — actually stop
	clearInterval(existing.interval);
	activeTypingIntervals.delete(existing.interval);
	typingRefCounts.delete(jid);

	if (socket) {
		socket.sendPresenceUpdate("paused", jid).catch(() => {});
	}
}

// Clear all active typing intervals (for shutdown/logout)
function clearAllTypingIntervals(): void {
	for (const interval of activeTypingIntervals) {
		clearInterval(interval);
	}
	activeTypingIntervals.clear();
	typingRefCounts.clear();
}

// Inject message to WOPR
async function injectMessage(
	waMsg: WhatsAppMessage,
	sessionKey: string,
	reactionSM?: ReactionStateMachine,
	rawMsg?: WAMessage,
): Promise<void> {
	if (!ctx || !socket) return;

	const state = getSessionState(sessionKey);
	const prefix = `[${waMsg.sender || "WhatsApp User"}]: `;
	let messageContent = waMsg.text || "";

	// Prepend thinking level if not default (mirrors Discord plugin behavior)
	if (state.thinkingLevel !== "medium") {
		messageContent = `[Thinking level: ${state.thinkingLevel}] ${messageContent}`;
	}

	// Append media attachment info (matching Discord plugin pattern)
	if (waMsg.mediaPath) {
		const attachmentInfo = `[Attachment: ${waMsg.mediaPath}]`;
		messageContent = messageContent
			? `${messageContent}\n\n${attachmentInfo}`
			: attachmentInfo;
	}

	if (!messageContent) return;

	const messageWithPrefix = prefix + messageContent;

	const channelInfo: ChannelRef = {
		type: "whatsapp",
		id: waMsg.from,
		name: waMsg.groupName || (waMsg.isGroup ? "Group" : "WhatsApp DM"),
	};

	// Pass image paths via PluginInjectOptions.images for vision-capable models
	const images: string[] = [];
	if (waMsg.mediaPath && waMsg.mediaType === "image") {
		images.push(waMsg.mediaPath);
	}

	const jid = toJid(waMsg.from);

	// Create a new stream for this chat (interrupts any existing stream)
	const stream = streamManager.create(jid, socket, logger);

	const injectOptions: PluginInjectOptions = {
		from: waMsg.sender || waMsg.from,
		channel: channelInfo,
		onStream: (msg: StreamMessage) => handleStreamChunk(msg, jid),
		...(images.length > 0 ? { images } : {}),
	};

	// Transition to active — LLM processing starts
	if (reactionSM) {
		await reactionSM.transition("active");
	}

	// Show typing indicator while processing (ref-counted per jid)
	startTypingIndicator(waMsg.from);

	try {
		const response = await ctx.inject(
			sessionKey,
			messageWithPrefix,
			injectOptions,
		);

		// Finalize the stream — returns true if content was streamed progressively
		const didStream = await streamManager.finalize(jid);

		// Only send the full response if streaming did not deliver it
		if (!didStream) {
			await sendResponse(waMsg.from, response, rawMsg);
		}

		// Transition to done — processing complete
		if (reactionSM) {
			await reactionSM.transition("done");
		}
	} catch (err) {
		// Transition to error — processing failed
		if (reactionSM) {
			await reactionSM.transition("error");
		}
		throw err;
	} finally {
		// Clean up stream timer if inject threw before finalize ran
		streamManager.interrupt(jid);
		stopTypingIndicator(waMsg.from);
	}
}

// Handle streaming response chunks
function handleStreamChunk(msg: StreamMessage, jid: string): void {
	const stream = streamManager.get(jid);
	if (!stream) return;

	// Extract text content from various message formats
	let textContent = "";
	if (msg.type === "text" && msg.content) {
		textContent = msg.content;
	} else if (
		(msg as any).type === "assistant" &&
		(msg as any).message?.content
	) {
		const content = (msg as any).message.content;
		if (Array.isArray(content)) {
			textContent = content.map((c: any) => c.text || "").join("");
		} else if (typeof content === "string") {
			textContent = content;
		}
	}

	if (textContent) {
		stream.append(textContent);
	}
}

// Send a text message to WhatsApp, optionally quoting the triggering message (with retry)
async function sendMessageInternal(
	to: string,
	text: string,
	quoted?: WAMessage,
): Promise<void> {
	if (!socket) {
		throw new Error("WhatsApp not connected");
	}

	const jid = toJid(to);
	const retryConfig = config.retry;

	// Chunk if needed (WhatsApp supports up to 4096 chars)
	const chunks = chunkMessage(text, 4000);

	for (let i = 0; i < chunks.length; i++) {
		const content: AnyMessageContent = { text: chunks[i] };
		// Only quote on the first chunk to avoid redundant reply threading
		const opts = i === 0 && quoted ? { quoted } : {};
		await withRetry(
			async () => {
				if (!socket) throw new Error("WhatsApp not connected");
				try {
					await socket.sendMessage(jid, content, opts);
				} catch (err) {
					if (i === 0 && quoted) {
						// Quoted message may have been deleted or expired; retry without quoting
						logger.warn(
							`Failed to send with quote, retrying without: ${String(err)}`,
						);
						await socket.sendMessage(jid, content);
					} else {
						throw err;
					}
				}
			},
			`sendMessage to ${jid}`,
			logger,
			retryConfig,
		);
	}
}

// Send a media file to WhatsApp
async function sendMediaInternal(
	to: string,
	filePath: string,
	caption?: string,
): Promise<void> {
	if (!socket) {
		throw new Error("WhatsApp not connected");
	}

	// Verify file exists and is readable before proceeding (finding 8)
	try {
		await fs.access(filePath);
	} catch {
		throw new Error(`File not found or not readable: ${filePath}`);
	}

	const jid = toJid(to);
	const ext = path.extname(filePath).toLowerCase();
	const stat = await fs.stat(filePath);

	// Enforce outbound file size limit
	if (stat.size > MAX_MEDIA_BYTES) {
		throw new Error(
			`File too large to send (${stat.size} bytes, limit ${MAX_MEDIA_BYTES})`,
		);
	}

	const buffer = await fs.readFile(filePath);

	// Determine media type from extension
	const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
	const audioExts = [".mp3", ".ogg", ".m4a", ".wav", ".aac", ".opus"];
	const videoExts = [".mp4", ".mkv", ".avi", ".mov", ".3gp"];

	let content: AnyMessageContent;

	if (imageExts.includes(ext)) {
		if (stat.size > MEDIA_SIZE_LIMITS.image) {
			logger.warn(`Image too large (${stat.size} bytes), sending as document`);
			content = {
				document: buffer,
				mimetype: "application/octet-stream",
				fileName: path.basename(filePath),
				caption,
			};
		} else {
			content = { image: buffer, caption };
		}
	} else if (audioExts.includes(ext)) {
		if (stat.size > MEDIA_SIZE_LIMITS.audio) {
			logger.warn(`Audio too large (${stat.size} bytes), sending as document`);
			content = {
				document: buffer,
				mimetype: "application/octet-stream",
				fileName: path.basename(filePath),
				caption,
			};
		} else {
			content = {
				audio: buffer,
				mimetype:
					ext === ".ogg" || ext === ".opus"
						? "audio/ogg; codecs=opus"
						: "audio/mpeg",
				ptt: ext === ".ogg" || ext === ".opus",
			};
		}
	} else if (videoExts.includes(ext)) {
		if (stat.size > MEDIA_SIZE_LIMITS.video) {
			logger.warn(`Video too large (${stat.size} bytes), sending as document`);
			content = {
				document: buffer,
				mimetype: "application/octet-stream",
				fileName: path.basename(filePath),
				caption,
			};
		} else {
			content = { video: buffer, caption };
		}
	} else {
		// Default: send as document
		content = {
			document: buffer,
			mimetype: "application/octet-stream",
			fileName: path.basename(filePath),
			caption,
		};
	}

	await withRetry(
		() => {
			if (!socket) throw new Error("WhatsApp not connected");
			return socket.sendMessage(jid, content);
		},
		`sendMedia to ${jid}`,
		logger,
		config.retry,
	);
	logger.info(`Media sent to ${jid}: ${path.basename(filePath)}`);
}

// Pattern to detect file paths in WOPR responses (e.g., "[File: /path/to/file]")
const FILE_PATH_PATTERN = /\[(?:File|Media|Image|Attachment):\s*([^\]]+)\]/gi;

// Send a response that may contain text and/or media file references
async function sendResponse(
	to: string,
	response: string,
	quoted?: WAMessage,
): Promise<void> {
	// Extract any file paths from the response
	const filePaths: string[] = [];
	const textOnly = response
		.replace(FILE_PATH_PATTERN, (_match, filePath: string) => {
			filePaths.push(filePath.trim());
			return "";
		})
		.trim();

	// Send text portion if any
	if (textOnly) {
		await sendMessageInternal(to, textOnly, quoted);
	}

	// Send each media file -- ONLY if it resides inside ATTACHMENTS_DIR (finding 1: prevent file exfiltration)
	for (const fp of filePaths) {
		try {
			if (!(await isInsideDir(fp, ATTACHMENTS_DIR))) {
				logger.warn(`Blocked file send outside attachments directory: ${fp}`);
				continue;
			}
			await sendMediaInternal(to, fp);
		} catch {
			logger.warn(`Referenced file not found or not sendable, skipping: ${fp}`);
		}
	}
}

export function chunkMessage(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) return [text];

	const chunks: string[] = [];
	let current = "";
	const sentences = text.split(/(?<=[.!?])\s+/);

	for (const sentence of sentences) {
		if (current.length + sentence.length + 1 <= maxLength) {
			current += (current ? " " : "") + sentence;
		} else {
			if (current) chunks.push(current);
			current = sentence;
		}
	}

	if (current) chunks.push(current);
	return chunks;
}

// Create and start Baileys socket
async function createSocket(
	accountId: string,
	onQr?: (qr: string) => void,
): Promise<WASocket> {
	let state: AuthenticationState;
	let saveCreds: () => Promise<void>;

	if (storage) {
		// Use Storage API-backed auth state (with migration from filesystem)
		await maybeRunMigration(accountId);
		const result = await useStorageAuthState(storage, accountId);
		state = result.state;
		saveCreds = result.saveCreds;
	} else {
		// Fallback: filesystem-based auth state
		const authDir = getAuthDir(accountId);
		maybeRestoreCredsFromBackup(authDir);
		const result = await useMultiFileAuthState(authDir);
		state = result.state;
		saveCreds = result.saveCreds;
	}

	const { version } = await fetchLatestBaileysVersion();

	// Create silent logger if not verbose
	const baileysLogger = config.verbose
		? require("pino")({ level: "info" })
		: require("pino")({ level: "silent" });

	const sock = makeWASocket({
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
		},
		version,
		logger: baileysLogger,
		printQRInTerminal: false,
		browser: ["WOPR", "CLI", "1.0.0"],
		syncFullHistory: false,
		markOnlineOnConnect: false,
	});

	// Handle credentials update
	let saveQueue = Promise.resolve();
	sock.ev.on("creds.update", () => {
		saveQueue = saveQueue.then(() => saveCreds()).catch(() => {});
	});

	// Handle connection updates
	sock.ev.on("connection.update", (update) => {
		const { connection, lastDisconnect, qr } = update;

		if (qr && onQr) {
			onQr(qr);
		}

		if (connection === "close") {
			const status = getStatusCode(lastDisconnect?.error);
			if (status === DisconnectReason.loggedOut) {
				logger.error(
					"WhatsApp session logged out. Run: wopr channels login whatsapp",
				);
			}
			clearAllTypingIntervals();
			socket = null;
			connectTime = null;
		}

		if (connection === "open") {
			logger.info("WhatsApp Web connected");
			connectTime = Date.now();
		}
	});

	// Handle incoming messages
	sock.ev.on("messages.upsert", (m) => {
		if (m.type === "notify" || m.type === "append") {
			for (const msg of m.messages) {
				handleIncomingMessage(msg);
			}
		}
	});

	// Handle contacts
	sock.ev.on("contacts.upsert", (newContacts) => {
		for (const contact of newContacts) {
			contacts.set(contact.id, contact);
		}
	});

	// Handle groups
	sock.ev.on("groups.upsert", (newGroups) => {
		for (const group of newGroups) {
			groups.set(group.id, group);
		}
	});

	return sock;
}

// Login to WhatsApp
export async function login(): Promise<void> {
	if (socket) {
		throw new Error("Already logged in. Logout first if you want to re-link.");
	}

	const accountId = config.accountId || "default";

	// Ensure filesystem auth dir exists (needed for fallback mode)
	if (!storage) {
		await ensureAuthDir(accountId);
	}

	console.log(`\n📱 WhatsApp Login for account: ${accountId}`);
	console.log(
		"Scan the QR code with WhatsApp (Linked Devices) when it appears...\n",
	);

	return new Promise((resolve, reject) => {
		createSocket(accountId, (qr: string) => {
			qrcode.generate(qr, { small: true });
		})
			.then((sock) => {
				socket = sock;

				// Wait for connection
				sock.ev.on("connection.update", (update) => {
					if (update.connection === "open") {
						console.log(`✅ WhatsApp connected (account: ${accountId})`);
						resolve();
					}
					if (update.connection === "close") {
						const status = getStatusCode(update.lastDisconnect?.error);
						reject(new Error(`Connection closed (status: ${status})`));
					}
				});
			})
			.catch(reject);
	});
}

// Logout from WhatsApp
export async function logout(): Promise<void> {
	const accountId = config.accountId || "default";

	clearAllTypingIntervals();

	if (socket) {
		await socket.logout();
		socket = null;
	}

	// Clear credentials from Storage API
	if (storage) {
		try {
			await storage.delete(WHATSAPP_CREDS_TABLE, accountId);
			// Clean up all signal keys for this account
			const allKeys = await storage.list(WHATSAPP_KEYS_TABLE);
			const prefix = `${accountId}:`;
			for (const entry of allKeys) {
				const key = (entry as { key?: string })?.key;
				if (key?.startsWith(prefix)) {
					await storage.delete(WHATSAPP_KEYS_TABLE, key);
				}
			}
		} catch (err) {
			logger?.warn?.(`Failed to clear storage on logout: ${String(err)}`);
		}
	}

	// Clear legacy filesystem credentials
	const authDir = getAuthDir(accountId);
	try {
		await fs.rm(authDir, { recursive: true, force: true });
	} catch {
		// Ignore errors
	}

	console.log(`✅ Logged out from WhatsApp (account: ${accountId})`);
}

// Start the WhatsApp session (called from init if credentials exist)
async function startSession(): Promise<void> {
	const accountId = config.accountId || "default";
	socket = await createSocket(accountId);
}

// WebMCP tool declarations (read by wopr-plugin-webui for manifest-driven registration)
const webmcpTools = [
	{
		name: "getWhatsappStatus",
		description:
			"Get WhatsApp connection status: connected/disconnected, phone number, and QR pairing state.",
		annotations: { readOnlyHint: true },
	},
	{
		name: "listWhatsappChats",
		description:
			"List active WhatsApp chats including individual and group conversations.",
		annotations: { readOnlyHint: true },
	},
	{
		name: "getWhatsappMessageStats",
		description:
			"Get WhatsApp message processing statistics: messages processed, active conversations, and group count.",
		annotations: { readOnlyHint: true },
	},
];

// Plugin manifest for WaaS integration
const manifest: PluginManifest & { webmcpTools?: typeof webmcpTools } = {
	name: "@wopr-network/plugin-whatsapp",
	version: "1.0.0",
	description: "WhatsApp integration using Baileys (WhatsApp Web)",
	author: "WOPR Network",
	license: "MIT",
	repository: "https://github.com/wopr-network/wopr-plugin-whatsapp",
	capabilities: ["channel"],
	category: "channel",
	icon: "📱",
	tags: ["whatsapp", "messaging", "channel", "baileys"],
	requires: {
		network: {
			outbound: true,
		},
		storage: {
			persistent: true,
			estimatedSize: "50MB",
		},
	},
	configSchema,
	lifecycle: {
		shutdownBehavior: "graceful",
		shutdownTimeoutMs: 10000,
	},
	webmcpTools,
};

// Plugin definition
const plugin: WOPRPlugin = {
	name: "whatsapp",
	version: "1.0.0",
	description: "WhatsApp integration using Baileys (WhatsApp Web)",
	manifest,

	async init(context: WOPRPluginContext): Promise<void> {
		ctx = context;
		config = (context.getConfig() || {}) as WhatsAppConfig;

		// Initialize logger first (before any logging)
		logger = initLogger();

		// Detect Storage API from context
		const ctxWithStorage = context as unknown as PluginContextWithStorage;
		if (ctxWithStorage.storage) {
			storage = ctxWithStorage.storage;
			storage.register(WHATSAPP_CREDS_TABLE, WHATSAPP_CREDS_SCHEMA);
			storage.register(WHATSAPP_KEYS_TABLE, WHATSAPP_KEYS_SCHEMA);
			logger.info("Storage API detected — using for auth state persistence");
		} else {
			storage = null;
			logger.info("Storage API not available — using filesystem fallback");
		}

		// Register config schema
		ctx.registerConfigSchema("whatsapp", configSchema);

		// Refresh identity BEFORE registering providers so getBotUsername()
		// returns the configured agent name from the start.
		await refreshIdentity();

		// Register as a channel provider so other plugins can add commands/parsers
		if (ctx.registerChannelProvider) {
			ctx.registerChannelProvider(whatsappChannelProvider);
			logger.info("Registered WhatsApp channel provider");
		}

		// Register the WhatsApp extension so other plugins can send notifications
		if (ctx.registerExtension) {
			ctx.registerExtension("whatsapp", whatsappExtension);
			logger.info("Registered WhatsApp extension");
		}

		// Create and register WebMCP extension for read-only status/chat/stats tools
		webmcpExtension = createWhatsAppWebMCPExtension({
			getSocket: () => socket,
			getContacts: () => contacts,
			getGroups: () => groups,
			getSessionKeys: () => Array.from(sessionStates.keys()),
			getMessageCount: () => totalMessageCount,
			getAccountId: () => config.accountId || "default",
			hasCredentials: () => {
				// Note: this is a sync check; storage check is async so we
				// only check filesystem here. The full async hasCredentials()
				// checks storage first.
				const accountId = config.accountId || "default";
				const authDir = getAuthDir(accountId);
				const credsPath = path.join(authDir, "creds.json");
				try {
					const fsSync = require("node:fs");
					return fsSync.existsSync(credsPath);
				} catch {
					return false;
				}
			},
			getConnectTime: () => connectTime,
		});
		if (ctx.registerExtension) {
			ctx.registerExtension("whatsapp-webmcp", webmcpExtension);
			logger.info("Registered WhatsApp WebMCP extension");
		}

		const accountId = config.accountId || "default";

		// Ensure auth directory exists (only needed for filesystem fallback)
		if (!storage) {
			await ensureAuthDir(accountId);
		}

		// Start session if credentials exist
		if (await hasCredentials(accountId)) {
			logger.info("Found existing credentials, starting session...");
			await startSession();
		} else {
			logger.info(
				"No credentials found. Run 'wopr channels login whatsapp' to connect.",
			);
		}
	},

	async shutdown(): Promise<void> {
		streamManager.cancelAll();
		clearAllTypingIntervals();
		if (ctx?.unregisterChannelProvider) {
			ctx.unregisterChannelProvider("whatsapp");
		}
		if (ctx?.unregisterExtension) {
			ctx.unregisterExtension("whatsapp");
			ctx.unregisterExtension("whatsapp-webmcp");
		}
		webmcpExtension = null;
		connectTime = null;
		totalMessageCount = 0;
		if (socket) {
			// IMPORTANT: Use end() not logout() — logout() permanently unlinks
			// the device from WhatsApp. We only want to close the connection.
			socket.end(undefined);
			socket = null;
		}
		registeredCommands.clear();
		registeredParsers.clear();
		sessionStates.clear();
		messageCache.clear();
		contacts.clear();
		groups.clear();
		sessionOverrides.clear();
		storage = null;
		ctx = null;
	},
};

export type { ReactionState, SendReactionFn } from "./reactions.js";
export { DEFAULT_REACTION_EMOJIS, ReactionStateMachine } from "./reactions.js";
export type {
	AuthContext as WebMCPAuthContext,
	WebMCPRegistry,
	WebMCPTool,
} from "./webmcp-whatsapp.js";
export { registerWhatsappTools } from "./webmcp-whatsapp.js";
export type {
	ChatInfo,
	WhatsAppMessageStatsInfo,
	WhatsAppStatusInfo,
	WhatsAppWebMCPExtension,
} from "./whatsapp-extension.js";

export default plugin;
