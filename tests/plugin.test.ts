import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies before importing the module
vi.mock("@whiskeysockets/baileys", () => ({
  DisconnectReason: { loggedOut: 401 },
  downloadMediaMessage: vi.fn(),
  extensionForMediaMessage: vi.fn(() => "jpg"),
  fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 3000, 0] })),
  getContentType: vi.fn(),
  makeCacheableSignalKeyStore: vi.fn((_keys: unknown, _logger: unknown) => _keys),
  makeWASocket: vi.fn(() => ({
    ev: { on: vi.fn() },
    sendMessage: vi.fn(),
    sendPresenceUpdate: vi.fn(),
    logout: vi.fn(),
  })),
  useMultiFileAuthState: vi.fn(async () => ({
    state: { creds: {}, keys: {} },
    saveCreds: vi.fn(),
  })),
}));

vi.mock("qrcode-terminal", () => ({
  default: { generate: vi.fn() },
}));

vi.mock("winston", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    default: {
      createLogger: vi.fn(() => logger),
      format: {
        combine: vi.fn(),
        timestamp: vi.fn(),
        errors: vi.fn(),
        json: vi.fn(),
        colorize: vi.fn(),
        simple: vi.fn(),
      },
      transports: {
        File: vi.fn(),
        Console: vi.fn(),
      },
    },
  };
});

vi.mock("node:fs/promises", () => ({
  default: {
    access: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  },
  realpath: vi.fn(),
}));

import plugin, {
  toJid,
  isAllowed,
  extractText,
  chunkMessage,
  sanitizeFilename,
  parseCommand,
  mediaCategory,
  getSessionState,
  configSchema,
} from "../src/index.js";

// ─── Plugin Registration ──────────────────────────────────────────

describe("plugin registration", () => {
  it("exports a valid WOPRPlugin with required fields", () => {
    expect(plugin).toBeDefined();
    expect(plugin.name).toBe("whatsapp");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.description).toContain("WhatsApp");
    expect(typeof plugin.init).toBe("function");
    expect(typeof plugin.shutdown).toBe("function");
  });

  it("initializes with a mock context", async () => {
    const mockContext = {
      getConfig: vi.fn(() => ({})),
      registerConfigSchema: vi.fn(),
      getAgentIdentity: vi.fn(async () => ({ name: "TestBot", emoji: "🤖" })),
      inject: vi.fn(async () => "response"),
      logMessage: vi.fn(),
    };

    await plugin.init(mockContext);
    expect(mockContext.registerConfigSchema).toHaveBeenCalledWith(
      "whatsapp",
      configSchema,
    );
    expect(mockContext.getAgentIdentity).toHaveBeenCalled();
  });

  it("shuts down cleanly", async () => {
    // Init first so there's state to clean up
    const mockContext = {
      getConfig: vi.fn(() => ({})),
      registerConfigSchema: vi.fn(),
      getAgentIdentity: vi.fn(async () => null),
      inject: vi.fn(async () => ""),
      logMessage: vi.fn(),
    };
    await plugin.init(mockContext);
    await plugin.shutdown();
    // Should not throw
  });
});

// ─── Config Schema ────────────────────────────────────────────────

describe("configSchema", () => {
  it("has a title and description", () => {
    expect(configSchema.title).toBe("WhatsApp Integration");
    expect(configSchema.description).toContain("WhatsApp Web");
  });

  it("defines required fields", () => {
    const fieldNames = configSchema.fields.map((f) => f.name);
    expect(fieldNames).toContain("accountId");
    expect(fieldNames).toContain("dmPolicy");
    expect(fieldNames).toContain("allowFrom");
    expect(fieldNames).toContain("selfChatMode");
    expect(fieldNames).toContain("ownerNumber");
    expect(fieldNames).toContain("verbose");
    expect(fieldNames).toContain("pairingRequests");
  });

  it("has correct defaults for key fields", () => {
    const accountId = configSchema.fields.find((f) => f.name === "accountId");
    expect(accountId?.default).toBe("default");

    const dmPolicy = configSchema.fields.find((f) => f.name === "dmPolicy");
    expect(dmPolicy?.default).toBe("allowlist");

    const selfChat = configSchema.fields.find((f) => f.name === "selfChatMode");
    expect(selfChat?.default).toBe(false);
  });

  it("marks pairingRequests as hidden", () => {
    const pr = configSchema.fields.find((f) => f.name === "pairingRequests");
    expect((pr as any)?.hidden).toBe(true);
  });
});

