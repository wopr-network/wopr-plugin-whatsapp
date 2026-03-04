/**
 * WhatsApp Friend Request Notifications
 *
 * Sends friend request approval prompts to the bot owner via WhatsApp DM.
 * The owner replies with "ACCEPT" or "DENY" to handle the request.
 */

import { logger } from "./logger.js";
import { sendMessageInternal, toJid } from "./messaging.js";

// ============================================================================
// Constants
// ============================================================================

const PENDING_REQUEST_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ============================================================================
// Types
// ============================================================================

export interface PendingFriendRequest {
  requestFrom: string;
  pubkey: string;
  encryptPub: string;
  channelId: string;
  channelName: string;
  signature: string;
  timestamp: number;
}

// ============================================================================
// Module state
// ============================================================================

// Pending requests awaiting owner reply (keyed by requestFrom, lowercased)
const pendingRequests: Map<string, PendingFriendRequest> = new Map();

let _getOwnerNumber: () => string | undefined = () => undefined;

export function initNotification(getOwnerNumber: () => string | undefined): void {
  _getOwnerNumber = getOwnerNumber;
}

// ============================================================================
// Helpers
// ============================================================================

function buildNotificationMessage(requestFrom: string, pubkey: string, channelName: string): string {
  const pubkeyShort = `${pubkey.slice(0, 12)}...`;
  return [
    "*Friend Request Received*",
    "",
    `*From:* ${requestFrom}`,
    `*Pubkey:* ${pubkeyShort}`,
    `*Channel:* ${channelName}`,
    "",
    "Reply *ACCEPT* or *DENY* to handle this request.",
    "_(Expires in 15 minutes)_",
  ].join("\n");
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Send a friend request notification to the owner via WhatsApp.
 * Returns true if the message was sent, false if no owner is configured or
 * the WhatsApp socket is not connected.
 */
export async function sendFriendRequestNotification(
  requestFrom: string,
  pubkey: string,
  encryptPub: string,
  channelId: string,
  channelName: string,
  signature: string,
): Promise<boolean> {
  const ownerNumber = _getOwnerNumber();
  if (!ownerNumber) {
    logger.warn({ msg: "No ownerNumber configured - friend request notification not sent" });
    return false;
  }

  try {
    // Store the pending request
    pendingRequests.set(requestFrom.toLowerCase(), {
      requestFrom,
      pubkey,
      encryptPub,
      channelId,
      channelName,
      signature,
      timestamp: Date.now(),
    });

    const message = buildNotificationMessage(requestFrom, pubkey, channelName);
    await sendMessageInternal(toJid(ownerNumber), message);

    logger.info({ msg: "Friend request notification sent to owner", requestFrom, ownerNumber });
    return true;
  } catch (err) {
    // Remove the pending entry if send failed
    pendingRequests.delete(requestFrom.toLowerCase());
    logger.error({ msg: "Failed to send friend request notification", error: String(err) });
    return false;
  }
}

/**
 * Check if an incoming message from the owner is an ACCEPT or DENY response.
 * If so, look up the most-recent pending request and invoke the appropriate
 * p2p extension method.
 *
 * Returns true if the message was consumed as an ACCEPT/DENY response.
 */
export async function handleOwnerReply(
  fromJid: string,
  text: string,
  getP2pExtension: () => P2PExtension | undefined,
): Promise<boolean> {
  const ownerNumber = _getOwnerNumber();
  if (!ownerNumber) return false;

  // Normalise: strip country-code prefix differences by comparing the
  // numeric digits portion of the JID to the configured ownerNumber.
  const ownerDigits = ownerNumber.replace(/[^0-9]/g, "");
  const fromDigits = fromJid.split("@")[0]?.replace(/[^0-9]/g, "") ?? "";
  if (!ownerDigits || ownerDigits !== fromDigits) return false;

  const normalised = text.trim().toUpperCase();
  if (normalised !== "ACCEPT" && normalised !== "DENY") return false;

  // Find the oldest non-expired pending request
  const now = Date.now();
  let oldest: PendingFriendRequest | undefined;
  for (const req of pendingRequests.values()) {
    if (now - req.timestamp > PENDING_REQUEST_TTL_MS) {
      pendingRequests.delete(req.requestFrom.toLowerCase());
      continue;
    }
    if (!oldest || req.timestamp < oldest.timestamp) {
      oldest = req;
    }
  }

  if (!oldest) {
    logger.info({ msg: "Owner replied ACCEPT/DENY but no pending friend requests found" });
    return true; // consumed, but nothing to act on
  }

  pendingRequests.delete(oldest.requestFrom.toLowerCase());

  const p2p = getP2pExtension();

  if (normalised === "ACCEPT") {
    if (p2p?.acceptFriendRequest) {
      try {
        const result = await p2p.acceptFriendRequest(
          oldest.requestFrom,
          oldest.pubkey,
          oldest.encryptPub,
          oldest.signature,
          oldest.channelId,
        );
        const replyMsg = result?.acceptMessage ?? `Friend request from ${oldest.requestFrom} accepted.`;
        await sendMessageInternal(toJid(ownerNumber), replyMsg);
        logger.info({ msg: "Friend request accepted", from: oldest.requestFrom });
      } catch (err) {
        logger.error({ msg: "Failed to accept friend request", error: String(err) });
        await sendMessageInternal(
          toJid(ownerNumber),
          `Failed to accept friend request from ${oldest.requestFrom}: ${err}`,
        );
      }
    } else {
      await sendMessageInternal(
        toJid(ownerNumber),
        `Accepted friend request from ${oldest.requestFrom} (P2P extension not available).`,
      );
    }
  } else {
    // DENY
    if (p2p?.denyFriendRequest) {
      try {
        await p2p.denyFriendRequest(oldest.requestFrom, oldest.signature);
        logger.info({ msg: "Friend request denied", from: oldest.requestFrom });
      } catch (err) {
        logger.error({ msg: "Failed to deny friend request", error: String(err) });
      }
    }
    await sendMessageInternal(toJid(ownerNumber), `Friend request from ${oldest.requestFrom} denied.`);
  }

  return true;
}

/**
 * Clean up expired pending requests.
 */
export function cleanupExpiredNotifications(): void {
  const now = Date.now();
  for (const [key, req] of pendingRequests) {
    if (now - req.timestamp > PENDING_REQUEST_TTL_MS) {
      pendingRequests.delete(key);
    }
  }
}

// ============================================================================
// P2P extension interface (local copy — avoids importing from p2p plugin)
// ============================================================================

export interface P2PExtension {
  acceptFriendRequest?: (
    from: string,
    pubkey: string,
    encryptPub: string,
    signature: string,
    channelId: string,
  ) => Promise<{ friend: { name: string }; acceptMessage: string }>;
  denyFriendRequest?: (from: string, signature: string) => Promise<void>;
}
