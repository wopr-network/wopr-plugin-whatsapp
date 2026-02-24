/**
 * WhatsApp media handling — download, send, file validation, DM policy.
 */
import fs, { realpath } from "node:fs/promises";
import path from "node:path";
import {
	type AnyMessageContent,
	downloadMediaMessage,
	extensionForMediaMessage,
	getContentType,
	type WAMessage,
	type WASocket,
} from "@whiskeysockets/baileys";
import { logger } from "./logger.js";
import { sendMessageInternal, toJid } from "./messaging.js";
import { type RetryConfig, withRetry } from "./retry.js";
import type { WhatsAppConfig } from "./types.js";

// Media types that WhatsApp supports for incoming messages
export const MEDIA_MESSAGE_TYPES = [
	"imageMessage",
	"documentMessage",
	"audioMessage",
	"videoMessage",
	"stickerMessage",
] as const;

// WhatsApp media size limits (bytes)
export const MEDIA_SIZE_LIMITS: Record<string, number> = {
	image: 16 * 1024 * 1024, // 16 MB
	video: 64 * 1024 * 1024, // 64 MB
	audio: 16 * 1024 * 1024, // 16 MB
	document: 100 * 1024 * 1024, // 100 MB
	sticker: 500 * 1024, // 500 KB
};

// Attachments directory for downloaded media
const WOPR_HOME =
	process.env.WOPR_HOME || path.join(process.env.HOME || "~", ".wopr");
export const ATTACHMENTS_DIR = path.join(WOPR_HOME, "attachments", "whatsapp");

// Maximum download size (default 100 MB, configurable via env)
const MAX_MEDIA_BYTES =
	Number(process.env.WOPR_WA_MAX_MEDIA_BYTES) || 100 * 1024 * 1024;

// Pattern to detect file paths in WOPR responses (e.g., "[File: /path/to/file]")
export const FILE_PATH_PATTERN =
	/\[(?:File|Media|Image|Attachment):\s*([^\]]+)\]/gi;

let _getSocket: () => WASocket | null = () => null;
let _getConfig: () => WhatsAppConfig = () => ({}) as WhatsAppConfig;
let _getRetryConfig: () => Partial<RetryConfig> | undefined = () => undefined;

export function initMedia(
	getSocket: () => WASocket | null,
	getConfig: () => WhatsAppConfig,
	getRetryConfig: () => Partial<RetryConfig> | undefined,
): void {
	_getSocket = getSocket;
	_getConfig = getConfig;
	_getRetryConfig = getRetryConfig;
}

/** Return true if `filePath` resolves inside `allowedDir` (realpath check). */
export async function isInsideDir(
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

// Check if sender is allowed based on DM policy
export function isAllowed(from: string, isGroup: boolean): boolean {
	if (isGroup) return true; // Groups are always allowed

	const config = _getConfig();
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
export async function ensureAttachmentsDir(): Promise<void> {
	try {
		await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });
	} catch {
		// Directory already exists
	}
}

// Detect if a message contains media and return the media type key
export function getMediaType(
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
export function getMediaFileLength(msg: WAMessage): number | null {
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
export async function downloadWhatsAppMedia(
	msg: WAMessage,
): Promise<string | null> {
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
			// biome-ignore lint/style/noNonNullAssertion: msg.message checked non-null at function entry via getMediaType
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

// Send a media file to WhatsApp
export async function sendMediaInternal(
	to: string,
	filePath: string,
	caption?: string,
): Promise<void> {
	const socket = _getSocket();
	if (!socket) {
		throw new Error("WhatsApp not connected");
	}

	// Verify file exists and is readable before proceeding
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
			const sock = _getSocket();
			if (!sock) throw new Error("WhatsApp not connected");
			return sock.sendMessage(jid, content);
		},
		`sendMedia to ${jid}`,
		logger,
		_getRetryConfig(),
	);
	logger.info(`Media sent to ${jid}: ${path.basename(filePath)}`);
}

// Send a response that may contain text and/or media file references
export async function sendResponse(
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

	// Send each media file -- ONLY if it resides inside ATTACHMENTS_DIR (prevent file exfiltration)
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
