/**
 * WhatsApp message handling — incoming messages, inject, streaming.
 */
import type {
	Contact,
	GroupMetadata,
	WAMessage,
	WASocket,
} from "@whiskeysockets/baileys";
import {
	getSessionKeys as getCommandSessionKeys,
	getSessionState,
	handleTextCommand,
	sessionOverrides,
} from "./commands.js";
import { logger } from "./logger.js";
import {
	downloadWhatsAppMedia,
	extractText,
	getMediaType,
	isAllowed,
	mediaCategory,
	sendResponse,
} from "./media.js";
import { sendMessageInternal, toJid } from "./messaging.js";
import { ReactionStateMachine } from "./reactions.js";
import { withRetry } from "./retry.js";
import { StreamManager } from "./streaming.js";
import type {
	ChannelRef,
	PluginInjectOptions,
	StreamMessage,
	WhatsAppMessage,
	WOPRPluginContext,
} from "./types.js";
import { startTypingIndicator, stopTypingIndicator } from "./typing.js";

export const contacts: Map<string, Contact> = new Map();
export const groups: Map<string, GroupMetadata> = new Map();
export const messageCache: Map<string, WhatsAppMessage> = new Map();

// Stream manager for active streaming sessions
const streamManager = new StreamManager();

let _getCtx: () => WOPRPluginContext | null = () => null;
let _getSocket: () => WASocket | null = () => null;
let _incrementMessageCount: () => void = () => {};
let _getRetryConfig: () => Record<string, unknown> | undefined = () =>
	undefined;

export function initMessageHandler(deps: {
	getCtx: () => WOPRPluginContext | null;
	getSocket: () => WASocket | null;
	incrementMessageCount: () => void;
	getRetryConfig: () => Record<string, unknown> | undefined;
}): void {
	_getCtx = deps.getCtx;
	_getSocket = deps.getSocket;
	_incrementMessageCount = deps.incrementMessageCount;
	_getRetryConfig = deps.getRetryConfig;
}

export function getContactsMap(): Map<string, Contact> {
	return contacts;
}

export function getGroupsMap(): Map<string, GroupMetadata> {
	return groups;
}

export function getSessionKeys(): string[] {
	return getCommandSessionKeys();
}

// Run registered message parsers against an incoming message
async function runMessageParsers(
	waMsg: WhatsAppMessage,
	registeredParsers: Map<
		string,
		{
			id: string;
			pattern: RegExp | ((text: string) => boolean);
			handler: (ctx: unknown) => Promise<void>;
		}
	>,
): Promise<void> {
	if (!waMsg.text) return;

	for (const parser of registeredParsers.values()) {
		try {
			const matches =
				typeof parser.pattern === "function"
					? parser.pattern(waMsg.text)
					: parser.pattern.test(waMsg.text);

			if (matches) {
				const parserCtx = {
					channel: waMsg.from,
					channelType: "whatsapp",
					sender: waMsg.sender || waMsg.from.split("@")[0],
					content: waMsg.text,
					reply: async (msg: string) => {
						await sendMessageInternal(waMsg.from, msg);
					},
					getBotUsername: () => "WOPR",
				};
				await parser.handler(parserCtx);
			}
		} catch (e) {
			logger.error(`Message parser ${parser.id} error: ${e}`);
		}
	}
}

// Send reaction internally (with retry)
export async function sendReactionInternal(
	chatJid: string,
	messageId: string,
	emoji: string,
): Promise<void> {
	const socket = _getSocket();
	if (!socket) return;

	await withRetry(
		() => {
			const sock = _getSocket();
			if (!sock) throw new Error("WhatsApp not connected");
			return sock.sendMessage(chatJid, {
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
		_getRetryConfig(),
	);
}

// Handle streaming response chunks
export function handleStreamChunk(msg: StreamMessage, jid: string): void {
	const stream = streamManager.get(jid);
	if (!stream) return;

	// Extract text content from various message formats
	let textContent = "";
	if (msg.type === "text" && msg.content) {
		textContent = msg.content;
	} else {
		// Handle undocumented "assistant" message shape from some WOPR core versions
		type AssistantMsg = { type: string; message?: { content?: unknown } };
		const assistantMsg = msg as unknown as AssistantMsg;
		if (assistantMsg.type === "assistant" && assistantMsg.message?.content) {
			const content = assistantMsg.message.content;
			if (Array.isArray(content)) {
				textContent = content
					.map((c: unknown) => (c as { text?: string }).text || "")
					.join("");
			} else if (typeof content === "string") {
				textContent = content;
			}
		}
	}

	if (textContent) {
		stream.append(textContent);
	}
}

// Inject message to WOPR
export async function injectMessage(
	waMsg: WhatsAppMessage,
	sessionKey: string,
	reactionSM?: ReactionStateMachine,
	rawMsg?: WAMessage,
): Promise<void> {
	const ctx = _getCtx();
	const socket = _getSocket();
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
	const _stream = streamManager.create(jid, socket, logger);

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

// Process incoming message
export async function handleIncomingMessage(
	msg: WAMessage,
	registeredParsers: Map<
		string,
		{
			id: string;
			pattern: RegExp | ((text: string) => boolean);
			handler: (ctx: unknown) => Promise<void>;
		}
	>,
): Promise<void> {
	const ctx = _getCtx();
	const socket = _getSocket();
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
	_incrementMessageCount();

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
				await runMessageParsers(waMessage, registeredParsers);

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
			const { default: fs } = await import("node:fs/promises");
			fs.unlink(mediaPath).catch((err) => {
				logger.warn(
					`Failed to clean up temp media ${mediaPath}: ${String(err)}`,
				);
			});
		}
	}
}

export function cancelAllStreams(): void {
	streamManager.cancelAll();
}
