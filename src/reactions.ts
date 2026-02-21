/**
 * Reaction State Machine for WhatsApp message processing lifecycle.
 *
 * Mirrors the Discord plugin's 5-state reaction system:
 *   queued (⏳) → active (🔄) → done (✅) / error (❌) / timeout (⏰)
 *
 * Each message gets a ReactionStateMachine instance that tracks its current
 * state and sends reaction updates via the WhatsApp Baileys API. Transitions
 * are atomic — the old reaction is replaced by sending a new react message
 * (WhatsApp only shows one reaction per sender, so sending a new one
 * automatically replaces the old one).
 */

import type { PluginLogger } from "@wopr-network/plugin-types";

/** Valid states in the reaction lifecycle. */
export type ReactionState = "queued" | "active" | "done" | "error" | "timeout";

/** Maps each state to its default emoji. */
export const DEFAULT_REACTION_EMOJIS: Record<ReactionState, string> = {
	queued: "⏳",
	active: "🔄",
	done: "✅",
	error: "❌",
	timeout: "⏰",
};

/** Valid state transitions. */
const VALID_TRANSITIONS: Record<ReactionState, ReactionState[]> = {
	queued: ["active", "done", "error", "timeout"],
	active: ["done", "error", "timeout"],
	done: [],
	error: [],
	timeout: [],
};

/** Function signature for sending a reaction via Baileys. */
export type SendReactionFn = (
	chatJid: string,
	messageId: string,
	emoji: string,
) => Promise<void>;

/**
 * Manages the reaction state for a single WhatsApp message.
 *
 * Usage:
 *   const sm = new ReactionStateMachine(chatJid, messageId, sendReaction, logger);
 *   await sm.transition("queued");  // ⏳
 *   await sm.transition("active");  // 🔄
 *   await sm.transition("done");    // ✅
 */
export class ReactionStateMachine {
	private _state: ReactionState | null = null;
	private readonly chatJid: string;
	private readonly messageId: string;
	private readonly sendReaction: SendReactionFn;
	private readonly logger: PluginLogger;
	private readonly emojis: Record<ReactionState, string>;

	constructor(
		chatJid: string,
		messageId: string,
		sendReaction: SendReactionFn,
		logger: PluginLogger,
		emojis: Record<ReactionState, string> = DEFAULT_REACTION_EMOJIS,
	) {
		this.chatJid = chatJid;
		this.messageId = messageId;
		this.sendReaction = sendReaction;
		this.logger = logger;
		this.emojis = emojis;
	}

	/** Current state, or null if no transition has occurred yet. */
	get state(): ReactionState | null {
		return this._state;
	}

	/** Whether the state machine has reached a terminal state. */
	get isTerminal(): boolean {
		return (
			this._state === "done" ||
			this._state === "error" ||
			this._state === "timeout"
		);
	}

	/**
	 * Transition to a new state and send the corresponding reaction.
	 *
	 * Validates the transition is legal. If the state machine is already in
	 * a terminal state, the transition is silently ignored (no stale reactions).
	 *
	 * @returns true if the transition occurred, false if it was skipped.
	 */
	async transition(newState: ReactionState): Promise<boolean> {
		// First transition (null -> any state)
		if (this._state === null) {
			if (newState !== "queued") {
				this.logger.warn(
					`[reactions] First transition must be to 'queued', got '${newState}' for message ${this.messageId}`,
				);
				return false;
			}
		} else {
			// Already terminal — silently skip
			if (this.isTerminal) {
				this.logger.debug(
					`[reactions] Ignoring transition to '${newState}' — already in terminal state '${this._state}' for message ${this.messageId}`,
				);
				return false;
			}

			// Validate transition
			const allowed = VALID_TRANSITIONS[this._state];
			if (!allowed.includes(newState)) {
				this.logger.warn(
					`[reactions] Invalid transition '${this._state}' -> '${newState}' for message ${this.messageId}`,
				);
				return false;
			}
		}

		const emoji = this.emojis[newState];
		const previousState = this._state;
		this._state = newState;

		try {
			await this.sendReaction(this.chatJid, this.messageId, emoji);
			this.logger.debug(
				`[reactions] ${previousState || "init"} -> ${newState} (${emoji}) for message ${this.messageId}`,
			);
		} catch (err) {
			// Reaction send failure should not break the processing pipeline.
			// State is still updated so subsequent transitions remain valid.
			this.logger.warn(
				`[reactions] Failed to send ${newState} reaction for message ${this.messageId}: ${String(err)}`,
			);
		}

		return true;
	}

	/**
	 * Remove the reaction entirely (send empty reaction text).
	 * WhatsApp interprets an empty reaction text as removing the reaction.
	 */
	async clear(): Promise<void> {
		try {
			await this.sendReaction(this.chatJid, this.messageId, "");
		} catch (err) {
			this.logger.warn(
				`[reactions] Failed to clear reaction for message ${this.messageId}: ${String(err)}`,
			);
		}
	}
}
