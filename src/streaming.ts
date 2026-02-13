/**
 * WhatsApp message streaming with edit-in-place support.
 *
 * Buffers streaming tokens and flushes them to WhatsApp using message editing
 * (Baileys' `edit` field in AnyMessageContent). When content exceeds WhatsApp's
 * character limit, overflows into a new message.
 *
 * Mirrors the Discord plugin's DiscordMessageStream pattern.
 */

import type { proto, WASocket } from "@whiskeysockets/baileys";
import type winston from "winston";

/** WhatsApp message character limit */
export const WHATSAPP_LIMIT = 4096;

/** Minimum interval between message edits in ms */
export const EDIT_INTERVAL_MS = 1000;

/** Types for the send function signature */
type WAMessageKey = proto.IMessageKey;

/**
 * Manages streaming delivery of a single WhatsApp message.
 *
 * Accumulates text, sends/edits via the Baileys socket, and handles
 * overflow when the content exceeds WhatsApp's character limit.
 */
export class WhatsAppMessageStream {
	private readonly jid: string;
	private readonly socket: WASocket;
	private readonly logger: winston.Logger;

	private content = "";
	private messageKey: WAMessageKey | null = null;
	private flushTimer: NodeJS.Timeout | null = null;
	private pendingContent: string[] = [];
	private processing = false;
	private finalized = false;
	private cancelled = false;
	private lastFlushLength = 0;

	/** Completed (overflowed) message keys for reference */
	private completedKeys: WAMessageKey[] = [];

	/** Whether any content was actually streamed to WhatsApp */
	private _didStream = false;

	constructor(jid: string, socket: WASocket, logger: winston.Logger) {
		this.jid = jid;
		this.socket = socket;
		this.logger = logger;

		// Start periodic flush at EDIT_INTERVAL_MS
		this.flushTimer = setInterval(
			() => this.processPending(),
			EDIT_INTERVAL_MS,
		);
	}

	/** True if at least one message was sent/edited during streaming */
	get didStream(): boolean {
		return this._didStream;
	}

	get isFinalized(): boolean {
		return this.finalized;
	}

	get isCancelled(): boolean {
		return this.cancelled;
	}

	/**
	 * Append streaming text content. Buffered and flushed periodically.
	 */
	append(text: string): void {
		if (this.finalized || this.cancelled) return;
		this.pendingContent.push(text);
	}

	/**
	 * Cancel the stream. Stops further edits but does not delete sent messages.
	 */
	cancel(): void {
		if (this.finalized) return;
		this.cancelled = true;
		this.cleanup();
	}

	/**
	 * Finalize the stream. Flushes any remaining content and stops the timer.
	 */
	async finalize(): Promise<void> {
		if (this.finalized) return;
		this.finalized = true;

		// Stop the periodic timer
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}

		// Process any remaining pending content
		if (this.pendingContent.length > 0 && !this.cancelled) {
			await this.processPending();
		}

