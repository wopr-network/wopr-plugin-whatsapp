/**
 * Storage API-backed Baileys AuthenticationState adapter.
 *
 * Replaces the filesystem-based `useMultiFileAuthState()` with a
 * `useStorageAuthState()` that persists credentials and signal keys
 * through the WOPR Storage API.
 */

import {
	type AuthenticationCreds,
	type AuthenticationState,
	BufferJSON,
	initAuthCreds,
	proto,
	type SignalDataSet,
	type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import type { PluginStorageAPI } from "./storage.js";
import { WHATSAPP_CREDS_TABLE, WHATSAPP_KEYS_TABLE } from "./storage.js";

/**
 * Create a Baileys-compatible AuthenticationState backed by the WOPR
 * Storage API.
 *
 * @param storage  The PluginStorageAPI instance.
 * @param accountId  Unique key for this WhatsApp account.
 * @returns `{ state, saveCreds }` — drop-in replacement for
 *          `useMultiFileAuthState()`.
 */
export async function useStorageAuthState(
	storage: PluginStorageAPI,
	accountId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
	// ------------------------------------------------------------------
	// Load or initialize credentials
	// ------------------------------------------------------------------
	let creds: AuthenticationCreds;

	const raw = await storage.get(WHATSAPP_CREDS_TABLE, accountId);
	if (raw) {
		try {
			// Round-trip through JSON so Buffer instances survive storage
			creds = JSON.parse(
				JSON.stringify(raw),
				BufferJSON.reviver,
			) as AuthenticationCreds;
		} catch {
			// Stored record is corrupt — start fresh rather than hard-failing
			creds = initAuthCreds();
		}
	} else {
		creds = initAuthCreds();
	}

	// ------------------------------------------------------------------
	// saveCreds — serialize with BufferJSON.replacer and persist
	// ------------------------------------------------------------------
	const saveCreds = async (): Promise<void> => {
		const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
		await storage.put(WHATSAPP_CREDS_TABLE, accountId, serialized);
	};

	// ------------------------------------------------------------------
	// Signal key store
	// ------------------------------------------------------------------
	const keys = {
		get: async <T extends keyof SignalDataTypeMap>(
			type: T,
			ids: string[],
		): Promise<Record<string, SignalDataTypeMap[T]>> => {
			const pairs = await Promise.all(
				ids.map(async (id) => {
					const key = `${accountId}:${type}-${id}`;
					const val = await storage.get(WHATSAPP_KEYS_TABLE, key);
					if (val == null) return null;
					let deserialized = JSON.parse(
						JSON.stringify(val),
						BufferJSON.reviver,
					);
					// Special case: app-state-sync-key values must be
					// decoded through the protobuf definition.
					if (type === "app-state-sync-key") {
						deserialized =
							proto.Message.AppStateSyncKeyData.fromObject(deserialized);
					}
					return [id, deserialized as SignalDataTypeMap[T]] as const;
				}),
			);
			return Object.fromEntries(
				pairs.filter((p): p is [string, SignalDataTypeMap[T]] => p !== null),
			);
		},

		set: async (data: SignalDataSet): Promise<void> => {
			const ops: Promise<void>[] = [];
			for (const [category, entries] of Object.entries(data)) {
				for (const [id, value] of Object.entries(entries)) {
					const key = `${accountId}:${category}-${id}`;
					if (value != null) {
						const serialized = JSON.parse(
							JSON.stringify(value, BufferJSON.replacer),
						);
						ops.push(storage.put(WHATSAPP_KEYS_TABLE, key, serialized));
					} else {
						ops.push(storage.delete(WHATSAPP_KEYS_TABLE, key));
					}
				}
			}
			await Promise.all(ops);
		},
	};

	return {
		state: { creds, keys },
		saveCreds,
	};
}
