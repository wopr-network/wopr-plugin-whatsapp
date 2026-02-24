/**
 * WhatsApp text commands (!status, !new, !model, etc.)
 */
import type { WAMessage } from "@whiskeysockets/baileys";
import { logger } from "./logger.js";
import { sendMessageInternal } from "./messaging.js";
import type {
	ChannelCommandContext,
	WhatsAppMessage,
	WOPRPluginContext,
} from "./types.js";

// Per-session state (mirrors Discord plugin's SessionState)
export interface SessionState {
	thinkingLevel: string;
	messageCount: number;
	model: string;
}

const sessionStates = new Map<string, SessionState>();
export const sessionOverrides = new Map<string, string>();

export function getSessionState(sessionKey: string): SessionState {
	if (!sessionStates.has(sessionKey)) {
		sessionStates.set(sessionKey, {
			thinkingLevel: "medium",
			messageCount: 0,
			model: "claude-sonnet-4-20250514",
		});
	}
	// biome-ignore lint/style/noNonNullAssertion: guaranteed to exist — set above if missing
	return sessionStates.get(sessionKey)!;
}

export function deleteSessionState(sessionKey: string): void {
	sessionStates.delete(sessionKey);
}

export function clearAllSessionState(): void {
	sessionStates.clear();
	sessionOverrides.clear();
}

export function getSessionKeys(): string[] {
	return Array.from(sessionStates.keys());
}

// Registered channel commands from other plugins
const registeredCommands: Map<
	string,
	{ handler: (ctx: ChannelCommandContext) => Promise<void> }
> = new Map();

export function registerChannelCommand(
	name: string,
	handler: { handler: (ctx: ChannelCommandContext) => Promise<void> },
): void {
	registeredCommands.set(name, handler);
}

export function unregisterChannelCommand(name: string): void {
	registeredCommands.delete(name);
}

export function getRegisteredCommand(
	name: string,
): { handler: (ctx: ChannelCommandContext) => Promise<void> } | undefined {
	return registeredCommands.get(name);
}

export function clearRegisteredCommands(): void {
	registeredCommands.clear();
}

let _getCtx: () => WOPRPluginContext | null = () => null;
let _getAgentName: () => string = () => "WOPR";
let _getBotUsername: () => string = () => "WOPR";

export function initCommands(deps: {
	getCtx: () => WOPRPluginContext | null;
	getAgentName: () => string;
	getBotUsername: () => string;
}): void {
	_getCtx = deps.getCtx;
	_getAgentName = deps.getAgentName;
	_getBotUsername = deps.getBotUsername;
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
export async function handleTextCommand(
	waMsg: WhatsAppMessage,
	sessionKey: string,
	rawMsg?: WAMessage,
): Promise<boolean> {
	const ctx = _getCtx();
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
			const ctxExt = ctx as unknown as Record<string, unknown>;
			if (typeof ctxExt.setSessionProvider === "function") {
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
						type ProviderEntry = { supportedModels?: string[] };
						const provider =
							typeof ctxExt.getProvider === "function"
								? (
										ctxExt.getProvider as (
											id: string,
										) => ProviderEntry | undefined
									)(pid)
								: undefined;
						if (!provider?.supportedModels) continue;
						for (const modelId of provider.supportedModels) {
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
					await (
						ctxExt.setSessionProvider as (
							s: string,
							p: string,
							o: Record<string, string>,
						) => Promise<void>
					)(sessionKey, resolved.provider, {
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
			const ctxExt2 = ctx as unknown as Record<string, unknown>;
			let cancelled = false;
			if (typeof ctxExt2.cancelInject === "function") {
				try {
					cancelled = (ctxExt2.cancelInject as (s: string) => boolean)(
						sessionKey,
					);
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
				`*${_getAgentName() || "WOPR"} WhatsApp Commands*\n\n` +
				`*!status* - Show session status\n` +
				`*!new* or *!reset* - Start fresh session\n` +
				`*!compact* - Summarize conversation\n` +
				`*!think <level>* - Set thinking level (off/minimal/low/medium/high/xhigh)\n` +
				`*!model <model>* - Switch AI model (sonnet/opus/haiku)\n` +
				`*!cancel* - Stop the current AI response\n` +
				`*!session <name>* - Switch to named session\n` +
				`*!help* - Show this help\n\n` +
				`Send any other message to chat with ${_getAgentName() || "WOPR"}!`;
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
					getBotUsername: () => _getBotUsername(),
				};
				await channelCmd.handler(commandCtx);
				return true;
			}
			// Not a recognized command, treat as normal message
			return false;
		}
	}
}
