import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	WhatsAppMessageStream,
	StreamManager,
	findSplitPoint,
	WHATSAPP_LIMIT,
	EDIT_INTERVAL_MS,
} from "../src/streaming.js";

// Create a mock WASocket
function createMockSocket() {
	return {
		sendMessage: vi.fn(async (_jid: string, _content: any) => ({
			key: {
				remoteJid: "test@s.whatsapp.net",
				id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				fromMe: true,
			},
		})),
		ev: { on: vi.fn() },
		sendPresenceUpdate: vi.fn(),
		logout: vi.fn(),
	} as any;
}

function createMockLogger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as any;
}

describe("findSplitPoint", () => {
	it("returns full length for short text", () => {
		expect(findSplitPoint("hello", 100)).toBe(5);
	});

	it("splits at sentence boundary", () => {
		const text = "First sentence. Second sentence. Third sentence and more text that goes on.";
		const point = findSplitPoint(text, 40);
		// Should split after "Second sentence. " since it's the last sentence boundary before 40
		expect(point).toBeLessThanOrEqual(40);
		expect(text.slice(0, point).trim()).toMatch(/[.!?]$/);
	});

	it("splits at newline when no sentence boundary", () => {
		const text = "line one content here\nline two content here that keeps going and going and going";
		const point = findSplitPoint(text, 30);
		expect(point).toBeLessThanOrEqual(30);
	});

	it("splits at word boundary as fallback", () => {
		const text = "word1 word2 word3 word4 word5 word6 word7 word8";
		const point = findSplitPoint(text, 25);
		expect(point).toBeLessThanOrEqual(25);
		// Should not split mid-word
		expect(text[point - 1]).toBe(" ");
	});

	it("hard-splits at limit when no good boundary", () => {
		const text = "a".repeat(100);
		const point = findSplitPoint(text, 50);
		expect(point).toBe(50);
	});
});

describe("WhatsAppMessageStream", () => {
	let mockSocket: ReturnType<typeof createMockSocket>;
	let mockLogger: ReturnType<typeof createMockLogger>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockSocket = createMockSocket();
		mockLogger = createMockLogger();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("creates a stream that is not finalized", () => {
		const stream = new WhatsAppMessageStream("test@s.whatsapp.net", mockSocket, mockLogger);
		expect(stream.isFinalized).toBe(false);
		expect(stream.isCancelled).toBe(false);
		expect(stream.didStream).toBe(false);
		stream.cancel(); // cleanup
	});

	it("sends initial message on first flush", async () => {
		const stream = new WhatsAppMessageStream("test@s.whatsapp.net", mockSocket, mockLogger);

		stream.append("Hello world");

		// Trigger flush via timer
		await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

		expect(mockSocket.sendMessage).toHaveBeenCalledTimes(1);
		expect(mockSocket.sendMessage).toHaveBeenCalledWith("test@s.whatsapp.net", {
			text: "Hello world",
		});
		expect(stream.didStream).toBe(true);

		stream.cancel();
	});

	it("edits existing message on subsequent flushes", async () => {
		const stream = new WhatsAppMessageStream("test@s.whatsapp.net", mockSocket, mockLogger);

		stream.append("Hello");
		await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

		expect(mockSocket.sendMessage).toHaveBeenCalledTimes(1);
		const firstCallResult = await mockSocket.sendMessage.mock.results[0].value;

		stream.append(" world");
		await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

		expect(mockSocket.sendMessage).toHaveBeenCalledTimes(2);
		// Second call should include the edit key
		const secondCall = mockSocket.sendMessage.mock.calls[1];
		expect(secondCall[1].text).toBe("Hello world");
		expect(secondCall[1].edit).toBeDefined();
		expect(secondCall[1].edit.id).toBe(firstCallResult.key.id);

		stream.cancel();
	});

	it("batches rapid appends into single flush", async () => {
		const stream = new WhatsAppMessageStream("test@s.whatsapp.net", mockSocket, mockLogger);

		stream.append("A");
		stream.append("B");
		stream.append("C");

		await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

		expect(mockSocket.sendMessage).toHaveBeenCalledTimes(1);
		expect(mockSocket.sendMessage).toHaveBeenCalledWith("test@s.whatsapp.net", {
			text: "ABC",
		});

		stream.cancel();
	});

	it("does not flush when cancelled", async () => {
		const stream = new WhatsAppMessageStream("test@s.whatsapp.net", mockSocket, mockLogger);

		stream.append("Hello");
		stream.cancel();

		await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

		expect(mockSocket.sendMessage).not.toHaveBeenCalled();
		expect(stream.isCancelled).toBe(true);
	});

	it("ignores appends after finalization", async () => {
		const stream = new WhatsAppMessageStream("test@s.whatsapp.net", mockSocket, mockLogger);

		stream.append("Hello");
		await stream.finalize();

		const callCount = mockSocket.sendMessage.mock.calls.length;

		stream.append("Should be ignored");
		await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS * 3);

		expect(mockSocket.sendMessage.mock.calls.length).toBe(callCount);
		expect(stream.isFinalized).toBe(true);
	});

	it("finalize flushes remaining content", async () => {
		const stream = new WhatsAppMessageStream("test@s.whatsapp.net", mockSocket, mockLogger);

		stream.append("Final content");
		await stream.finalize();

		expect(mockSocket.sendMessage).toHaveBeenCalledWith("test@s.whatsapp.net", {
			text: "Final content",
		});
	});

	it("handles overflow by splitting into new messages", async () => {
		const stream = new WhatsAppMessageStream("test@s.whatsapp.net", mockSocket, mockLogger);

		// Append content that exceeds WHATSAPP_LIMIT
		const longText = "Word ".repeat(1000); // ~5000 chars
		stream.append(longText);

		await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

		// Should have sent at least 2 messages (original + overflow)
		expect(mockSocket.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);

		// First message should be under the limit
		const firstText = mockSocket.sendMessage.mock.calls[0][1].text;
		expect(firstText.length).toBeLessThanOrEqual(WHATSAPP_LIMIT);

		stream.cancel();
	});

	it("does not send when content is empty", async () => {
		const stream = new WhatsAppMessageStream("test@s.whatsapp.net", mockSocket, mockLogger);

		stream.append("");
		await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

		expect(mockSocket.sendMessage).not.toHaveBeenCalled();

		stream.cancel();
	});

	it("does not re-flush if content has not changed", async () => {
		const stream = new WhatsAppMessageStream("test@s.whatsapp.net", mockSocket, mockLogger);

		stream.append("Static content");
		await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);
		expect(mockSocket.sendMessage).toHaveBeenCalledTimes(1);

		// Let another interval pass with no new content
		await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);
		expect(mockSocket.sendMessage).toHaveBeenCalledTimes(1);

		stream.cancel();
	});

	it("handles sendMessage failure gracefully", async () => {
		mockSocket.sendMessage.mockRejectedValueOnce(new Error("Network error"));

		const stream = new WhatsAppMessageStream("test@s.whatsapp.net", mockSocket, mockLogger);

		stream.append("Hello");
		await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

		expect(mockLogger.error).toHaveBeenCalled();
		expect(stream.isFinalized).toBe(false);

		stream.cancel();
	});
});

