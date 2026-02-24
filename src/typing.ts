/**
 * WhatsApp typing indicator management with ref-counting.
 */
import type { WASocket } from "@whiskeysockets/baileys";

// Typing indicator refresh interval (composing status expires after ~10s in WhatsApp)
const TYPING_REFRESH_MS = 5000;

// Active typing intervals tracked for cleanup during shutdown/logout
const activeTypingIntervals: Set<NodeJS.Timeout> = new Set();

// Ref-counting per jid to handle concurrent typing indicators
const typingRefCounts: Map<
	string,
	{ count: number; interval: NodeJS.Timeout }
> = new Map();

let _getSocket: () => WASocket | null = () => null;

export function initTyping(getSocket: () => WASocket | null): void {
	_getSocket = getSocket;
}

// Start typing indicator with auto-refresh and ref-counting
export function startTypingIndicator(jid: string): void {
	const existing = typingRefCounts.get(jid);
	if (existing) {
		existing.count++;
		return;
	}

	const socket = _getSocket();
	if (!socket) return;

	const sock = socket;
	// Send initial composing presence
	sock.sendPresenceUpdate("composing", jid).catch(() => {});

	// Refresh every TYPING_REFRESH_MS since WhatsApp composing status expires
	const interval = setInterval(() => {
		// Guard against stale socket reference
		if (_getSocket() !== sock) {
			clearInterval(interval);
			activeTypingIntervals.delete(interval);
			typingRefCounts.delete(jid);
			return;
		}
		sock.sendPresenceUpdate("composing", jid).catch(() => {});
	}, TYPING_REFRESH_MS);
	interval.unref();

	activeTypingIntervals.add(interval);
	typingRefCounts.set(jid, { count: 1, interval });
}

// Stop typing indicator with ref-counting
export function stopTypingIndicator(jid: string): void {
	const existing = typingRefCounts.get(jid);
	if (!existing) return;

	existing.count--;
	if (existing.count > 0) return;

	// Last reference — actually stop
	clearInterval(existing.interval);
	activeTypingIntervals.delete(existing.interval);
	typingRefCounts.delete(jid);

	const socket = _getSocket();
	if (socket) {
		socket.sendPresenceUpdate("paused", jid).catch(() => {});
	}
}

// Clear all active typing intervals (for shutdown/logout)
export function clearAllTypingIntervals(): void {
	for (const interval of activeTypingIntervals) {
		clearInterval(interval);
	}
	activeTypingIntervals.clear();
	typingRefCounts.clear();
}
