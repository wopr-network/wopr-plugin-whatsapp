/**
 * WhatsApp Extension (WebMCP data methods)
 *
 * Provides structured return types and read-only data methods that the
 * WebMCP tools proxy through daemon API endpoints. Mirrors the pattern
 * used by wopr-plugin-discord's discord-extension.ts.
 */

import type { Contact, GroupMetadata, WASocket } from "@whiskeysockets/baileys";

// ============================================================================
// Structured return types for WebMCP-facing extension methods
// ============================================================================

export interface WhatsAppStatusInfo {
	connected: boolean;
	phoneNumber: string | null;
	qrState: "paired" | "awaiting_scan" | "unavailable";
	accountId: string;
	uptimeMs: number | null;
}

export interface ChatInfo {
	id: string;
	name: string;
	type: "individual" | "group";
	participantCount: number | null;
}

export interface WhatsAppMessageStatsInfo {
	messagesProcessed: number;
	activeConversations: number;
	groupCount: number;
	individualCount: number;
}

// ============================================================================
// Extension interface
// ============================================================================

export interface WhatsAppWebMCPExtension {
	getStatus: () => WhatsAppStatusInfo;
	listChats: () => ChatInfo[];
	getMessageStats: () => WhatsAppMessageStatsInfo;
}

// ============================================================================
// State accessors (passed from main plugin module)
// ============================================================================

export interface WhatsAppState {
	getSocket: () => WASocket | null;
	getContacts: () => Map<string, Contact>;
	getGroups: () => Map<string, GroupMetadata>;
	getSessionKeys: () => string[];
	getMessageCount: () => number;
	getAccountId: () => string;
	hasCredentials: () => boolean;
	getConnectTime: () => number | null;
}

// ============================================================================
// Factory
// ============================================================================

export function createWhatsAppWebMCPExtension(
	state: WhatsAppState,
): WhatsAppWebMCPExtension {
	return {
		getStatus: (): WhatsAppStatusInfo => {
			const sock = state.getSocket();
			const hasCreds = state.hasCredentials();
			const connectTime = state.getConnectTime();

			let qrState: WhatsAppStatusInfo["qrState"];
			if (sock) {
				qrState = "paired";
			} else if (hasCreds) {
				// Has credentials but socket is down -- reconnecting
				qrState = "paired";
			} else {
				qrState = "awaiting_scan";
			}

			let phoneNumber: string | null = null;
			if (sock?.user?.id) {
				// Baileys user.id format: "1234567890:12@s.whatsapp.net"
				phoneNumber = sock.user.id.split(":")[0] || sock.user.id.split("@")[0];
			}

			return {
				connected: sock !== null,
				phoneNumber,
				qrState,
				accountId: state.getAccountId(),
				uptimeMs: connectTime !== null ? Date.now() - connectTime : null,
			};
		},

		listChats: (): ChatInfo[] => {
			const chats: ChatInfo[] = [];
			const groups = state.getGroups();
			const contacts = state.getContacts();

			// Add groups
			for (const [id, group] of groups) {
				chats.push({
					id,
					name: group.subject || id,
					type: "group",
					participantCount: group.participants?.length ?? null,
				});
			}

			// Add individual contacts that have interacted (have a name)
			for (const [id, contact] of contacts) {
				// Skip group JIDs and status broadcast
				if (id.endsWith("@g.us") || id === "status@broadcast") continue;
				const name = contact.notify || contact.name || null;
				if (!name) continue;
				chats.push({
					id,
					name,
					type: "individual",
					participantCount: null,
				});
			}

			return chats;
		},

		getMessageStats: (): WhatsAppMessageStatsInfo => {
			const sessionKeys = state.getSessionKeys();
			const groups = state.getGroups();
			const contacts = state.getContacts();

			// Count individual contacts (exclude groups and status broadcast)
			let individualCount = 0;
			for (const [id, contact] of contacts) {
				if (
					!id.endsWith("@g.us") &&
					id !== "status@broadcast" &&
					(contact.notify || contact.name)
				) {
					individualCount++;
				}
			}

			return {
				messagesProcessed: state.getMessageCount(),
				activeConversations: sessionKeys.length,
				groupCount: groups.size,
				individualCount,
			};
		},
	};
}
