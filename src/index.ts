/**
 * WOPR WhatsApp Plugin - Baileys-based WhatsApp Web integration
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import winston from "winston";
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  WASocket,
  WAMessage,
  Contact,
  GroupMetadata,
  AnyMessageContent,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import type { 
  WOPRPlugin, 
  WOPRPluginContext, 
  ConfigSchema, 
  StreamMessage, 
  AgentIdentity,
  ChannelInfo,
  LogMessageOptions,
} from "./types.js";

// WhatsApp-specific types
interface WhatsAppMessage {
  id: string;
  from: string;
  fromMe: boolean;
  timestamp: number;
  text?: string;
  mediaUrl?: string;
  mediaType?: string;
  caption?: string;
  quotedMessage?: WhatsAppMessage;
  isGroup: boolean;
  groupName?: string;
  sender?: string;
  participant?: string;
}

interface WhatsAppConfig {
  accountId?: string;
  authDir?: string;
  dmPolicy?: "allowlist" | "blocklist" | "open" | "disabled";
  allowFrom?: string[];
  selfChatMode?: boolean;
  ownerNumber?: string;
  verbose?: boolean;
  pairingRequests?: Record<string, { code: string; name: string; requestedAt: number }>;
}

// Module-level state
let socket: WASocket | null = null;
let ctx: WOPRPluginContext | null = null;
let config: WhatsAppConfig = {};
let agentIdentity: AgentIdentity = { name: "WOPR", emoji: "👀" };
let contacts: Map<string, Contact> = new Map();
let groups: Map<string, GroupMetadata> = new Map();
let messageCache: Map<string, WhatsAppMessage> = new Map();
let logger: winston.Logger;

// Typing indicator refresh interval (composing status expires after ~10s in WhatsApp)
const TYPING_REFRESH_MS = 5000;

// Initialize winston logger
function initLogger(): winston.Logger {
  const WOPR_HOME = process.env.WOPR_HOME || path.join(process.env.HOME || "~", ".wopr");
  return winston.createLogger({
    level: "debug",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: { service: "wopr-plugin-whatsapp" },
    transports: [
      new winston.transports.File({ 
        filename: path.join(WOPR_HOME, "logs", "whatsapp-plugin-error.log"), 
        level: "error" 
      }),
      new winston.transports.File({ 
        filename: path.join(WOPR_HOME, "logs", "whatsapp-plugin.log"), 
        level: "debug" 
      }),
      new winston.transports.Console({ 
        format: winston.format.combine(
          winston.format.colorize(), 
          winston.format.simple()
        ), 
        level: "warn" 
      }),
    ],
  });
}

// Config schema for the plugin
const configSchema: ConfigSchema = {
  title: "WhatsApp Integration",
  description: "Configure WhatsApp Web integration using Baileys",
  fields: [
    { name: "accountId", type: "text", label: "Account ID", placeholder: "default", default: "default", description: "Unique identifier for this WhatsApp account" },
    { name: "dmPolicy", type: "select", label: "DM Policy", placeholder: "allowlist", default: "allowlist", description: "How to handle direct messages: allowlist, open, or disabled" },
    { name: "allowFrom", type: "array", label: "Allowed Numbers", placeholder: "+1234567890", description: "Phone numbers allowed to DM (E.164 format)" },
    { name: "selfChatMode", type: "boolean", label: "Self-Chat Mode", default: false, description: "Enable for personal phone numbers (prevents spamming contacts)" },
    { name: "ownerNumber", type: "text", label: "Owner Number", placeholder: "+1234567890", description: "Your phone number for self-chat mode" },
    { name: "verbose", type: "boolean", label: "Verbose Logging", default: false, description: "Enable detailed Baileys logging" },
    { name: "pairingRequests", type: "object", hidden: true, default: {} },
  ],
};

// Refresh identity from workspace
async function refreshIdentity(): Promise<void> {
  if (!ctx) return;
  try {
    const identity = await ctx.getAgentIdentity();
    if (identity) {
      agentIdentity = { ...agentIdentity, ...identity };
      logger.info("Identity refreshed:", agentIdentity.name);
    }
  } catch (e) {
    logger.warn("Failed to refresh identity:", String(e));
  }
}

function getAckReaction(): string {
  return agentIdentity.emoji?.trim() || "👀";
}

function getAuthDir(accountId: string): string {
  if (config.authDir) {
    return path.join(config.authDir, accountId);
  }
  return path.join(os.homedir(), ".wopr", "credentials", "whatsapp", accountId);
}

async function hasCredentials(accountId: string): Promise<boolean> {
  const authDir = getAuthDir(accountId);
  const credsPath = path.join(authDir, "creds.json");
  
  try {
    await fs.access(credsPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureAuthDir(accountId: string): Promise<void> {
  const authDir = getAuthDir(accountId);
  try {
    await fs.mkdir(authDir, { recursive: true });
  } catch {
    // Directory already exists
  }
}

// Helper to read creds.json safely
function readCredsJsonRaw(filePath: string): string | null {
  try {
    const fsSync = require("node:fs");
    if (!fsSync.existsSync(filePath)) return null;
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile() || stats.size <= 1) return null;
    return fsSync.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

// Maybe restore credentials from backup
function maybeRestoreCredsFromBackup(authDir: string): void {
  const credsPath = path.join(authDir, "creds.json");
  const backupPath = path.join(authDir, "creds.json.bak");
  
  try {
    const fsSync = require("node:fs");
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

// Get status code from disconnect error
function getStatusCode(err: any): number | undefined {
  return err?.output?.statusCode ?? err?.status;
}

// Convert phone number or JID to JID format
function toJid(phoneOrJid: string): string {
  if (phoneOrJid.includes("@")) {
    return phoneOrJid;
  }
  const normalized = phoneOrJid.replace(/[^0-9]/g, "");
  return `${normalized}@s.whatsapp.net`;
}

// Check if sender is allowed based on DM policy
function isAllowed(from: string, isGroup: boolean): boolean {
  if (isGroup) return true; // Groups are always allowed
  
  const policy = config.dmPolicy || "allowlist";
  
  switch (policy) {
    case "disabled":
      return false;
    case "open":
      return true;
    case "allowlist": {
      const allowed = config.allowFrom || [];
      if (allowed.includes("*")) return true;
      
      const phone = from.split("@")[0];
      return allowed.some(num => {
        const normalized = num.replace(/[^0-9]/g, "");
        return phone === normalized || phone.endsWith(normalized);
      });
    }
    default:
      return true;
  }
}

// Extract text from WhatsApp message
function extractText(msg: WAMessage): string | undefined {
  const content = msg.message;
  if (!content) return undefined;
  
  if (content.conversation) {
    return content.conversation;
  } else if (content.extendedTextMessage?.text) {
    return content.extendedTextMessage.text;
  } else if (content.imageMessage?.caption) {
    return content.imageMessage.caption;
  } else if (content.videoMessage?.caption) {
    return content.videoMessage.caption;
  } else if (content.documentMessage?.caption) {
    return content.documentMessage.caption;
  }
  return undefined;
}

// Process incoming message
function handleIncomingMessage(msg: WAMessage): void {
  if (!socket || !ctx) return;
  
  const messageId = msg.key.id || `${Date.now()}-${Math.random()}`;
  const from = msg.key.remoteJid || "";
  const fromMe = msg.key.fromMe || false;
  const timestamp = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now();
  const isGroup = from.endsWith("@g.us");
  const participant = msg.key.participant || undefined;
  
  // Skip messages from self
  if (fromMe) return;
  
  // Check DM policy
  if (!isAllowed(from, isGroup)) {
    logger.info(`Message from ${from} blocked by DM policy`);
    return;
  }
  
  const text = extractText(msg);
  
  // Get sender name
  let sender: string | undefined;
  if (participant) {
    const contact = contacts.get(participant);
    sender = contact?.notify || contact?.name || participant.split("@")[0];
  } else {
    const contact = contacts.get(from);
    sender = contact?.notify || contact?.name || from.split("@")[0];
  }
  
  // Get group name
  let groupName: string | undefined;
  if (isGroup) {
    const group = groups.get(from);
    groupName = group?.subject;
  }
  
  const waMessage: WhatsAppMessage = {
    id: messageId,
    from,
    fromMe,
    timestamp,
    text,
    isGroup,
    sender,
    groupName,
    participant,
  };
  
  // Cache for reaction handling
  messageCache.set(messageId, waMessage);
  
  // Create channel info
  const channelInfo: ChannelInfo = {
    type: "whatsapp",
    id: from,
    name: groupName || (isGroup ? "Group" : "WhatsApp DM"),
  };
  
  // Log message for context
  const logOptions: LogMessageOptions = {
    from: sender || from,
    channel: channelInfo,
  };
  
  const sessionKey = `whatsapp-${from}`;
  ctx.logMessage(sessionKey, text || "[media]", logOptions);
  
  // Send ack reaction
  sendReactionInternal(from, messageId, getAckReaction()).catch(() => {});
  
  // Check if bot is mentioned (for groups)
  if (isGroup && text) {
    // In WhatsApp, mentions are often implicit or via @phone
    // For now, treat all group messages as mentions
  }
  
  // Inject into WOPR for response
  injectMessage(waMessage, sessionKey);
}

// Send reaction internally
async function sendReactionInternal(chatJid: string, messageId: string, emoji: string): Promise<void> {
  if (!socket) return;
  
  await socket.sendMessage(chatJid, {
    react: {
      text: emoji,
      key: {
        remoteJid: chatJid,
        id: messageId,
        fromMe: false,
      },
    },
  });
}

// Start typing indicator with auto-refresh
function startTypingIndicator(jid: string): NodeJS.Timeout | null {
  if (!socket) return null;

  const sock = socket;
  // Send initial composing presence
  sock.sendPresenceUpdate("composing", jid).catch(() => {});

  // Refresh every TYPING_REFRESH_MS since WhatsApp composing status expires
  const interval = setInterval(() => {
    sock.sendPresenceUpdate("composing", jid).catch(() => {});
  }, TYPING_REFRESH_MS);

  return interval;
}

// Stop typing indicator
function stopTypingIndicator(jid: string, interval: NodeJS.Timeout | null): void {
  if (interval) {
    clearInterval(interval);
  }
  if (socket) {
    socket.sendPresenceUpdate("paused", jid).catch(() => {});
  }
}

// Inject message to WOPR
async function injectMessage(waMsg: WhatsAppMessage, sessionKey: string): Promise<void> {
  if (!ctx || !waMsg.text) return;

  const prefix = `[${waMsg.sender || "WhatsApp User"}]: `;
  const messageWithPrefix = prefix + waMsg.text;

  const channelInfo: ChannelInfo = {
    type: "whatsapp",
    id: waMsg.from,
    name: waMsg.groupName || (waMsg.isGroup ? "Group" : "WhatsApp DM"),
  };

  // Show typing indicator while processing
  const typingInterval = startTypingIndicator(waMsg.from);

  try {
    const response = await ctx.inject(sessionKey, messageWithPrefix, {
      from: waMsg.sender || waMsg.from,
      channel: channelInfo,
      onStream: (msg: StreamMessage) => handleStreamChunk(msg, waMsg),
    });

    // Send final response
    await sendMessageInternal(waMsg.from, response);
  } finally {
    stopTypingIndicator(waMsg.from, typingInterval);
  }
}

// Handle streaming response chunks
async function handleStreamChunk(msg: StreamMessage, waMsg: WhatsAppMessage): Promise<void> {
  // For WhatsApp, we accumulate and send at the end
  // Could implement chunked sending for long messages
}

// Send message to WhatsApp
async function sendMessageInternal(to: string, text: string): Promise<void> {
  if (!socket) {
    throw new Error("WhatsApp not connected");
  }
  
  const jid = toJid(to);
  
  // Chunk if needed (WhatsApp supports up to 4096 chars)
  const chunks = chunkMessage(text, 4000);
  
  for (const chunk of chunks) {
    const content: AnyMessageContent = { text: chunk };
    await socket.sendMessage(jid, content);
  }
}

function chunkMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  
  const chunks: string[] = [];
  let current = "";
  const sentences = text.split(/(?<=[.!?])\s+/);
  
  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 <= maxLength) {
      current += (current ? " " : "") + sentence;
    } else {
      if (current) chunks.push(current);
      current = sentence;
    }
  }
  
  if (current) chunks.push(current);
  return chunks;
}

// Create and start Baileys socket
async function createSocket(authDir: string, onQr?: (qr: string) => void): Promise<WASocket> {
  maybeRestoreCredsFromBackup(authDir);
  
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  
  // Create silent logger if not verbose
  const baileysLogger = config.verbose 
    ? require("pino")({ level: "info" })
    : require("pino")({ level: "silent" });
  
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
  
  // Handle connection updates
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr && onQr) {
      onQr(qr);
    }
    
    if (connection === "close") {
      const status = getStatusCode(lastDisconnect?.error);
      if (status === DisconnectReason.loggedOut) {
        logger.error("WhatsApp session logged out. Run: wopr channels login whatsapp");
      }
      socket = null;
    }
    
    if (connection === "open") {
      logger.info("WhatsApp Web connected");
    }
  });
  
  // Handle incoming messages
  sock.ev.on("messages.upsert", (m) => {
    if (m.type === "notify" || m.type === "append") {
      for (const msg of m.messages) {
        handleIncomingMessage(msg);
      }
    }
  });
  
  // Handle contacts
  sock.ev.on("contacts.upsert", (newContacts) => {
    for (const contact of newContacts) {
      contacts.set(contact.id, contact);
    }
  });
  
  // Handle groups
  sock.ev.on("groups.upsert", (newGroups) => {
    for (const group of newGroups) {
      groups.set(group.id, group);
    }
  });
  
  return sock;
}

// Login to WhatsApp
export async function login(): Promise<void> {
  if (socket) {
    throw new Error("Already logged in. Logout first if you want to re-link.");
  }
  
  const accountId = config.accountId || "default";
  const authDir = getAuthDir(accountId);
  
  await ensureAuthDir(accountId);
  
  console.log(`\n📱 WhatsApp Login for account: ${accountId}`);
  console.log("Scan the QR code with WhatsApp (Linked Devices) when it appears...\n");
  
  return new Promise((resolve, reject) => {
    createSocket(authDir, (qr: string) => {
      qrcode.generate(qr, { small: true });
    }).then((sock) => {
      socket = sock;
      
      // Wait for connection
      sock.ev.on("connection.update", (update) => {
        if (update.connection === "open") {
          console.log(`✅ WhatsApp connected (account: ${accountId})`);
          resolve();
        }
        if (update.connection === "close") {
          const status = getStatusCode(update.lastDisconnect?.error);
          reject(new Error(`Connection closed (status: ${status})`));
        }
      });
    }).catch(reject);
  });
}

// Logout from WhatsApp
export async function logout(): Promise<void> {
  const accountId = config.accountId || "default";
  
  if (socket) {
    await socket.logout();
    socket = null;
  }
  
  // Clear credentials
  const authDir = getAuthDir(accountId);
  try {
    await fs.rm(authDir, { recursive: true, force: true });
  } catch {
    // Ignore errors
  }
  
  console.log(`✅ Logged out from WhatsApp (account: ${accountId})`);
}

// Start the WhatsApp session (called from init if credentials exist)
async function startSession(): Promise<void> {
  const accountId = config.accountId || "default";
  const authDir = getAuthDir(accountId);
  
  socket = await createSocket(authDir);
}

// Plugin definition
const plugin: WOPRPlugin = {
  name: "whatsapp",
  version: "1.0.0",
  description: "WhatsApp integration using Baileys (WhatsApp Web)",
  
  async init(context: WOPRPluginContext): Promise<void> {
    ctx = context;
    config = (context.getConfig() || {}) as WhatsAppConfig;
    
    // Initialize logger first (before any logging)
    logger = initLogger();
    
    // Register config schema
    ctx.registerConfigSchema("whatsapp", configSchema);
    
    // Refresh identity
    await refreshIdentity();
    
    // Ensure auth directory exists
    const accountId = config.accountId || "default";
    await ensureAuthDir(accountId);
    
    // Start session if credentials exist
    if (await hasCredentials(accountId)) {
      logger.info("Found existing credentials, starting session...");
      await startSession();
    } else {
      logger.info("No credentials found. Run 'wopr channels login whatsapp' to connect.");
    }
  },
  
  async shutdown(): Promise<void> {
    if (socket) {
      await socket.logout();
      socket = null;
    }
    ctx = null;
  },
};

export default plugin;
