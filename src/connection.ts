/**
 * WhatsApp connection management — socket creation, login, logout.
 */
import fs from "node:fs/promises";
import {
	type Contact,
	DisconnectReason,
	fetchLatestBaileysVersion,
	type GroupMetadata,
	makeCacheableSignalKeyStore,
	makeWASocket,
	useMultiFileAuthState,
	type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { useStorageAuthState } from "./auth-state.js";
import { getRegisteredParsers } from "./channel-provider.js";
import {
	ensureAuthDir,
	getAuthDir,
	maybeRestoreCredsFromBackup,
	maybeRunMigration,
} from "./credentials.js";
import { logger } from "./logger.js";
import { contacts, groups, handleIncomingMessage } from "./message-handler.js";
import type { PluginStorageAPI } from "./storage.js";
import { WHATSAPP_CREDS_TABLE, WHATSAPP_KEYS_TABLE } from "./storage.js";
import type { WhatsAppConfig } from "./types.js";
import { clearAllTypingIntervals } from "./typing.js";

let _getConfig: () => WhatsAppConfig = () => ({}) as WhatsAppConfig;
let _getStorage: () => PluginStorageAPI | null = () => null;
let _setSocket: (s: WASocket | null) => void = () => {};
let _setConnectTime: (t: number | null) => void = () => {};

const cleanups: Array<() => void | Promise<void>> = [];

export function initConnection(deps: {
	getConfig: () => WhatsAppConfig;
	getStorage: () => PluginStorageAPI | null;
	setSocket: (s: WASocket | null) => void;
	setConnectTime: (t: number | null) => void;
}): void {
	_getConfig = deps.getConfig;
	_getStorage = deps.getStorage;
	_setSocket = deps.setSocket;
	_setConnectTime = deps.setConnectTime;
}

export function getCleanups(): Array<() => void | Promise<void>> {
	return cleanups;
}

// Get status code from disconnect error
export function getStatusCode(err: unknown): number | undefined {
	const e = err as { output?: { statusCode?: number }; status?: number };
	return e?.output?.statusCode ?? e?.status;
}

// Create and start Baileys socket
export async function createSocket(
	accountId: string,
	onQr?: (qr: string) => void,
): Promise<WASocket> {
	const config = _getConfig();
	const storage = _getStorage();
	let state: import("@whiskeysockets/baileys").AuthenticationState;
	let saveCreds: () => Promise<void>;

	if (storage) {
		// Use Storage API-backed auth state (with migration from filesystem)
		await maybeRunMigration(accountId);
		const result = await useStorageAuthState(storage, accountId);
		state = result.state;
		saveCreds = result.saveCreds;
	} else {
		// Fallback: filesystem-based auth state
		const authDir = getAuthDir(accountId);
		maybeRestoreCredsFromBackup(authDir);
		const result = await useMultiFileAuthState(authDir);
		state = result.state;
		saveCreds = result.saveCreds;
	}

	const { version } = await fetchLatestBaileysVersion();

	// Create silent logger if not verbose
	const baileysLogger = config.verbose
		? pino({ level: "info" })
		: pino({ level: "silent" });

	const sock = makeWASocket({
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
		},
		version,
		logger: baileysLogger,
		printQRInTerminal: false,
		browser: ["WOPR", "CLI", "1.0.0"],
		syncFullHistory: false,
		markOnlineOnConnect: false,
	});

	// Handle credentials update
	let saveQueue = Promise.resolve();
	sock.ev.on("creds.update", () => {
		saveQueue = saveQueue.then(() => saveCreds()).catch(() => {});
	});
	cleanups.push(() => sock.ev.removeAllListeners("creds.update"));

	// Handle connection updates
	sock.ev.on("connection.update", (update) => {
		const { connection, lastDisconnect, qr } = update;

		if (qr && onQr) {
			onQr(qr);
		}

		if (connection === "close") {
			const status = getStatusCode(lastDisconnect?.error);
			if (status === DisconnectReason.loggedOut) {
				logger.error(
					"WhatsApp session logged out. Run: wopr channels login whatsapp",
				);
			}
			clearAllTypingIntervals();
			_setSocket(null);
			_setConnectTime(null);
		}

		if (connection === "open") {
			logger.info("WhatsApp Web connected");
			_setConnectTime(Date.now());
		}
	});
	cleanups.push(() => sock.ev.removeAllListeners("connection.update"));

	// Handle incoming messages
	sock.ev.on("messages.upsert", (m) => {
		if (m.type === "notify" || m.type === "append") {
			for (const msg of m.messages) {
				handleIncomingMessage(
					msg,
					getRegisteredParsers() as Map<
						string,
						{
							id: string;
							pattern: RegExp | ((text: string) => boolean);
							handler: (ctx: unknown) => Promise<void>;
						}
					>,
				);
			}
		}
	});
	cleanups.push(() => sock.ev.removeAllListeners("messages.upsert"));

	// Handle contacts
	sock.ev.on("contacts.upsert", (newContacts: Contact[]) => {
		for (const contact of newContacts) {
			contacts.set(contact.id, contact);
		}
	});
	cleanups.push(() => sock.ev.removeAllListeners("contacts.upsert"));

	// Handle groups
	sock.ev.on("groups.upsert", (newGroups: GroupMetadata[]) => {
		for (const group of newGroups) {
			groups.set(group.id, group);
		}
	});
	cleanups.push(() => sock.ev.removeAllListeners("groups.upsert"));

	return sock;
}