describe("StreamManager", () => {
	let mockSocket: ReturnType<typeof createMockSocket>;
	let mockLogger: ReturnType<typeof createMockLogger>;
	let manager: StreamManager;

	beforeEach(() => {
		vi.useFakeTimers();
		mockSocket = createMockSocket();
		mockLogger = createMockLogger();
		manager = new StreamManager();
	});

	afterEach(() => {
		manager.cancelAll();
		vi.useRealTimers();
	});

	it("creates a new stream for a JID", () => {
		const stream = manager.create("test@s.whatsapp.net", mockSocket, mockLogger);
		expect(stream).toBeDefined();
		expect(stream.isFinalized).toBe(false);
	});

	it("returns the active stream via get()", () => {
		const created = manager.create("test@s.whatsapp.net", mockSocket, mockLogger);
		const retrieved = manager.get("test@s.whatsapp.net");
		expect(retrieved).toBe(created);
	});

	it("returns undefined for unknown JID", () => {
		expect(manager.get("unknown@s.whatsapp.net")).toBeUndefined();
	});

	it("interrupts existing stream when creating new one for same JID", () => {
		const first = manager.create("test@s.whatsapp.net", mockSocket, mockLogger);
		const second = manager.create("test@s.whatsapp.net", mockSocket, mockLogger);

		expect(first.isCancelled).toBe(true);
		expect(second.isCancelled).toBe(false);
	});

	it("interrupt() cancels and removes the stream", () => {
		manager.create("test@s.whatsapp.net", mockSocket, mockLogger);

		const interrupted = manager.interrupt("test@s.whatsapp.net");
		expect(interrupted).toBe(true);
		expect(manager.get("test@s.whatsapp.net")).toBeUndefined();
	});

	it("interrupt() returns false for non-existent stream", () => {
		expect(manager.interrupt("unknown@s.whatsapp.net")).toBe(false);
	});

	it("finalize() finalizes and removes the stream", async () => {
		const stream = manager.create("test@s.whatsapp.net", mockSocket, mockLogger);
		stream.append("content");

		const didStream = await manager.finalize("test@s.whatsapp.net");
		expect(didStream).toBe(true);
		expect(manager.get("test@s.whatsapp.net")).toBeUndefined();
	});

	it("finalize() returns false for non-existent stream", async () => {
		const result = await manager.finalize("unknown@s.whatsapp.net");
		expect(result).toBe(false);
	});

	it("cancelAll() cancels all active streams", () => {
		const stream1 = manager.create("user1@s.whatsapp.net", mockSocket, mockLogger);
		const stream2 = manager.create("user2@s.whatsapp.net", mockSocket, mockLogger);

		manager.cancelAll();

		expect(stream1.isCancelled).toBe(true);
		expect(stream2.isCancelled).toBe(true);
	});

	it("get() cleans up finalized streams", async () => {
		const stream = manager.create("test@s.whatsapp.net", mockSocket, mockLogger);
		await stream.finalize();

		expect(manager.get("test@s.whatsapp.net")).toBeUndefined();
	});

	it("get() cleans up cancelled streams", () => {
		const stream = manager.create("test@s.whatsapp.net", mockSocket, mockLogger);
		stream.cancel();

		expect(manager.get("test@s.whatsapp.net")).toBeUndefined();
	});
});
