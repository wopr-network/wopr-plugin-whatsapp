import { describe, it, expect, vi } from "vitest";
import {
	ReactionStateMachine,
	DEFAULT_REACTION_EMOJIS,
	type ReactionState,
	type SendReactionFn,
} from "../src/reactions.js";

// Mock logger matching the pattern from other test files
function createMockLogger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as any;
}

function createMockSendReaction(): SendReactionFn & ReturnType<typeof vi.fn> {
	return vi.fn(async () => {});
}

// ─── DEFAULT_REACTION_EMOJIS ────────────────────────────────────────

describe("DEFAULT_REACTION_EMOJIS", () => {
	it("defines emojis for all five states", () => {
		expect(DEFAULT_REACTION_EMOJIS.queued).toBe("⏳");
		expect(DEFAULT_REACTION_EMOJIS.active).toBe("🔄");
		expect(DEFAULT_REACTION_EMOJIS.done).toBe("✅");
		expect(DEFAULT_REACTION_EMOJIS.error).toBe("❌");
		expect(DEFAULT_REACTION_EMOJIS.timeout).toBe("⏰");
	});
});

// ─── ReactionStateMachine ───────────────────────────────────────────

describe("ReactionStateMachine", () => {
	const chatJid = "1234567890@s.whatsapp.net";
	const messageId = "msg-001";

	it("starts with null state", () => {
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			createMockSendReaction(),
			createMockLogger(),
		);
		expect(sm.state).toBeNull();
		expect(sm.isTerminal).toBe(false);
	});

	it("transitions from null to queued", async () => {
		const sendReaction = createMockSendReaction();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			createMockLogger(),
		);

		const result = await sm.transition("queued");
		expect(result).toBe(true);
		expect(sm.state).toBe("queued");
		expect(sendReaction).toHaveBeenCalledWith(chatJid, messageId, "⏳");
	});

	it("rejects first transition to non-queued state", async () => {
		const sendReaction = createMockSendReaction();
		const logger = createMockLogger();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			logger,
		);

		const result = await sm.transition("active");
		expect(result).toBe(false);
		expect(sm.state).toBeNull();
		expect(sendReaction).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalled();
	});

	it("transitions queued -> active -> done", async () => {
		const sendReaction = createMockSendReaction();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			createMockLogger(),
		);

		await sm.transition("queued");
		await sm.transition("active");
		const result = await sm.transition("done");

		expect(result).toBe(true);
		expect(sm.state).toBe("done");
		expect(sm.isTerminal).toBe(true);

		expect(sendReaction).toHaveBeenCalledTimes(3);
		expect(sendReaction).toHaveBeenNthCalledWith(1, chatJid, messageId, "⏳");
		expect(sendReaction).toHaveBeenNthCalledWith(2, chatJid, messageId, "🔄");
		expect(sendReaction).toHaveBeenNthCalledWith(3, chatJid, messageId, "✅");
	});

	it("transitions queued -> active -> error", async () => {
		const sendReaction = createMockSendReaction();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			createMockLogger(),
		);

		await sm.transition("queued");
		await sm.transition("active");
		const result = await sm.transition("error");

		expect(result).toBe(true);
		expect(sm.state).toBe("error");
		expect(sm.isTerminal).toBe(true);
		expect(sendReaction).toHaveBeenNthCalledWith(3, chatJid, messageId, "❌");
	});

	it("transitions queued -> active -> timeout", async () => {
		const sendReaction = createMockSendReaction();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			createMockLogger(),
		);

		await sm.transition("queued");
		await sm.transition("active");
		const result = await sm.transition("timeout");

		expect(result).toBe(true);
		expect(sm.state).toBe("timeout");
		expect(sm.isTerminal).toBe(true);
		expect(sendReaction).toHaveBeenNthCalledWith(3, chatJid, messageId, "⏰");
	});

	it("allows direct transition from queued to done (skip active)", async () => {
		const sendReaction = createMockSendReaction();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			createMockLogger(),
		);

		await sm.transition("queued");
		const result = await sm.transition("done");

		expect(result).toBe(true);
		expect(sm.state).toBe("done");
	});

	it("allows direct transition from queued to error", async () => {
		const sendReaction = createMockSendReaction();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			createMockLogger(),
		);

		await sm.transition("queued");
		const result = await sm.transition("error");

		expect(result).toBe(true);
		expect(sm.state).toBe("error");
	});

	it("allows direct transition from queued to timeout", async () => {
		const sendReaction = createMockSendReaction();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			createMockLogger(),
		);

		await sm.transition("queued");
		const result = await sm.transition("timeout");

		expect(result).toBe(true);
		expect(sm.state).toBe("timeout");
	});

	// ─── Terminal state behavior ──────────────────────────────

	it("silently ignores transitions from terminal done state", async () => {
		const sendReaction = createMockSendReaction();
		const logger = createMockLogger();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			logger,
		);

		await sm.transition("queued");
		await sm.transition("active");
		await sm.transition("done");
		sendReaction.mockClear();

		const result = await sm.transition("error");
		expect(result).toBe(false);
		expect(sm.state).toBe("done");
		expect(sendReaction).not.toHaveBeenCalled();
	});

	it("silently ignores transitions from terminal error state", async () => {
		const sendReaction = createMockSendReaction();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			createMockLogger(),
		);

		await sm.transition("queued");
		await sm.transition("active");
		await sm.transition("error");
		sendReaction.mockClear();

		const result = await sm.transition("done");
		expect(result).toBe(false);
		expect(sm.state).toBe("error");
		expect(sendReaction).not.toHaveBeenCalled();
	});

	it("silently ignores transitions from terminal timeout state", async () => {
		const sendReaction = createMockSendReaction();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			createMockLogger(),
		);

		await sm.transition("queued");
		await sm.transition("timeout");
		sendReaction.mockClear();

		const result = await sm.transition("active");
		expect(result).toBe(false);
		expect(sm.state).toBe("timeout");
	});

	// ─── Invalid transitions ─────────────────────────────────

	it("rejects invalid transition active -> queued", async () => {
		const sendReaction = createMockSendReaction();
		const logger = createMockLogger();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			logger,
		);

		await sm.transition("queued");
		await sm.transition("active");
		sendReaction.mockClear();

		const result = await sm.transition("queued");
		expect(result).toBe(false);
		expect(sm.state).toBe("active");
		expect(sendReaction).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("Invalid transition"),
		);
	});

	// ─── Error resilience ────────────────────────────────────

	it("updates state even if sendReaction fails", async () => {
		const sendReaction = vi.fn(async () => {
			throw new Error("network error");
		}) as any;
		const logger = createMockLogger();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			logger,
		);

		const result = await sm.transition("queued");
		expect(result).toBe(true);
		expect(sm.state).toBe("queued");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("Failed to send"),
		);
	});

	it("allows further transitions after sendReaction failure", async () => {
		let callCount = 0;
		const sendReaction = vi.fn(async () => {
			callCount++;
			if (callCount === 1) throw new Error("network error");
		}) as any;
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			createMockLogger(),
		);

		await sm.transition("queued"); // Fails to send, but state updates
		const result = await sm.transition("active"); // Should succeed

		expect(result).toBe(true);
		expect(sm.state).toBe("active");
	});

	// ─── Custom emojis ───────────────────────────────────────

	it("uses custom emojis when provided", async () => {
		const customEmojis: Record<ReactionState, string> = {
			queued: "🕐",
			active: "⚡",
			done: "👍",
			error: "💀",
			timeout: "🔥",
		};
		const sendReaction = createMockSendReaction();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			createMockLogger(),
			customEmojis,
		);

		await sm.transition("queued");
		expect(sendReaction).toHaveBeenCalledWith(chatJid, messageId, "🕐");

		await sm.transition("active");
		expect(sendReaction).toHaveBeenCalledWith(chatJid, messageId, "⚡");

		await sm.transition("done");
		expect(sendReaction).toHaveBeenCalledWith(chatJid, messageId, "👍");
	});

	// ─── clear() ─────────────────────────────────────────────

	it("sends empty string to clear a reaction", async () => {
		const sendReaction = createMockSendReaction();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			createMockLogger(),
		);

		await sm.transition("queued");
		sendReaction.mockClear();

		await sm.clear();
		expect(sendReaction).toHaveBeenCalledWith(chatJid, messageId, "");
	});

	it("handles clear() failure gracefully", async () => {
		const sendReaction = vi.fn(async (_jid: string, _id: string, emoji: string) => {
			if (emoji === "") throw new Error("network error");
		}) as any;
		const logger = createMockLogger();
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			sendReaction,
			logger,
		);

		// Should not throw
		await sm.clear();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("Failed to clear"),
		);
	});

	// ─── isTerminal ──────────────────────────────────────────

	it("reports non-terminal for queued and active states", async () => {
		const sm = new ReactionStateMachine(
			chatJid,
			messageId,
			createMockSendReaction(),
			createMockLogger(),
		);

		expect(sm.isTerminal).toBe(false);

		await sm.transition("queued");
		expect(sm.isTerminal).toBe(false);

		await sm.transition("active");
		expect(sm.isTerminal).toBe(false);
	});

	it("reports terminal for done, error, and timeout states", async () => {
		const states: ReactionState[] = ["done", "error", "timeout"];

		for (const terminalState of states) {
			const sm = new ReactionStateMachine(
				chatJid,
				messageId,
				createMockSendReaction(),
				createMockLogger(),
			);
			await sm.transition("queued");
			await sm.transition(terminalState);
			expect(sm.isTerminal).toBe(true);
		}
	});
});
