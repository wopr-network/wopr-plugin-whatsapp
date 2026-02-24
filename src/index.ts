/**
 * WOPR WhatsApp Plugin - Baileys-based WhatsApp Web integration
 *
 * This file is the thin orchestrator. Business logic lives in:
 *   src/logger.ts       — Winston logger singleton
 *   src/messaging.ts    — sendMessageInternal, toJid, chunkMessage
 *   src/typing.ts       — Typing indicator management
 *   src/media.ts        — Media download/send, DM policy, file validation
 *   src/credentials.ts  — Auth dir helpers, migration
 *   src/commands.ts     — !command handlers, session state
 *   src/channel-provider.ts — Channel provider + registered commands/parsers
 *   src/message-handler.ts  — Incoming message processing, inject, streaming
 *   src/connection.ts   — Baileys socket creation, login, logout
 */

import fsSync from "node:fs";
import path from "node:path";
import type { WASocket } from "@whiskeysockets/baileys";
import { z } from "zod";
import {
	initChannelProvider,
	whatsappChannelProvider,
} from "./channel-provider.js";
import {
	clearAllSessionState,
	clearRegisteredCommands,
	initCommands,
	sessionOverrides,
} from "./commands.js";
import {
	clearCleanups,
	getCleanups,
	initConnection,
	login as loginImpl,
	logout as logoutImpl,
	startSession as startSessionImpl,
} from "./connection.js";
import {
	ensureAuthDir,
	getAuthDir,
	hasCredentials,
	initCredentials,
} from "./credentials.js";
import { initMedia } from "./media.js";
import {
	cancelAllStreams,
	contacts,
	groups,
	initMessageHandler,
	messageCache,
} from "./message-handler.js";
import { initMessaging } from "./messaging.js";
import type { PluginContextWithStorage, PluginStorageAPI } from "./storage.js";
import {
	WHATSAPP_CREDS_SCHEMA,
	WHATSAPP_CREDS_TABLE,
	WHATSAPP_KEYS_SCHEMA,
	WHATSAPP_KEYS_TABLE,
} from "./storage.js";
import type {
	AgentIdentity,
	ConfigField,
	ConfigSchema,
	PluginManifest,
	WhatsAppConfig,
	WOPRPlugin,
	WOPRPluginContext,
} from "./types.js";
import { clearAllTypingIntervals, initTyping } from "./typing.js";
import {
	createWhatsAppWebMCPExtension,
	type WhatsAppWebMCPExtension,
} from "./whatsapp-extension.js";

// ============================================================================
// Module-level state (orchestrator-owned)
// ============================================================================

let socket: WASocket | null = null;
let ctx: WOPRPluginContext | null = null;
let config: WhatsAppConfig = {};
let agentIdentity: AgentIdentity = { name: "WOPR", emoji: "👀" };
let storage: PluginStorageAPI | null = null;
let webmcpExtension: WhatsAppWebMCPExtension | null = null;
let connectTime: number | null = null;
let totalMessageCount = 0;

// ============================================================================
// Config schema (used in manifest)
// ============================================================================

const WhatsAppConfigSchema = z.object({
	accountId: z.string().default("default"),
	authDir: z.string().optional(),
	dmPolicy: z
		.enum(["allowlist", "blocklist", "open", "disabled"])
		.default("allowlist"),
	allowFrom: z.array(z.string()).default([]),
	selfChatMode: z.boolean().default(false),
	ownerNumber: z.string().optional(),
	verbose: z.boolean().default(false),
	pairingRequests: z
		.record(
			z.object({
				code: z.string(),
				name: z.string(),
				requestedAt: z.number(),
			}),
		)
		.default({}),
	retry: z
		.object({
			maxRetries: z.number().optional(),
			baseDelay: z.number().optional(),
			maxDelay: z.number().optional(),
			jitter: z.number().optional(),
		})
		.optional(),
});

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

// ============================================================================
// Helper: Refresh identity from workspace
// ============================================================================

async function refreshIdentity(): Promise<void> {
	if (!ctx) return;
	try {
		const identity = await ctx.getAgentIdentity();
		if (identity) {
			agentIdentity = { ...agentIdentity, ...identity };
		}
	} catch {
		// Ignore
	}
}

// ============================================================================
// WhatsApp Extension (for cross-plugin notifications)
// ============================================================================

const whatsappExtension = {
	send: async (to: string, message: string): Promise<void> => {
		if (!socket) throw new Error("WhatsApp socket is not connected");
		const { sendMessageInternal } = await import("./messaging.js");
		await sendMessageInternal(to, message);
	},
	isConnected: (): boolean => socket !== null,
};

// ============================================================================
// WebMCP tool declarations
// ============================================================================

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

// ============================================================================
// Plugin definition
// ============================================================================

