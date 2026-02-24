/**
 * Re-export shared types from @wopr-network/plugin-types,
 * plus plugin-specific extensions for wopr-plugin-whatsapp.
 */

// Re-export all shared types used by this plugin
export type {
	AgentIdentity,
	ChannelCommand,
	ChannelCommandContext,
	ChannelMessageContext,
	ChannelMessageParser,
	ChannelProvider,
	ChannelRef,
	ConfigSchema,
	PluginCapability,
	PluginCategory,
	PluginInjectOptions,
	PluginLogger,
	PluginManifest,
	StreamMessage,
	UserProfile,
	WOPRPlugin,
	WOPRPluginContext,
} from "@wopr-network/plugin-types";

// Import ConfigField so we can extend it
import type { ConfigField as SharedConfigField } from "@wopr-network/plugin-types";
import type { RetryConfig } from "./retry.js";

/**
 * Extended ConfigField with `hidden` support used by this plugin's
 * config schema (e.g., the pairingRequests field).
 */
export interface ConfigField extends SharedConfigField {
	hidden?: boolean;
}

export interface WhatsAppMessage {
	id: string;
	from: string;
	fromMe: boolean;
	timestamp: number;
	text?: string;
	mediaType?: string;
	mediaPath?: string;
	caption?: string;
	quotedMessage?: WhatsAppMessage;
	isGroup: boolean;
	groupName?: string;
	sender?: string;
	participant?: string;
}

export interface WhatsAppConfig {
	accountId?: string;
	authDir?: string;
	dmPolicy?: "allowlist" | "blocklist" | "open" | "disabled";
	allowFrom?: string[];
	selfChatMode?: boolean;
	ownerNumber?: string;
	verbose?: boolean;
	pairingRequests?: Record<
		string,
		{ code: string; name: string; requestedAt: number }
	>;
	retry?: Partial<RetryConfig>;
}