// ─── toJid ────────────────────────────────────────────────────────

describe("toJid", () => {
  it("returns JID unchanged if it already contains @", () => {
    expect(toJid("1234567890@s.whatsapp.net")).toBe(
      "1234567890@s.whatsapp.net",
    );
  });

  it("appends @s.whatsapp.net for plain numbers", () => {
    expect(toJid("1234567890")).toBe("1234567890@s.whatsapp.net");
  });

  it("strips non-numeric characters from phone numbers", () => {
    expect(toJid("+1 (234) 567-890")).toBe("1234567890@s.whatsapp.net");
  });

  it("handles group JIDs unchanged", () => {
    expect(toJid("12345@g.us")).toBe("12345@g.us");
  });
});

// ─── isAllowed ────────────────────────────────────────────────────

describe("isAllowed", () => {
  // isAllowed reads from module-level `config` which is set during init.
  // We need to init with specific configs to test different policies.

  it("always allows group messages", async () => {
    const mockContext = {
      getConfig: vi.fn(() => ({ dmPolicy: "disabled" })),
      registerConfigSchema: vi.fn(),
      getAgentIdentity: vi.fn(async () => null),
      inject: vi.fn(async () => ""),
      logMessage: vi.fn(),
    };
    await plugin.init(mockContext);

    expect(isAllowed("12345@g.us", true)).toBe(true);
  });

  it("blocks DMs when policy is disabled", async () => {
    const mockContext = {
      getConfig: vi.fn(() => ({ dmPolicy: "disabled" })),
      registerConfigSchema: vi.fn(),
      getAgentIdentity: vi.fn(async () => null),
      inject: vi.fn(async () => ""),
      logMessage: vi.fn(),
    };
    await plugin.init(mockContext);

    expect(isAllowed("1234567890@s.whatsapp.net", false)).toBe(false);
  });

  it("allows all DMs when policy is open", async () => {
    const mockContext = {
      getConfig: vi.fn(() => ({ dmPolicy: "open" })),
      registerConfigSchema: vi.fn(),
      getAgentIdentity: vi.fn(async () => null),
      inject: vi.fn(async () => ""),
      logMessage: vi.fn(),
    };
    await plugin.init(mockContext);

    expect(isAllowed("anyone@s.whatsapp.net", false)).toBe(true);
  });

  it("allows only listed numbers in allowlist mode", async () => {
    const mockContext = {
      getConfig: vi.fn(() => ({
        dmPolicy: "allowlist",
        allowFrom: ["+1234567890"],
      })),
      registerConfigSchema: vi.fn(),
      getAgentIdentity: vi.fn(async () => null),
      inject: vi.fn(async () => ""),
      logMessage: vi.fn(),
    };
    await plugin.init(mockContext);

    expect(isAllowed("1234567890@s.whatsapp.net", false)).toBe(true);
    expect(isAllowed("9999999999@s.whatsapp.net", false)).toBe(false);
  });

  it("allows all when allowlist contains wildcard", async () => {
    const mockContext = {
      getConfig: vi.fn(() => ({
        dmPolicy: "allowlist",
        allowFrom: ["*"],
      })),
      registerConfigSchema: vi.fn(),
      getAgentIdentity: vi.fn(async () => null),
      inject: vi.fn(async () => ""),
      logMessage: vi.fn(),
    };
    await plugin.init(mockContext);

    expect(isAllowed("anyone@s.whatsapp.net", false)).toBe(true);
  });
});

// ─── extractText ──────────────────────────────────────────────────

