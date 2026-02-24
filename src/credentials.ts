/**
 * WhatsApp credential management — auth dir helpers, migration.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BufferJSON } from "@whiskeysockets/baileys";
import { logger } from "./logger.js";
import type { PluginStorageAPI } from "./storage.js";
import { WHATSAPP_CREDS_TABLE, WHATSAPP_KEYS_TABLE } from "./storage.js";
import type { WhatsAppConfig } from "./types.js";

let _getConfig: () => WhatsAppConfig = () => ({}) as WhatsAppConfig;
let _getStorage: () => PluginStorageAPI | null = () => null;

export function initCredentials(
	getConfig: () => WhatsAppConfig,
	getStorage: () => PluginStorageAPI | null,
): void {
	_getConfig = getConfig;
	_getStorage = getStorage;
}

export function getAuthDir(accountId: string): string {
	const config = _getConfig();
	if (config.authDir) {
		return path.join(config.authDir, accountId);
	}
	return path.join(os.homedir(), ".wopr", "credentials", "whatsapp", accountId);
}

export async function hasCredentials(accountId: string): Promise<boolean> {
	const storage = _getStorage();
	// Check Storage API first
	if (storage) {
		try {
			const val = await storage.get(WHATSAPP_CREDS_TABLE, accountId);
			if (val != null) return true;
		} catch {
			// Storage failed, fall through to filesystem
		}
	}

	// Fallback: check filesystem
	const authDir = getAuthDir(accountId);
	const credsPath = path.join(authDir, "creds.json");

	try {
		await fs.access(credsPath);
		return true;
	} catch {
		return false;
	}
}

export async function ensureAuthDir(accountId: string): Promise<void> {
	const authDir = getAuthDir(accountId);
	try {
		await fs.mkdir(authDir, { recursive: true });
	} catch {
		// Directory already exists
	}
}

// Helper to read creds.json safely
export function readCredsJsonRaw(filePath: string): string | null {
	try {
		if (!fsSync.existsSync(filePath)) return null;
		const stats = fsSync.statSync(filePath);
		if (!stats.isFile() || stats.size <= 1) return null;
		return fsSync.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

// Maybe restore credentials from backup
export function maybeRestoreCredsFromBackup(authDir: string): void {
	const credsPath = path.join(authDir, "creds.json");
	const backupPath = path.join(authDir, "creds.json.bak");

	try {
		if (!fsSync.existsSync(credsPath) && fsSync.existsSync(backupPath)) {
			const raw = readCredsJsonRaw(backupPath);
			if (raw) {
				try {
					JSON.parse(raw); // Validate
					fsSync.copyFileSync(backupPath, credsPath);
					logger.info("Restored credentials from backup");
				} catch {
					// Invalid backup
				}
			}
		}
	} catch {
		// Ignore
	}
}

/**
 * Migrate legacy filesystem-based auth state into the Storage API.
 * Runs once per account — if creds already exist in storage, it's a no-op.
 * After successful migration, renames the legacy dir to `.migrated`.
 */
export async function maybeRunMigration(accountId: string): Promise<void> {
	const storage = _getStorage();
	if (!storage) return;

	// Skip if storage already has creds for this account
	const existing = await storage.get(WHATSAPP_CREDS_TABLE, accountId);
	if (existing != null) return;

	const authDir = getAuthDir(accountId);
	const credsPath = path.join(authDir, "creds.json");

	const credsRaw = readCredsJsonRaw(credsPath);
	if (!credsRaw) return; // No legacy creds to migrate

	try {
		const creds = JSON.parse(credsRaw);

		// Migrate signal key files FIRST (anything that isn't creds.json or .bak)
		// Keys are migrated before creds so creds acts as the "migration complete" marker.
		// If we crash before writing creds, migration will re-run safely on next startup.
		const entries = await fs.readdir(authDir);
		for (const entry of entries) {
			if (entry === "creds.json" || entry === "creds.json.bak") continue;
			const filePath = path.join(authDir, entry);
			try {
				const stat = await fs.stat(filePath);
				if (!stat.isFile()) continue;
				const raw = await fs.readFile(filePath, "utf-8");
				const value = JSON.parse(raw);
				// Serialize through BufferJSON to preserve Buffer instances
				const serializedValue = JSON.parse(
					JSON.stringify(value, BufferJSON.replacer),
				);
				// Key files are typically named like "pre-key-1.json"
				const keyName = entry.replace(/\.json$/, "");
				const storageKey = `${accountId}:${keyName}`;
				await storage.put(WHATSAPP_KEYS_TABLE, storageKey, serializedValue);
			} catch {
				// Skip files that can't be parsed
			}
		}

		// Write creds LAST — this is the "migration complete" marker.
		// If we crash before this point, migration will re-run on next startup
		// and re-migrate any keys that were successfully written, which is safe.
		const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
		await storage.put(WHATSAPP_CREDS_TABLE, accountId, serialized);
		logger.info(`Migrated creds for account ${accountId} to Storage API`);

		// Rename legacy dir to mark migration complete; fall back to removal
		const migratedDir = `${authDir}.migrated`;
		try {
			await fs.rename(authDir, migratedDir);
			logger.info(`Renamed legacy auth dir to ${migratedDir}`);
		} catch {
			logger.warn(`Could not rename legacy auth dir, removing instead`);
			try {
				await fs.rm(authDir, { recursive: true, force: true });
			} catch (rmErr) {
				logger.warn(
					`Could not remove legacy auth dir ${authDir}: ${String(rmErr)}`,
				);
			}
		}
	} catch (err) {
		logger.error(`Migration failed for account ${accountId}: ${String(err)}`);
	}
}
