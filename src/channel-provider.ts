/**
 * WhatsApp Channel Provider — cross-plugin command/parser registration.
 */

import {
	registerChannelCommand,
	unregisterChannelCommand,
} from "./commands.js";
import { logger } from "./logger.js";
import { sendMessageInternal } from "./messaging.js";
import type {
	ChannelCommand,
	ChannelMessageContext,
	ChannelMessageParser,
	ChannelProvider,
	WhatsAppMessage,
} from "./types.js";

const registeredParsers: Map<string, ChannelMessageParser> = new Map();

let _getBotUsername: () => string = () => "WOPR";

export function initChannelProvider(getBotUsername: () => string): void {
	_getBotUsername = getBotUsername;
}

export function getRegisteredParsers(): Map<string, ChannelMessageParser> {
	return registeredParsers;
}

export function clearRegisteredParsers(): void {
	registeredParsers.clear();
}

/**
 * WhatsApp Channel Provider - allows other plugins to register commands
 * and message parsers on the WhatsApp channel.
 */
export const whatsappChannelProvider: ChannelProvider = {
	id: "whatsapp",

	registerCommand(cmd: ChannelCommand): void {
		registerChannelCommand(cmd.name, cmd);
		logger.info(`Channel command registered: ${cmd.name}`);
	},

	unregisterCommand(name: string): void {
		unregisterChannelCommand(name);
	},

	getCommands(): ChannelCommand[] {
		// Re-expose via registered commands — iterate from commands module
		return [];
	},

	addMessageParser(parser: ChannelMessageParser): void {
		registeredParsers.set(parser.id, parser);
		logger.info(`Message parser registered: ${parser.id}`);
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
		return _getBotUsername();
	},
};

// Run registered message parsers against an incoming message
export async function runMessageParsers(waMsg: WhatsAppMessage): Promise<void> {
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
					getBotUsername: () => _getBotUsername(),
				};
				await parser.handler(parserCtx);
			}
		} catch (e) {
			logger.error(`Message parser ${parser.id} error: ${e}`);
		}
	}
}
