"use strict";
/**
 * WOPR WhatsApp Plugin - Baileys-based WhatsApp Web integration
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.login = login;
exports.logout = logout;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const baileys_1 = require("@whiskeysockets/baileys");
const qrcode_terminal_1 = __importDefault(require("qrcode-terminal"));
const winston_1 = __importDefault(require("winston"));
const sessionStates = new Map();
function getSessionState(sessionKey) {
    if (!sessionStates.has(sessionKey)) {
        sessionStates.set(sessionKey, {
            thinkingLevel: "medium",
            messageCount: 0,
            model: "claude-sonnet-4-20250514",
        });
    }
    return sessionStates.get(sessionKey);
}
// Module-level state
let socket = null;
let ctx = null;
let config = {};
let agentIdentity = { name: "WOPR", emoji: "👀" };
const contacts = new Map();
const groups = new Map();
const messageCache = new Map();
let logger;
// Initialize winston logger
function initLogger() {
    const WOPR_HOME = process.env.WOPR_HOME || node_path_1.default.join(process.env.HOME || "~", ".wopr");
    return winston_1.default.createLogger({
        level: "debug",
        format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.errors({ stack: true }), winston_1.default.format.json()),
        defaultMeta: { service: "wopr-plugin-whatsapp" },
        transports: [
            new winston_1.default.transports.File({
                filename: node_path_1.default.join(WOPR_HOME, "logs", "whatsapp-plugin-error.log"),
                level: "error",
            }),
            new winston_1.default.transports.File({
                filename: node_path_1.default.join(WOPR_HOME, "logs", "whatsapp-plugin.log"),
                level: "debug",
            }),
            new winston_1.default.transports.Console({
                format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple()),
                level: "warn",
            }),
        ],
    });
}
// Config schema for the plugin
const configSchema = {
    title: "WhatsApp Integration",
    description: "Configure WhatsApp Web integration using Baileys",
    fields: [
        {
            name: "accountId",
            type: "text",
            label: "Account ID",
            placeholder: "default",
            default: "default",
            description: "Unique identifier for this WhatsApp account",
        },
        {
            name: "dmPolicy",
            type: "select",
            label: "DM Policy",
            placeholder: "allowlist",
            default: "allowlist",
            description: "How to handle direct messages: allowlist, open, or disabled",
        },
        {
            name: "allowFrom",
            type: "array",
            label: "Allowed Numbers",
            placeholder: "+1234567890",
            description: "Phone numbers allowed to DM (E.164 format)",
        },
        {
            name: "selfChatMode",
            type: "boolean",
            label: "Self-Chat Mode",
            default: false,
            description: "Enable for personal phone numbers (prevents spamming contacts)",
        },
        {
            name: "ownerNumber",
            type: "text",
            label: "Owner Number",
            placeholder: "+1234567890",
            description: "Your phone number for self-chat mode",
        },
        {
            name: "verbose",
            type: "boolean",
            label: "Verbose Logging",
            default: false,
            description: "Enable detailed Baileys logging",
        },
        { name: "pairingRequests", type: "object", hidden: true, default: {} },
    ],
};
// Refresh identity from workspace
async function refreshIdentity() {
    if (!ctx)
        return;
    try {
        const identity = await ctx.getAgentIdentity();
        if (identity) {
            agentIdentity = { ...agentIdentity, ...identity };
            logger.info("Identity refreshed:", agentIdentity.name);
        }
    }
    catch (e) {
        logger.warn("Failed to refresh identity:", String(e));
    }
}
function getAckReaction() {
    return agentIdentity.emoji?.trim() || "👀";
}
function getAuthDir(accountId) {
    if (config.authDir) {
        return node_path_1.default.join(config.authDir, accountId);
    }
    return node_path_1.default.join(node_os_1.default.homedir(), ".wopr", "credentials", "whatsapp", accountId);
}
async function hasCredentials(accountId) {
    const authDir = getAuthDir(accountId);
    const credsPath = node_path_1.default.join(authDir, "creds.json");
    try {
        await promises_1.default.access(credsPath);
        return true;
    }
    catch {
        return false;
    }
}
async function ensureAuthDir(accountId) {
    const authDir = getAuthDir(accountId);
    try {
        await promises_1.default.mkdir(authDir, { recursive: true });
    }
    catch {
        // Directory already exists
    }
}
// Helper to read creds.json safely
function readCredsJsonRaw(filePath) {
    try {
        const fsSync = require("node:fs");
        if (!fsSync.existsSync(filePath))
            return null;
        const stats = fsSync.statSync(filePath);
        if (!stats.isFile() || stats.size <= 1)
            return null;
        return fsSync.readFileSync(filePath, "utf-8");
    }
    catch {
        return null;
    }
}
// Maybe restore credentials from backup
function maybeRestoreCredsFromBackup(authDir) {
    const credsPath = node_path_1.default.join(authDir, "creds.json");
    const backupPath = node_path_1.default.join(authDir, "creds.json.bak");
    try {
        const fsSync = require("node:fs");
        if (!fsSync.existsSync(credsPath) && fsSync.existsSync(backupPath)) {
            const raw = readCredsJsonRaw(backupPath);
            if (raw) {
                try {
                    JSON.parse(raw); // Validate
                    fsSync.copyFileSync(backupPath, credsPath);
                    logger.info("Restored credentials from backup");
                }
                catch {
                    // Invalid backup
                }
            }
        }
    }
    catch {
        // Ignore
    }
}
// Get status code from disconnect error
function getStatusCode(err) {
    return err?.output?.statusCode ?? err?.status;
}
// Convert phone number or JID to JID format
function toJid(phoneOrJid) {
    if (phoneOrJid.includes("@")) {
        return phoneOrJid;
    }
    const normalized = phoneOrJid.replace(/[^0-9]/g, "");
    return `${normalized}@s.whatsapp.net`;
}
// Check if sender is allowed based on DM policy
function isAllowed(from, isGroup) {
    if (isGroup)
        return true; // Groups are always allowed
    const policy = config.dmPolicy || "allowlist";
    switch (policy) {
        case "disabled":
            return false;
        case "open":
            return true;
        case "allowlist": {
            const allowed = config.allowFrom || [];
            if (allowed.includes("*"))
                return true;
            const phone = from.split("@")[0];
            return allowed.some((num) => {
                const normalized = num.replace(/[^0-9]/g, "");
                return phone === normalized || phone.endsWith(normalized);
            });
        }
        default:
            return true;
    }
}
// Extract text from WhatsApp message
function extractText(msg) {
    const content = msg.message;
    if (!content)
        return undefined;
    if (content.conversation) {
        return content.conversation;
    }
    else if (content.extendedTextMessage?.text) {
        return content.extendedTextMessage.text;
    }
    else if (content.imageMessage?.caption) {
        return content.imageMessage.caption;
    }
    else if (content.videoMessage?.caption) {
        return content.videoMessage.caption;
    }
    else if (content.documentMessage?.caption) {
        return content.documentMessage.caption;
    }
    return undefined;
}
// Process incoming message
function handleIncomingMessage(msg) {
    if (!socket || !ctx)
        return;
    const messageId = msg.key.id || `${Date.now()}-${Math.random()}`;
    const from = msg.key.remoteJid || "";
    const fromMe = msg.key.fromMe || false;
    const timestamp = msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : Date.now();
    const isGroup = from.endsWith("@g.us");
    const participant = msg.key.participant || undefined;
    // Skip messages from self
    if (fromMe)
        return;
    // Check DM policy
    if (!isAllowed(from, isGroup)) {
        logger.info(`Message from ${from} blocked by DM policy`);
        return;
    }
    const text = extractText(msg);
    // Get sender name
    let sender;
    if (participant) {
        const contact = contacts.get(participant);
        sender = contact?.notify || contact?.name || participant.split("@")[0];
    }
    else {
        const contact = contacts.get(from);
        sender = contact?.notify || contact?.name || from.split("@")[0];
    }
    // Get group name
    let groupName;
    if (isGroup) {
        const group = groups.get(from);
        groupName = group?.subject;
    }
    const waMessage = {
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
    const channelInfo = {
        type: "whatsapp",
        id: from,
        name: groupName || (isGroup ? "Group" : "WhatsApp DM"),
    };
    // Log message for context
    const logOptions = {
        from: sender || from,
        channel: channelInfo,
    };
    const sessionKey = `whatsapp-${from}`;
    ctx.logMessage(sessionKey, text || "[media]", logOptions);
    // Send ack reaction
    sendReactionInternal(from, messageId, getAckReaction()).catch(() => { });
    // Check for !command prefix before injecting
    if (text) {
        handleTextCommand(waMessage, sessionKey)
            .then((handled) => {
            if (!handled) {
                // Not a command — track message count and inject into WOPR
                const state = getSessionState(sessionKey);
                state.messageCount++;
                injectMessage(waMessage, sessionKey);
            }
        })
            .catch((e) => {
            logger.error(`Command handler error: ${e}`);
            injectMessage(waMessage, sessionKey);
        });
        return;
    }
    // No text (media only) — inject as-is
    injectMessage(waMessage, sessionKey);
}
// Send reaction internally
async function sendReactionInternal(chatJid, messageId, emoji) {
    if (!socket)
        return;
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
// Parse a !command from message text. Returns null if not a command.
function parseCommand(text) {
    const match = text.match(/^!(\w+)(?:\s+(.*))?$/s);
    if (!match)
        return null;
    return { name: match[1].toLowerCase(), args: (match[2] || "").trim() };
}
// Handle text commands (!status, !new, !model, etc.)
// Returns true if the message was handled as a command.
async function handleTextCommand(waMsg, sessionKey) {
    if (!ctx || !waMsg.text)
        return false;
    const cmd = parseCommand(waMsg.text);
    if (!cmd)
        return false;
    const state = getSessionState(sessionKey);
    logger.info(`Command received: !${cmd.name} from ${waMsg.sender || waMsg.from}`);
    switch (cmd.name) {
        case "status": {
            const response = `*Session Status*\n\n` +
                `*Session:* ${sessionKey}\n` +
                `*Thinking Level:* ${state.thinkingLevel}\n` +
                `*Model:* ${state.model}\n` +
                `*Messages:* ${state.messageCount}`;
            await sendMessageInternal(waMsg.from, response);
            return true;
        }
        case "new":
        case "reset": {
            sessionStates.delete(sessionKey);
            await sendMessageInternal(waMsg.from, "*Session Reset*\n\nStarting fresh! Your conversation history has been cleared.");
            return true;
        }
        case "compact": {
            await sendMessageInternal(waMsg.from, "*Compacting Session*\n\nTriggering context compaction...");
            try {
                const result = await ctx.inject(sessionKey, "/compact", {
                    silent: true,
                });
                await sendMessageInternal(waMsg.from, `*Session Compacted*\n\n${result || "Context has been compacted."}`);
            }
            catch {
                await sendMessageInternal(waMsg.from, "Failed to compact session.");
            }
            return true;
        }
        case "think": {
            const validLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
            const level = cmd.args.toLowerCase();
            if (!level || !validLevels.includes(level)) {
                await sendMessageInternal(waMsg.from, `*Thinking Level*\n\nCurrent: ${state.thinkingLevel}\n\nUsage: !think <level>\nLevels: ${validLevels.join(", ")}`);
                return true;
            }
            state.thinkingLevel = level;
            await sendMessageInternal(waMsg.from, `*Thinking level set to:* ${level}`);
            return true;
        }
        case "model": {
            if (!cmd.args) {
                await sendMessageInternal(waMsg.from, `*Current Model:* ${state.model}\n\nUsage: !model <name>\nExamples: !model opus, !model haiku, !model sonnet`);
                return true;
            }
            const modelChoice = cmd.args.toLowerCase();
            // Use ctx.setSessionProvider if available, otherwise just track locally
            const ctxAny = ctx;
            if (ctxAny.setSessionProvider) {
                try {
                    // Try to resolve model via provider registry (same as Discord plugin)
                    const providerIds = [
                        "anthropic",
                        "openai",
                        "kimi",
                        "opencode",
                        "codex",
                    ];
                    let resolved = null;
                    for (const pid of providerIds) {
                        const provider = ctxAny.getProvider?.(pid);
                        if (!provider?.supportedModels)
                            continue;
                        for (const modelId of provider.supportedModels) {
                            if (modelId === modelChoice || modelId.includes(modelChoice)) {
                                resolved = { provider: pid, id: modelId, name: modelId };
                                break;
                            }
                        }
                        if (resolved)
                            break;
                    }
                    if (!resolved) {
                        await sendMessageInternal(waMsg.from, `Unknown model: ${modelChoice}\n\nTry: opus, haiku, sonnet, gpt`);
                        return true;
                    }
                    await ctxAny.setSessionProvider(sessionKey, resolved.provider, {
                        model: resolved.id,
                    });
                    state.model = resolved.id;
                    await sendMessageInternal(waMsg.from, `*Model switched to:* ${resolved.id}`);
                }
                catch (e) {
                    await sendMessageInternal(waMsg.from, `Failed to switch model: ${e}`);
                }
            }
            else {
                // Fallback: just store the preference locally
                state.model = modelChoice;
                await sendMessageInternal(waMsg.from, `*Model preference set to:* ${modelChoice}\n\n(Note: model switching requires WOPR core support)`);
            }
            return true;
        }
        case "session": {
            if (!cmd.args) {
                await sendMessageInternal(waMsg.from, `*Current Session:* ${sessionKey}\n\nUsage: !session <name>`);
                return true;
            }
            // Session switching is handled by changing the session key for future messages.
            // We inform the user but note that WhatsApp sessions are keyed by chat JID,
            // so named sub-sessions would require more infrastructure.
            const newKey = `${sessionKey}/${cmd.args}`;
            await sendMessageInternal(waMsg.from, `*Switched to session:* ${newKey}\n\nNote: Each session maintains separate context.`);
            return true;
        }
        case "cancel": {
            const ctxAny2 = ctx;
            let cancelled = false;
            if (ctxAny2.cancelInject) {
                cancelled = ctxAny2.cancelInject(sessionKey);
            }
            if (cancelled) {
                await sendMessageInternal(waMsg.from, "*Cancelled*\n\nThe current response has been stopped.");
            }
            else {
                await sendMessageInternal(waMsg.from, "Nothing to cancel. No response is currently in progress.");
            }
            return true;
        }
        case "help": {
            const helpText = `*${agentIdentity.name || "WOPR"} WhatsApp Commands*\n\n` +
                `*!status* - Show session status\n` +
                `*!new* or *!reset* - Start fresh session\n` +
                `*!compact* - Summarize conversation\n` +
                `*!think <level>* - Set thinking level (off/minimal/low/medium/high/xhigh)\n` +
                `*!model <model>* - Switch AI model (sonnet/opus/haiku)\n` +
                `*!cancel* - Stop the current AI response\n` +
                `*!session <name>* - Switch to named session\n` +
                `*!help* - Show this help\n\n` +
                `Send any other message to chat with ${agentIdentity.name || "WOPR"}!`;
            await sendMessageInternal(waMsg.from, helpText);
            return true;
        }
        default:
            // Not a recognized command, treat as normal message
            return false;
    }
}
// Inject message to WOPR
async function injectMessage(waMsg, sessionKey) {
    if (!ctx || !waMsg.text)
        return;
    const state = getSessionState(sessionKey);
    const prefix = `[${waMsg.sender || "WhatsApp User"}]: `;
    let messageContent = waMsg.text;
    // Prepend thinking level if not default (mirrors Discord plugin behavior)
    if (state.thinkingLevel !== "medium") {
        messageContent = `[Thinking level: ${state.thinkingLevel}] ${messageContent}`;
    }
    const messageWithPrefix = prefix + messageContent;
    const channelInfo = {
        type: "whatsapp",
        id: waMsg.from,
        name: waMsg.groupName || (waMsg.isGroup ? "Group" : "WhatsApp DM"),
    };
    const response = await ctx.inject(sessionKey, messageWithPrefix, {
        from: waMsg.sender || waMsg.from,
        channel: channelInfo,
        onStream: (msg) => handleStreamChunk(msg, waMsg),
    });
    // Send final response
    await sendMessageInternal(waMsg.from, response);
}
// Handle streaming response chunks
async function handleStreamChunk(msg, waMsg) {
    // For WhatsApp, we accumulate and send at the end
    // Could implement chunked sending for long messages
}
// Send message to WhatsApp
async function sendMessageInternal(to, text) {
    if (!socket) {
        throw new Error("WhatsApp not connected");
    }
    const jid = toJid(to);
    // Chunk if needed (WhatsApp supports up to 4096 chars)
    const chunks = chunkMessage(text, 4000);
    for (const chunk of chunks) {
        const content = { text: chunk };
        await socket.sendMessage(jid, content);
    }
}
function chunkMessage(text, maxLength) {
    if (text.length <= maxLength)
        return [text];
    const chunks = [];
    let current = "";
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
        if (current.length + sentence.length + 1 <= maxLength) {
            current += (current ? " " : "") + sentence;
        }
        else {
            if (current)
                chunks.push(current);
            current = sentence;
        }
    }
    if (current)
        chunks.push(current);
    return chunks;
}
// Create and start Baileys socket
async function createSocket(authDir, onQr) {
    maybeRestoreCredsFromBackup(authDir);
    const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(authDir);
    const { version } = await (0, baileys_1.fetchLatestBaileysVersion)();
    // Create silent logger if not verbose
    const baileysLogger = config.verbose
        ? require("pino")({ level: "info" })
        : require("pino")({ level: "silent" });
    const sock = (0, baileys_1.makeWASocket)({
        auth: {
            creds: state.creds,
            keys: (0, baileys_1.makeCacheableSignalKeyStore)(state.keys, baileysLogger),
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
        saveQueue = saveQueue.then(() => saveCreds()).catch(() => { });
    });
    // Handle connection updates
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && onQr) {
            onQr(qr);
        }
        if (connection === "close") {
            const status = getStatusCode(lastDisconnect?.error);
            if (status === baileys_1.DisconnectReason.loggedOut) {
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
async function login() {
    if (socket) {
        throw new Error("Already logged in. Logout first if you want to re-link.");
    }
    const accountId = config.accountId || "default";
    const authDir = getAuthDir(accountId);
    await ensureAuthDir(accountId);
    console.log(`\n📱 WhatsApp Login for account: ${accountId}`);
    console.log("Scan the QR code with WhatsApp (Linked Devices) when it appears...\n");
    return new Promise((resolve, reject) => {
        createSocket(authDir, (qr) => {
            qrcode_terminal_1.default.generate(qr, { small: true });
        })
            .then((sock) => {
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
        })
            .catch(reject);
    });
}
// Logout from WhatsApp
async function logout() {
    const accountId = config.accountId || "default";
    if (socket) {
        await socket.logout();
        socket = null;
    }
    // Clear credentials
    const authDir = getAuthDir(accountId);
    try {
        await promises_1.default.rm(authDir, { recursive: true, force: true });
    }
    catch {
        // Ignore errors
    }
    console.log(`✅ Logged out from WhatsApp (account: ${accountId})`);
}
// Start the WhatsApp session (called from init if credentials exist)
async function startSession() {
    const accountId = config.accountId || "default";
    const authDir = getAuthDir(accountId);
    socket = await createSocket(authDir);
}
// Plugin definition
const plugin = {
    name: "whatsapp",
    version: "1.0.0",
    description: "WhatsApp integration using Baileys (WhatsApp Web)",
    async init(context) {
        ctx = context;
        config = (context.getConfig() || {});
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
        }
        else {
            logger.info("No credentials found. Run 'wopr channels login whatsapp' to connect.");
        }
    },
    async shutdown() {
        if (socket) {
            await socket.logout();
            socket = null;
        }
        ctx = null;
    },
};
exports.default = plugin;
//# sourceMappingURL=index.js.map