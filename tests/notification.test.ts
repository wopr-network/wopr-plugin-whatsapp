/**
 * Tests for src/notification.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock messaging module
vi.mock("../src/messaging.js", () => ({
  sendMessageInternal: vi.fn().mockResolvedValue(undefined),
  toJid: (phone: string) => (phone.includes("@") ? phone : `${phone.replace(/[^0-9]/g, "")}@s.whatsapp.net`),
}));

// Mock logger
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sendMessageInternal } from "../src/messaging.js";
import {
  cleanupExpiredNotifications,
  handleOwnerReply,
  initNotification,
  sendFriendRequestNotification,
  startNotificationCleanup,
  stopNotificationCleanup,
  type P2PExtension,
} from "../src/notification.js";

const OWNER = "+15551234567";
const OWNER_JID = "15551234567@s.whatsapp.net";

const mockSend = sendMessageInternal as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockSend.mockClear();
  initNotification(() => OWNER);
});

afterEach(() => {
  // Reset owner number after each test
  initNotification(() => undefined);
});

describe("sendFriendRequestNotification", () => {
  it("returns false when no ownerNumber configured", async () => {
    initNotification(() => undefined);
    const result = await sendFriendRequestNotification("alice", "a".repeat(64), "b".repeat(64), "ch1", "general", "sig1");
    expect(result).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends a WhatsApp message to the owner and returns true", async () => {
    const result = await sendFriendRequestNotification("alice", "a".repeat(64), "b".repeat(64), "ch1", "general", "sig1");
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledOnce();
    const [toArg, msgArg] = mockSend.mock.calls[0] as [string, string];
    expect(toArg).toBe(OWNER_JID);
    expect(msgArg).toContain("Friend Request Received");
    expect(msgArg).toContain("alice");
    expect(msgArg).toContain("ACCEPT");
    expect(msgArg).toContain("DENY");
  });

  it("returns false and removes pending entry when sendMessageInternal throws", async () => {
    mockSend.mockRejectedValueOnce(new Error("network error"));
    const result = await sendFriendRequestNotification("bob", "a".repeat(64), "b".repeat(64), "ch2", "lobby", "sig2");
    expect(result).toBe(false);
  });
});

describe("handleOwnerReply", () => {
  const noOpP2P = (): P2PExtension => ({});

  it("ignores messages not from the owner", async () => {
    const consumed = await handleOwnerReply("99999@s.whatsapp.net", "ACCEPT", noOpP2P);
    expect(consumed).toBe(false);
  });

  it("ignores non-ACCEPT/DENY messages from the owner", async () => {
    const consumed = await handleOwnerReply(OWNER_JID, "hello", noOpP2P);
    expect(consumed).toBe(false);
  });

  it("returns true (consumed) when ACCEPT/DENY but no pending requests", async () => {
    const consumed = await handleOwnerReply(OWNER_JID, "ACCEPT", noOpP2P);
    expect(consumed).toBe(true);
    // No p2p calls, no additional send
  });

  it("calls acceptFriendRequest and sends confirmation on ACCEPT", async () => {
    await sendFriendRequestNotification("carol", "c".repeat(64), "d".repeat(64), "ch3", "lobby", "sig3");
    mockSend.mockClear();

    const p2pAccept = vi.fn().mockResolvedValue({ friend: { name: "carol" }, acceptMessage: "carol accepted!" });
    const p2p = (): P2PExtension => ({ acceptFriendRequest: p2pAccept });

    const consumed = await handleOwnerReply(OWNER_JID, "ACCEPT", p2p);
    expect(consumed).toBe(true);
    expect(p2pAccept).toHaveBeenCalledOnce();
    const [from, pubkey, encryptPub, signature, channelId] = p2pAccept.mock.calls[0] as string[];
    expect(from).toBe("carol");
    expect(pubkey).toBe("c".repeat(64));
    expect(encryptPub).toBe("d".repeat(64));
    expect(signature).toBe("sig3");
    expect(channelId).toBe("ch3");

    expect(mockSend).toHaveBeenCalledWith(OWNER_JID, "carol accepted!");
  });

  it("calls denyFriendRequest and sends confirmation on DENY", async () => {
    await sendFriendRequestNotification("dave", "e".repeat(64), "f".repeat(64), "ch4", "general", "sig4");
    mockSend.mockClear();

    const p2pDeny = vi.fn().mockResolvedValue(undefined);
    const p2p = (): P2PExtension => ({ denyFriendRequest: p2pDeny });

    const consumed = await handleOwnerReply(OWNER_JID, "DENY", p2p);
    expect(consumed).toBe(true);
    expect(p2pDeny).toHaveBeenCalledWith("dave", "sig4");
    expect(mockSend).toHaveBeenCalledWith(OWNER_JID, expect.stringContaining("dave"));
  });

  it("handles case-insensitive ACCEPT from owner", async () => {
    await sendFriendRequestNotification("eve", "a".repeat(64), "b".repeat(64), "ch5", "general", "sig5");
    mockSend.mockClear();

    const p2pAccept = vi.fn().mockResolvedValue({ friend: { name: "eve" }, acceptMessage: "ok" });
    const p2p = (): P2PExtension => ({ acceptFriendRequest: p2pAccept });

    const consumed = await handleOwnerReply(OWNER_JID, "accept", p2p);
    expect(consumed).toBe(true);
    expect(p2pAccept).toHaveBeenCalled();
  });

  it("sends fallback message if p2p extension not available for ACCEPT", async () => {
    await sendFriendRequestNotification("frank", "a".repeat(64), "b".repeat(64), "ch6", "general", "sig6");
    mockSend.mockClear();

    const consumed = await handleOwnerReply(OWNER_JID, "ACCEPT", noOpP2P);
    expect(consumed).toBe(true);
    const [to, message] = mockSend.mock.calls[0] as [string, string];
    expect(to).toBe(OWNER_JID);
    expect(message).toContain("frank");
    expect(message.toLowerCase()).toContain("not available");
  });

  it("sends fallback message if p2p extension not available for DENY", async () => {
    await sendFriendRequestNotification("grace", "a".repeat(64), "b".repeat(64), "ch7", "general", "sig7");
    mockSend.mockClear();

    const consumed = await handleOwnerReply(OWNER_JID, "DENY", noOpP2P);
    expect(consumed).toBe(true);
    const [to, message] = mockSend.mock.calls[0] as [string, string];
    expect(to).toBe(OWNER_JID);
    expect(message).toContain("grace");
    expect(message.toLowerCase()).toContain("not available");
  });

  it("sends error message when ACCEPT handler throws", async () => {
    await sendFriendRequestNotification("henry", "h".repeat(64), "i".repeat(64), "ch8", "general", "sig8");
    mockSend.mockClear();

    const p2pAccept = vi.fn().mockRejectedValue(new Error("accept failed"));
    const p2p = (): P2PExtension => ({ acceptFriendRequest: p2pAccept });

    const consumed = await handleOwnerReply(OWNER_JID, "ACCEPT", p2p);
    expect(consumed).toBe(true);
    expect(p2pAccept).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalled();
    const [to, message] = mockSend.mock.calls.at(-1) as [string, string];
    expect(to).toBe(OWNER_JID);
    expect(message).toContain("henry");
    expect(message.toLowerCase()).toContain("error");
  });

  it("sends error message when DENY handler throws", async () => {
    await sendFriendRequestNotification("iris", "j".repeat(64), "k".repeat(64), "ch9", "general", "sig9");
    mockSend.mockClear();

    const p2pDeny = vi.fn().mockRejectedValue(new Error("deny failed"));
    const p2p = (): P2PExtension => ({ denyFriendRequest: p2pDeny });

    const consumed = await handleOwnerReply(OWNER_JID, "DENY", p2p);
    expect(consumed).toBe(true);
    expect(p2pDeny).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalled();
    const [to, message] = mockSend.mock.calls.at(-1) as [string, string];
    expect(to).toBe(OWNER_JID);
    expect(message).toContain("iris");
    expect(message.toLowerCase()).toContain("error");
  });
});

describe("handleOwnerReply — delete ordering (Finding 2)", () => {
  it("removes the pending entry even when ACCEPT handler throws", async () => {
    await sendFriendRequestNotification("jack", "j".repeat(64), "k".repeat(64), "ch10", "test", "sig10");
    mockSend.mockClear();

    const p2pAccept = vi.fn().mockRejectedValue(new Error("p2p unavailable"));
    const p2p = (): P2PExtension => ({ acceptFriendRequest: p2pAccept });

    await handleOwnerReply(OWNER_JID, "ACCEPT", p2p);

    // A second ACCEPT should find no pending requests (entry was cleaned up in finally)
    mockSend.mockClear();
    const consumed = await handleOwnerReply(OWNER_JID, "ACCEPT", p2p);
    expect(consumed).toBe(true);
    expect(p2pAccept).toHaveBeenCalledOnce(); // only once — not a second time
  });

  it("removes the pending entry even when DENY handler throws", async () => {
    await sendFriendRequestNotification("kim", "l".repeat(64), "m".repeat(64), "ch11", "test", "sig11");
    mockSend.mockClear();

    const p2pDeny = vi.fn().mockRejectedValue(new Error("p2p unavailable"));
    const p2p = (): P2PExtension => ({ denyFriendRequest: p2pDeny });

    await handleOwnerReply(OWNER_JID, "DENY", p2p);

    // A second DENY should find no pending requests
    mockSend.mockClear();
    const consumed = await handleOwnerReply(OWNER_JID, "DENY", p2p);
    expect(consumed).toBe(true);
    expect(p2pDeny).toHaveBeenCalledOnce(); // only called once
  });
});

describe("startNotificationCleanup / stopNotificationCleanup (Finding 3)", () => {
  it("periodically invokes cleanupExpiredNotifications via the interval", async () => {
    vi.useFakeTimers();
    await sendFriendRequestNotification("leo", "a".repeat(64), "b".repeat(64), "ch12", "general", "sig12");

    startNotificationCleanup();

    // Advance past TTL so entries become stale
    vi.advanceTimersByTime(16 * 60 * 1000);

    stopNotificationCleanup();

    // After the interval fires, the expired entry should have been pruned
    mockSend.mockClear();
    const consumed = await handleOwnerReply(OWNER_JID, "ACCEPT", () => ({}));
    expect(consumed).toBe(true);
    expect(mockSend).not.toHaveBeenCalled(); // no pending entry remains

    vi.useRealTimers();
  });

  it("stopNotificationCleanup prevents further cleanup ticks", () => {
    vi.useFakeTimers();
    startNotificationCleanup();
    stopNotificationCleanup();
    // Should not throw if called again when no interval is active
    stopNotificationCleanup();
    vi.useRealTimers();
  });
});

describe("cleanupExpiredNotifications", () => {
  it("removes expired pending requests", async () => {
    // Use a fake timer to simulate expiry
    vi.useFakeTimers();
    await sendFriendRequestNotification("grace", "a".repeat(64), "b".repeat(64), "ch7", "general", "sig7");

    // Advance 16 minutes past TTL
    vi.advanceTimersByTime(16 * 60 * 1000);
    cleanupExpiredNotifications();

    // After cleanup, ACCEPT should find no pending requests
    mockSend.mockClear();
    const consumed = await handleOwnerReply(OWNER_JID, "ACCEPT", () => ({}));
    expect(consumed).toBe(true);
    // No send call because no pending request was found
    expect(mockSend).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