// Login to WhatsApp
export async function login(
	socket: WASocket | null,
	setSocket: (s: WASocket | null) => void,
): Promise<void> {
	if (socket) {
		throw new Error("Already logged in. Logout first if you want to re-link.");
	}

	const config = _getConfig();
	const storage = _getStorage();
	const accountId = config.accountId || "default";

	// Ensure filesystem auth dir exists (needed for fallback mode)
	if (!storage) {
		await ensureAuthDir(accountId);
	}

	// Use console directly — login() runs before init(), so ctx is null and
	// getLogger() returns the noop logger. CLI users need to see this output.
	console.log(`WhatsApp Login for account: ${accountId}`);
	console.log(
		"Scan the QR code with WhatsApp (Linked Devices) when it appears",
	);

	return new Promise((resolve, reject) => {
		createSocket(accountId, (qr: string) => {
			qrcode.generate(qr, { small: true });
		})
			.then((sock) => {
				setSocket(sock);

				// Wait for connection
				sock.ev.on("connection.update", (update) => {
					if (update.connection === "open") {
						console.log(`WhatsApp connected (account: ${accountId})`);
						resolve();
					}
					if (update.connection === "close") {
						const status = getStatusCode(update.lastDisconnect?.error);
						reject(new Error(`Connection closed (status: ${status})`));
					}
				});
			})
			.catch(reject);
	});
}

// Logout from WhatsApp
export async function logout(
	socket: WASocket | null,
	setSocket: (s: WASocket | null) => void,
): Promise<void> {
	const config = _getConfig();
	const storage = _getStorage();
	const accountId = config.accountId || "default";

	clearAllTypingIntervals();

	if (socket) {
		await socket.logout();
		setSocket(null);
	}

	// Clear credentials from Storage API
	if (storage) {
		try {
			await storage.delete(WHATSAPP_CREDS_TABLE, accountId);
			// Clean up all signal keys for this account
			const allKeys = await storage.list(WHATSAPP_KEYS_TABLE);
			const prefix = `${accountId}:`;
			for (const entry of allKeys) {
				const key = (entry as { key?: string })?.key;
				if (key?.startsWith(prefix)) {
					await storage.delete(WHATSAPP_KEYS_TABLE, key);
				}
			}
		} catch (err) {
			logger.warn(`Failed to clear storage on logout: ${String(err)}`);
		}
	}

	// Clear legacy filesystem credentials
	const authDir = getAuthDir(accountId);
	try {
		await fs.rm(authDir, { recursive: true, force: true });
	} catch {
		// Ignore errors
	}

	// Use console directly — logout() runs before/after init(), ctx may be null.
	console.log(`Logged out from WhatsApp (account: ${accountId})`);
}

// Start the WhatsApp session (called from init if credentials exist)
export async function startSession(
	setSocket: (s: WASocket | null) => void,
): Promise<void> {
	const config = _getConfig();
	const accountId = config.accountId || "default";
	const sock = await createSocket(accountId);
	setSocket(sock);
}

export function clearCleanups(): void {
	cleanups.length = 0;
}
