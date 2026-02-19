import { describe, it, expect, beforeEach } from "vitest";
import { useStorageAuthState } from "../src/auth-state.js";
import type { PluginStorageAPI, StorageTableSchema } from "../src/storage.js";
import {
	BufferJSON,
	initAuthCreds,
	type AuthenticationCreds,
} from "@whiskeysockets/baileys";
import {
	WHATSAPP_CREDS_TABLE,
	WHATSAPP_KEYS_TABLE,
} from "../src/storage.js";

/**
 * In-memory mock of PluginStorageAPI for testing.
 */
function createMockStorage(): PluginStorageAPI {
	const tables = new Map<string, Map<string, unknown>>();

	return {
		register(_table: string, _schema: StorageTableSchema): void {
			// no-op for tests
		},
		async get(table: string, key: string): Promise<unknown> {
			return tables.get(table)?.get(key) ?? null;
		},
		async put(table: string, key: string, value: unknown): Promise<void> {
			if (!tables.has(table)) tables.set(table, new Map());
			tables.get(table)!.set(key, value);
		},
		async list(table: string): Promise<unknown[]> {
			const t = tables.get(table);
			if (!t) return [];
			return Array.from(t.entries()).map(([key, value]) => ({ key, value }));
		},
		async delete(table: string, key: string): Promise<void> {
			tables.get(table)?.delete(key);
		},
	};
}

describe("useStorageAuthState", () => {
	let storage: PluginStorageAPI;
	const accountId = "test-account";

	beforeEach(() => {
		storage = createMockStorage();
	});

	it("should return initAuthCreds when no creds exist in storage", async () => {
		const { state } = await useStorageAuthState(storage, accountId);

		expect(state.creds).toBeDefined();
		expect(state.creds.registrationId).toBeGreaterThan(0);
		expect(state.creds.noiseKey).toBeDefined();
		expect(state.creds.signedIdentityKey).toBeDefined();
	});

	it("should persist and reload creds via saveCreds", async () => {
		const { state: state1, saveCreds: save1 } = await useStorageAuthState(
			storage,
			accountId,
		);

		// Persist the initial creds
		await save1();

		// Reload from storage — should get the same creds back
		const { state: state2 } = await useStorageAuthState(storage, accountId);

		expect(state2.creds.registrationId).toBe(state1.creds.registrationId);
		expect(state2.creds.advSecretKey).toBe(state1.creds.advSecretKey);
	});

	it("should survive Buffer round-trip through serialize/deserialize", async () => {
		const { state, saveCreds } = await useStorageAuthState(
			storage,
			accountId,
		);

		// noiseKey contains Buffer values — ensure they survive storage
		const originalNoisePublic = Buffer.from(state.creds.noiseKey.public);

		await saveCreds();

		const { state: reloaded } = await useStorageAuthState(
			storage,
			accountId,
		);

		// The reloaded noise key public should be a Buffer with identical bytes
		expect(Buffer.isBuffer(reloaded.creds.noiseKey.public)).toBe(true);
		expect(
			Buffer.from(reloaded.creds.noiseKey.public).equals(originalNoisePublic),
		).toBe(true);
	});

	it("should set and get signal keys", async () => {
		const { state } = await useStorageAuthState(storage, accountId);

		// Create a test pre-key value
		const testValue = {
			keyPair: {
				public: Buffer.from("test-public-key"),
				private: Buffer.from("test-private-key"),
			},
			keyId: 42,
		};

		// Set signal key
		await state.keys.set({
			"pre-key": { "42": testValue },
		});

		// Get it back
		const result = await state.keys.get("pre-key", ["42"]);

		expect(result["42"]).toBeDefined();
		expect(result["42"].keyId).toBe(42);
		expect(
			Buffer.from(result["42"].keyPair.public).toString(),
		).toBe("test-public-key");
	});

	it("should return empty object for non-existent signal keys", async () => {
		const { state } = await useStorageAuthState(storage, accountId);

		const result = await state.keys.get("pre-key", ["nonexistent"]);

		expect(result).toEqual({});
	});

	it("should delete signal keys when value is null", async () => {
		const { state } = await useStorageAuthState(storage, accountId);

		const testValue = {
			keyPair: {
				public: Buffer.from("pub"),
				private: Buffer.from("priv"),
			},
			keyId: 1,
		};

		// Set then delete
		await state.keys.set({ "pre-key": { "1": testValue } });
		await state.keys.set({ "pre-key": { "1": null as any } });

		const result = await state.keys.get("pre-key", ["1"]);
		expect(result["1"]).toBeUndefined();
	});

	it("should isolate keys by accountId", async () => {
		const { state: s1 } = await useStorageAuthState(storage, "account-a");
		const { state: s2 } = await useStorageAuthState(storage, "account-b");

		const val = {
			keyPair: {
				public: Buffer.from("pub"),
				private: Buffer.from("priv"),
			},
			keyId: 1,
		};

		await s1.keys.set({ "pre-key": { "1": val } });

		// account-b should NOT see account-a's keys
		const result = await s2.keys.get("pre-key", ["1"]);
		expect(result["1"]).toBeUndefined();

		// account-a should still see its own
		const result2 = await s1.keys.get("pre-key", ["1"]);
		expect(result2["1"]).toBeDefined();
	});
});