const plugin: WOPRPlugin = {
	name: "whatsapp",
	version: "1.0.0",
	description: "WhatsApp integration using Baileys (WhatsApp Web)",
	manifest,

	async init(context: WOPRPluginContext): Promise<void> {
		ctx = context;

		// Validate config with zod
		const rawConfig = context.getConfig() ?? {};
		const parsed = WhatsAppConfigSchema.safeParse(rawConfig);
		if (!parsed.success) {
			ctx = null;
			return;
		}
		config = parsed.data;

		// Detect Storage API from context
		const ctxWithStorage = context as unknown as PluginContextWithStorage;
		if (ctxWithStorage.storage) {
			storage = ctxWithStorage.storage;
			storage.register(WHATSAPP_CREDS_TABLE, WHATSAPP_CREDS_SCHEMA);
			storage.register(WHATSAPP_KEYS_TABLE, WHATSAPP_KEYS_SCHEMA);
		} else {
			storage = null;
		}

		// Initialize all modules with getters/setters
		initMessaging(
			() => socket,
			() => config.retry,
		);

		initTyping(() => socket);

		initMedia(
			() => socket,
			() => config,
			() => config.retry,
		);

		initCredentials(
			() => config,
			() => storage,
		);

		initCommands({
			getCtx: () => ctx,
			getAgentName: () => agentIdentity.name || "WOPR",
			getBotUsername: () => agentIdentity.name || "WOPR",
		});

		initChannelProvider(() => agentIdentity.name || "WOPR");

		initMessageHandler({
			getCtx: () => ctx,
			getSocket: () => socket,
			incrementMessageCount: () => {
				totalMessageCount++;
			},
			getRetryConfig: () => config.retry as Record<string, unknown> | undefined,
		});

		initConnection({
			getConfig: () => config,
			getStorage: () => storage,
			setSocket: (s) => {
				socket = s;
			},
			setConnectTime: (t) => {
				connectTime = t;
			},
		});

		// Register config schema
		ctx.registerConfigSchema("whatsapp", configSchema);

		// Refresh identity BEFORE registering providers
		await refreshIdentity();

		// Register as a channel provider so other plugins can add commands/parsers
		if (ctx.registerChannelProvider) {
			ctx.registerChannelProvider(whatsappChannelProvider);
		}

		// Register the WhatsApp extension so other plugins can send notifications
		if (ctx.registerExtension) {
			ctx.registerExtension("whatsapp", whatsappExtension);
		}

		// Create and register WebMCP extension
		webmcpExtension = createWhatsAppWebMCPExtension({
			getSocket: () => socket,
			getContacts: () => contacts,
			getGroups: () => groups,
			getSessionKeys: () => {
				const { getSessionKeys } =
					require("./commands.js") as typeof import("./commands.js");
				return getSessionKeys();
			},
			getMessageCount: () => totalMessageCount,
			getAccountId: () => config.accountId || "default",
			hasCredentials: () => {
				// Sync check for WebMCP (filesystem only)
				const accountId = config.accountId || "default";
				const authDir = getAuthDir(accountId);
				const credsPath = path.join(authDir, "creds.json");
				try {
					return fsSync.existsSync(credsPath);
				} catch {
					return false;
				}
			},
			getConnectTime: () => connectTime,
		});
		if (ctx.registerExtension) {
			ctx.registerExtension("whatsapp-webmcp", webmcpExtension);
		}

		const accountId = config.accountId || "default";

		// Ensure auth directory exists (only needed for filesystem fallback)
		if (!storage) {
			await ensureAuthDir(accountId);
		}

		// Start session if credentials exist
		if (await hasCredentials(accountId)) {
			await startSessionImpl((s) => {
				socket = s;
			});
		}
	},

	async shutdown(): Promise<void> {
		cancelAllStreams();
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
		// Run registered socket cleanup functions (removeAllListeners per event)
		for (const fn of getCleanups()) {
			try {
				await fn();
			} catch {}
		}
		clearCleanups();
		clearRegisteredCommands();
		const { clearRegisteredParsers } = await import("./channel-provider.js");
		clearRegisteredParsers();
		clearAllSessionState();
		messageCache.clear();
		contacts.clear();
		groups.clear();
		sessionOverrides.clear();
		storage = null;
		ctx = null;
	},
};

// ============================================================================
// Exported functions (used by WOPR CLI)
// ============================================================================

export async function login(): Promise<void> {
	await loginImpl(socket, (s) => {
		socket = s;
	});
}

export async function logout(): Promise<void> {
	await logoutImpl(socket, (s) => {
		socket = s;
	});
}

// ============================================================================
// Re-exports for backward compatibility with tests
// ============================================================================

export { getSessionState, parseCommand } from "./commands.js";
export {
	extractText,
	isAllowed,
	mediaCategory,
	sanitizeFilename,
} from "./media.js";
export { chunkMessage, toJid } from "./messaging.js";

// Re-export already-exported types
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