		// Do a final flush to ensure all content is sent
		if (
			this.content.length > 0 &&
			this.content.length !== this.lastFlushLength &&
			!this.cancelled
		) {
			await this.flush();
		}
	}

	/**
	 * Process buffered pending content and flush to WhatsApp.
	 */
	private async processPending(): Promise<void> {
		if (this.processing || this.cancelled || this.pendingContent.length === 0) {
			return;
		}
		this.processing = true;

		try {
			// Drain all pending chunks into one batch
			const batch = this.pendingContent
				.splice(0, this.pendingContent.length)
				.join("");
			if (!batch) return;

			this.content += batch;

			// Handle overflow: if content exceeds limit, split and start new message
			if (this.content.length > WHATSAPP_LIMIT) {
				await this.handleOverflow();
			} else {
				await this.flush();
			}
		} catch (error) {
			this.logger.error(
				`Stream processing error for ${this.jid}: ${String(error)}`,
			);
		} finally {
			this.processing = false;
		}
	}

	/**
	 * Flush current content to WhatsApp (send new or edit existing message).
	 */
	private async flush(): Promise<void> {
		const text = this.content.trim();
		if (!text || this.cancelled) return;

		// Skip if nothing changed since last flush
		if (text.length === this.lastFlushLength) return;

		try {
			if (!this.messageKey) {
				// First send - create a new message
				const result = await this.socket.sendMessage(this.jid, { text });
				if (result?.key) {
					this.messageKey = result.key;
					this._didStream = true;
				}
			} else {
				// Edit existing message with updated content
				await this.socket.sendMessage(this.jid, {
					text,
					edit: this.messageKey,
				});
			}
			this.lastFlushLength = text.length;
		} catch (error) {
			this.logger.error(`Stream flush error for ${this.jid}: ${String(error)}`);
		}
	}

	/**
	 * Handle content overflow. Finalizes the current message at a word boundary,
	 * starts a new message with the overflow.
	 */
	private async handleOverflow(): Promise<void> {
		// Find a good split point (word boundary before the limit)
		const splitPoint = findSplitPoint(this.content, WHATSAPP_LIMIT);
		const current = this.content.slice(0, splitPoint).trim();
		const overflow = this.content.slice(splitPoint).trim();

		// Finalize the current message with the truncated content
		if (current) {
			this.content = current;
			await this.flush();
		}

		// Save the current message key and start fresh
		if (this.messageKey) {
			this.completedKeys.push(this.messageKey);
			this.messageKey = null;
		}
		this.content = overflow;
		this.lastFlushLength = 0;

		// If overflow itself exceeds limit, flush recursively
		if (this.content.length > WHATSAPP_LIMIT) {
			await this.handleOverflow();
		} else if (this.content) {
			await this.flush();
		}
	}

	private cleanup(): void {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
	}
}

/**
 * Find a good split point at a word or sentence boundary before maxLen.
 * Falls back to maxLen if no boundary is found.
 */
export function findSplitPoint(text: string, maxLen: number): number {
	if (text.length <= maxLen) return text.length;

	// Try to split at a sentence boundary (.!?) followed by whitespace
	const sentenceMatch = text.slice(0, maxLen).match(/.*[.!?]\s/s);
	if (sentenceMatch && sentenceMatch[0].length > maxLen * 0.5) {
		return sentenceMatch[0].length;
	}

	// Try to split at a newline
	const lastNewline = text.lastIndexOf("\n", maxLen);
	if (lastNewline > maxLen * 0.5) {
		return lastNewline + 1;
	}

	// Try to split at a word boundary (space)
	const lastSpace = text.lastIndexOf(" ", maxLen);
	if (lastSpace > maxLen * 0.5) {
		return lastSpace + 1;
	}

	// Hard split at limit
	return maxLen;
}

/**
 * Manages active streams across chat JIDs.
 * Provides stream interruption (cancel existing stream when user sends a new message).
 */
export class StreamManager {
	private readonly streams = new Map<string, WhatsAppMessageStream>();

	/**
	 * Get or create a stream for a chat JID.
	 * If a stream already exists, it is cancelled first (interruption).
	 */
	create(
		jid: string,
		socket: WASocket,
		logger: winston.Logger,
	): WhatsAppMessageStream {
		const existing = this.streams.get(jid);
		if (existing && !existing.isFinalized) {
			logger.info(`Interrupting existing stream for ${jid}`);
			existing.cancel();
		}

		const stream = new WhatsAppMessageStream(jid, socket, logger);
		this.streams.set(jid, stream);
		return stream;
	}

	/**
	 * Get the active stream for a JID, if any.
	 */
	get(jid: string): WhatsAppMessageStream | undefined {
		const stream = this.streams.get(jid);
		if (stream && (stream.isFinalized || stream.isCancelled)) {
			this.streams.delete(jid);
			return undefined;
		}
		return stream;
	}

	/**
	 * Cancel and remove the stream for a JID (used on interruption).
	 */
	interrupt(jid: string): boolean {
		const stream = this.streams.get(jid);
		if (stream && !stream.isFinalized) {
			stream.cancel();
			this.streams.delete(jid);
			return true;
		}
		return false;
	}

	/**
	 * Finalize and remove the stream for a JID.
	 */
	async finalize(jid: string): Promise<boolean> {
		const stream = this.streams.get(jid);
		if (stream) {
			await stream.finalize();
			this.streams.delete(jid);
			return stream.didStream;
		}
		return false;
	}

	/**
	 * Cancel all active streams (for shutdown).
	 */
	cancelAll(): void {
		for (const stream of this.streams.values()) {
			if (!stream.isFinalized) {
				stream.cancel();
			}
		}
		this.streams.clear();
	}
}