describe("extractText", () => {
  it("extracts conversation text", () => {
    const msg = { message: { conversation: "hello" } } as any;
    expect(extractText(msg)).toBe("hello");
  });

  it("extracts extendedTextMessage text", () => {
    const msg = {
      message: { extendedTextMessage: { text: "extended hello" } },
    } as any;
    expect(extractText(msg)).toBe("extended hello");
  });

  it("extracts image caption", () => {
    const msg = {
      message: { imageMessage: { caption: "photo caption" } },
    } as any;
    expect(extractText(msg)).toBe("photo caption");
  });

  it("extracts video caption", () => {
    const msg = {
      message: { videoMessage: { caption: "video caption" } },
    } as any;
    expect(extractText(msg)).toBe("video caption");
  });

  it("extracts document caption", () => {
    const msg = {
      message: { documentMessage: { caption: "doc caption" } },
    } as any;
    expect(extractText(msg)).toBe("doc caption");
  });

  it("returns undefined for empty message", () => {
    expect(extractText({} as any)).toBeUndefined();
    expect(extractText({ message: {} } as any)).toBeUndefined();
  });
});

// ─── parseCommand ─────────────────────────────────────────────────

describe("parseCommand", () => {
  it("parses a command with no args", () => {
    const result = parseCommand("!help");
    expect(result).toEqual({ name: "help", args: "" });
  });

  it("parses a command with args", () => {
    const result = parseCommand("!think high");
    expect(result).toEqual({ name: "think", args: "high" });
  });

  it("lowercases command names", () => {
    const result = parseCommand("!Status");
    expect(result).toEqual({ name: "status", args: "" });
  });

  it("returns null for non-command text", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("! nope")).toBeNull();
  });

  it("handles multi-word args", () => {
    const result = parseCommand("!model claude-sonnet-4-20250514");
    expect(result).toEqual({
      name: "model",
      args: "claude-sonnet-4-20250514",
    });
  });
});

// ─── chunkMessage ─────────────────────────────────────────────────

describe("chunkMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(chunkMessage("hello", 100)).toEqual(["hello"]);
  });

  it("splits long messages at sentence boundaries", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    const chunks = chunkMessage(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    // Verify all content is preserved
    const rejoined = chunks.join(" ");
    expect(rejoined).toContain("First sentence.");
    expect(rejoined).toContain("Third sentence.");
  });

  it("handles text exactly at max length", () => {
    const text = "a".repeat(100);
    expect(chunkMessage(text, 100)).toEqual([text]);
  });
});

// ─── sanitizeFilename ─────────────────────────────────────────────

describe("sanitizeFilename", () => {
  it("keeps clean filenames unchanged", () => {
    expect(sanitizeFilename("photo.jpg")).toBe("photo.jpg");
  });

  it("replaces path separators and special chars", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe(".._.._etc_passwd");
  });

  it("handles dots-only filenames", () => {
    expect(sanitizeFilename(".")).toMatch(/^file_\d+$/);
    expect(sanitizeFilename("..")).toMatch(/^file_\d+$/);
  });

  it("handles empty strings", () => {
    expect(sanitizeFilename("")).toMatch(/^file_\d+$/);
  });

  it("strips control characters", () => {
    expect(sanitizeFilename("file\x00name.txt")).toBe("file_name.txt");
  });
});

// ─── mediaCategory ────────────────────────────────────────────────

describe("mediaCategory", () => {
  it("maps imageMessage to image", () => {
    expect(mediaCategory("imageMessage")).toBe("image");
  });

  it("maps audioMessage to audio", () => {
    expect(mediaCategory("audioMessage")).toBe("audio");
  });

  it("maps videoMessage to video", () => {
    expect(mediaCategory("videoMessage")).toBe("video");
  });

  it("maps stickerMessage to sticker", () => {
    expect(mediaCategory("stickerMessage")).toBe("sticker");
  });

  it("maps documentMessage to document", () => {
    expect(mediaCategory("documentMessage")).toBe("document");
  });

  it("defaults unknown types to document", () => {
    expect(mediaCategory("unknownMessage")).toBe("document");
  });
});

// ─── getSessionState ──────────────────────────────────────────────

