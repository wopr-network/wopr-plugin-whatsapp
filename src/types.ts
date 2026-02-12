/**
 * Re-export shared types from @wopr-network/plugin-types,
 * plus plugin-specific extensions for wopr-plugin-whatsapp.
 */

// Re-export all shared types used by this plugin
export type {
  AgentIdentity,
  ChannelRef,
  ConfigSchema,
  PluginInjectOptions,
  PluginLogger,
  StreamMessage,
  UserProfile,
  WOPRPlugin,
  WOPRPluginContext,
} from "@wopr-network/plugin-types";

// Import ConfigField so we can extend it
import type { ConfigField as SharedConfigField } from "@wopr-network/plugin-types";

/**
 * Extended ConfigField with `hidden` support used by this plugin's
 * config schema (e.g., the pairingRequests field).
 */
export interface ConfigField extends SharedConfigField {
  hidden?: boolean;
}
