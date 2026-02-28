/**
 * Storage API types and table definitions for WhatsApp plugin
 */

export interface StorageTableSchema {
  description?: string;
  version?: number;
}

export interface PluginStorageAPI {
  register(table: string, schema: StorageTableSchema): void;
  get(table: string, key: string): Promise<unknown>;
  put(table: string, key: string, value: unknown): Promise<void>;
  list(table: string): Promise<unknown[]>;
  delete(table: string, key: string): Promise<void>;
}

export interface PluginContextWithStorage {
  storage?: PluginStorageAPI;
}

export const WHATSAPP_CREDS_TABLE = "whatsapp_creds";
export const WHATSAPP_KEYS_TABLE = "whatsapp_keys";

export const WHATSAPP_CREDS_SCHEMA: StorageTableSchema = {
  description: "WhatsApp Baileys authentication credentials — keyed by accountId",
  version: 1,
};

export const WHATSAPP_KEYS_SCHEMA: StorageTableSchema = {
  description: "WhatsApp Baileys signal protocol keys — keyed by {accountId}:{category}-{keyId}",
  version: 1,
};