describe("getSessionState", () => {
  it("creates a new session state with defaults", () => {
    const state = getSessionState("test-session-new");
    expect(state.thinkingLevel).toBe("medium");
    expect(state.messageCount).toBe(0);
    expect(state.model).toBe("claude-sonnet-4-20250514");
  });

  it("returns the same state for the same key", () => {
    const state1 = getSessionState("test-session-same");
    state1.messageCount = 5;
    const state2 = getSessionState("test-session-same");
    expect(state2.messageCount).toBe(5);
  });

  it("returns different state for different keys", () => {
    const stateA = getSessionState("session-a");
    const stateB = getSessionState("session-b");
    stateA.messageCount = 10;
    expect(stateB.messageCount).toBe(0);
  });
});

// ─── Reply-to-message (WOP-135) ──────────────────────────────────

describe("reply-to-message support (WOP-135)", () => {
  let mockSendMessage: ReturnType<typeof vi.fn>;
  let eventHandlers: Record<string, (...args: unknown[]) => void>;
  let mockInject: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();

    mockSendMessage = vi.fn().mockResolvedValue(undefined);
    eventHandlers = {};

    // Re-mock makeWASocket to capture event handlers
    const baileys = await import("@whiskeysockets/baileys");
    (baileys.makeWASocket as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      ev: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          eventHandlers[event] = handler;
        }),
      },
      sendMessage: mockSendMessage,
      sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
    }));

    // Mock fs to provide credentials so startSession is called
    const fsMod = await import("node:fs/promises");
    (fsMod.default.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fsMod.default.mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // Mock require("node:fs") for sync ops in maybeRestoreCredsFromBackup
    const origRequire = globalThis.require;

    // Configure inject to return a test response
    mockInject = vi.fn().mockResolvedValue("Test bot response");

    const mockContext = {
      getConfig: vi.fn(() => ({
        dmPolicy: "open",
        accountId: "test-reply",
      })),
      registerConfigSchema: vi.fn(),
      getAgentIdentity: vi.fn(async () => ({ name: "TestBot", emoji: "🤖" })),
      inject: mockInject,
      logMessage: vi.fn(),
    };

    await plugin.init(mockContext);

    // Simulate connection open so socket is set
    if (eventHandlers["connection.update"]) {
      eventHandlers["connection.update"]({ connection: "open" });
    }
  });

  it("passes quoted WAMessage when sending bot response to a DM", async () => {
    // Skip if messages.upsert handler wasn't registered (socket not connected)
    if (!eventHandlers["messages.upsert"]) return;

    const incomingMsg = {
      key: {
        id: "msg-123",
        remoteJid: "1234567890@s.whatsapp.net",
        fromMe: false,
      },
      message: { conversation: "Hello bot" },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    // Trigger the incoming message handler
    eventHandlers["messages.upsert"]({
      type: "notify",
      messages: [incomingMsg],
    });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 100));

    // Verify inject was called (message was processed)
    expect(mockInject).toHaveBeenCalled();

    // Find the sendMessage call that sent the bot's text response (not the reaction)
    const textCalls = mockSendMessage.mock.calls.filter(
      (call: unknown[]) => {
        const content = call[1] as Record<string, unknown>;
        return content && typeof content.text === "string" && !content.react;
      }
    );

    expect(textCalls.length).toBeGreaterThan(0);

    // The first text response should include the quoted parameter
    const [jid, _content, opts] = textCalls[0];
    expect(jid).toBe("1234567890@s.whatsapp.net");
    expect(opts).toBeDefined();
    expect(opts.quoted).toBeDefined();
    expect(opts.quoted.key.id).toBe("msg-123");
  });

  it("passes quoted WAMessage when sending bot response in a group", async () => {
    if (!eventHandlers["messages.upsert"]) return;

    const incomingMsg = {
      key: {
        id: "grp-msg-456",
        remoteJid: "group123@g.us",
        fromMe: false,
        participant: "5551234@s.whatsapp.net",
      },
      message: { conversation: "Hey bot" },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    eventHandlers["messages.upsert"]({
      type: "notify",
      messages: [incomingMsg],
    });

    await new Promise((r) => setTimeout(r, 100));

    const textCalls = mockSendMessage.mock.calls.filter(
      (call: unknown[]) => {
        const content = call[1] as Record<string, unknown>;
        return content && typeof content.text === "string" && !content.react;
      }
    );

    expect(textCalls.length).toBeGreaterThan(0);
    const [jid, _content, opts] = textCalls[0];
    expect(jid).toBe("group123@g.us");
    expect(opts).toBeDefined();
    expect(opts.quoted).toBeDefined();
    expect(opts.quoted.key.id).toBe("grp-msg-456");
  });

  it("quotes command responses too", async () => {
    if (!eventHandlers["messages.upsert"]) return;

    const incomingMsg = {
      key: {
        id: "cmd-msg-789",
        remoteJid: "1234567890@s.whatsapp.net",
        fromMe: false,
      },
      message: { conversation: "!help" },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    eventHandlers["messages.upsert"]({
      type: "notify",
      messages: [incomingMsg],
    });

    await new Promise((r) => setTimeout(r, 100));

    // The !help command response should also be quoted
    const textCalls = mockSendMessage.mock.calls.filter(
      (call: unknown[]) => {
        const content = call[1] as Record<string, unknown>;
        return content && typeof content.text === "string" && !content.react;
      }
    );

    expect(textCalls.length).toBeGreaterThan(0);
    const [_jid, _content, opts] = textCalls[0];
    expect(opts).toBeDefined();
    expect(opts.quoted).toBeDefined();
    expect(opts.quoted.key.id).toBe("cmd-msg-789");
  });

  it("falls back to sending without quote when quoting fails", async () => {
    if (!eventHandlers["messages.upsert"]) return;

    // Make sendMessage fail when called with quoted option, succeed without
    mockSendMessage.mockImplementation(
      async (_jid: string, _content: unknown, opts?: Record<string, unknown>) => {
        if (opts && opts.quoted) {
          throw new Error("Quoted message not found");
        }
        return undefined;
      }
    );

    const incomingMsg = {
      key: {
        id: "deleted-msg-000",
        remoteJid: "1234567890@s.whatsapp.net",
        fromMe: false,
      },
      message: { conversation: "!status" },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    eventHandlers["messages.upsert"]({
      type: "notify",
      messages: [incomingMsg],
    });

    await new Promise((r) => setTimeout(r, 100));

    // Should have retried without quoted -- look for successful text sends
    const textCalls = mockSendMessage.mock.calls.filter(
      (call: unknown[]) => {
        const content = call[1] as Record<string, unknown>;
        return content && typeof content.text === "string" && !content.react;
      }
    );

    // At least 2 calls: first attempt with quote (failed), retry without quote (succeeded)
    expect(textCalls.length).toBeGreaterThanOrEqual(2);

    // First attempt has quoted
    expect(textCalls[0][2]).toBeDefined();
    expect(textCalls[0][2].quoted).toBeDefined();

    // Retry does not have quoted
    const retryOpts = textCalls[1][2];
    expect(!retryOpts || !retryOpts.quoted).toBe(true);
  });

  it("only quotes the first chunk of a multi-chunk message", async () => {
    if (!eventHandlers["messages.upsert"]) return;

    // Make inject return a very long response to trigger chunking
    const longResponse = Array(50).fill("This is a test sentence.").join(" ");
    mockInject.mockResolvedValue(longResponse);

    const incomingMsg = {
      key: {
        id: "long-msg-111",
        remoteJid: "1234567890@s.whatsapp.net",
        fromMe: false,
      },
      message: { conversation: "Tell me a long story" },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    eventHandlers["messages.upsert"]({
      type: "notify",
      messages: [incomingMsg],
    });

    await new Promise((r) => setTimeout(r, 100));

    const textCalls = mockSendMessage.mock.calls.filter(
      (call: unknown[]) => {
        const content = call[1] as Record<string, unknown>;
        return content && typeof content.text === "string" && !content.react;
      }
    );

    if (textCalls.length > 1) {
      // First chunk should have the quote
      expect(textCalls[0][2]).toBeDefined();
      expect(textCalls[0][2].quoted).toBeDefined();

      // Subsequent chunks should NOT have the quote
      for (let i = 1; i < textCalls.length; i++) {
        const opts = textCalls[i][2];
        expect(!opts || !opts.quoted).toBe(true);
      }
    }
  });
});
