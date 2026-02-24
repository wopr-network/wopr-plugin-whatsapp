/**
 * WhatsApp Messaging — send text messages with chunking and retry.
 */
import type {
	AnyMessageContent,
	WAMessage,
	WASocket,
} from "@whiskeysockets/baileys";
import { logger } from "./logger.js";
import { type RetryConfig, withRetry } from "./retry.js";

// Convert phone number or JID to JID format
export function toJid(phoneOrJid: string): string {
	if (phoneOrJid.includes("@")) {
		return phoneOrJid;
	}
	const normalized = phoneOrJid.replace(/[^0-9]/g, "");
	return `${normalized}@s.whatsapp.net`;
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

let _getSocket: () => WASocket | null = () => null;
let _getRetryConfig: () => Partial<RetryConfig> | undefined = () => undefined;

export function initMessaging(
	getSocket: () => WASocket | null,
	getRetryConfig: () => Partial<RetryConfig> | undefined,
): void {
	_getSocket = getSocket;
	_getRetryConfig = getRetryConfig;
}

export async function sendMessageInternal(
	to: string,
	text: string,
	quoted?: WAMessage,
): Promise<void> {
	const socket = _getSocket();
	if (!socket) {
		throw new Error("WhatsApp not connected");
	}

	const jid = toJid(to);
	const retryConfig = _getRetryConfig();

	// Chunk if needed (WhatsApp supports up to 4096 chars)
	const chunks = chunkMessage(text, 4000);

	for (let i = 0; i < chunks.length; i++) {
		const content: AnyMessageContent = { text: chunks[i] };
		// Only quote on the first chunk to avoid redundant reply threading
		const opts = i === 0 && quoted ? { quoted } : {};
		await withRetry(
			async () => {
				const sock = _getSocket();
				if (!sock) throw new Error("WhatsApp not connected");
				try {
					await sock.sendMessage(jid, content, opts);
				} catch (err) {
					if (i === 0 && quoted) {
						// Quoted message may have been deleted or expired; retry without quoting
						logger.warn(
							`Failed to send with quote, retrying without: ${String(err)}`,
						);
						await sock.sendMessage(jid, content);
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
