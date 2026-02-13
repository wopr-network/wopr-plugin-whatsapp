import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerWhatsappTools } from "../src/webmcp-whatsapp.js";
import {
  createWhatsAppWebMCPExtension,
  type WhatsAppState,
} from "../src/whatsapp-extension.js";
import type { WebMCPRegistry, WebMCPTool, AuthContext } from "../src/webmcp-whatsapp.js";

// ============================================================================
// registerWhatsappTools
// ============================================================================

describe("registerWhatsappTools", () => {
  let registry: WebMCPRegistry;
  let registered: Map<string, WebMCPTool>;

  beforeEach(() => {
    registered = new Map();
    registry = {
      register: (tool: WebMCPTool) => registered.set(tool.name, tool),
      get: (name: string) => registered.get(name),
      list: () => Array.from(registered.keys()),
    };
  });

  it("registers all 3 tools", () => {
    registerWhatsappTools(registry);
    expect(registered.size).toBe(3);
    expect(registered.has("getWhatsappStatus")).toBe(true);
    expect(registered.has("listWhatsappChats")).toBe(true);
    expect(registered.has("getWhatsappMessageStats")).toBe(true);
  });

  it("all tools have empty parameters (no required input)", () => {
    registerWhatsappTools(registry);
    for (const tool of registered.values()) {
      expect(tool.parameters).toEqual({});
    }
  });

  it("all tools have descriptions", () => {
    registerWhatsappTools(registry);
    for (const tool of registered.values()) {
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe("string");
    }
  });

  it("handlers call fetch with correct API paths", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ status: "ok" }) };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

    registerWhatsappTools(registry, "/api");
    const auth: AuthContext = {};

    await registered.get("getWhatsappStatus")!.handler({}, auth);
    expect(fetchSpy).toHaveBeenCalledWith("/api/plugins/whatsapp/status", expect.objectContaining({ headers: expect.objectContaining({ "Content-Type": "application/json" }) }));

    await registered.get("listWhatsappChats")!.handler({}, auth);
    expect(fetchSpy).toHaveBeenCalledWith("/api/plugins/whatsapp/chats", expect.anything());

    await registered.get("getWhatsappMessageStats")!.handler({}, auth);
    expect(fetchSpy).toHaveBeenCalledWith("/api/plugins/whatsapp/stats", expect.anything());

    fetchSpy.mockRestore();
  });

  it("handlers include Bearer token when auth has token", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({}) };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

    registerWhatsappTools(registry);
    const auth: AuthContext = { token: "test-token-123" };

    await registered.get("getWhatsappStatus")!.handler({}, auth);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token-123" }),
      }),
    );

    fetchSpy.mockRestore();
  });

  it("handlers throw on non-OK response", async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Internal server error" }),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

    registerWhatsappTools(registry);
    await expect(registered.get("getWhatsappStatus")!.handler({}, {})).rejects.toThrow("Internal server error");

    fetchSpy.mockRestore();
  });

  it("uses custom apiBase", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({}) };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

    registerWhatsappTools(registry, "http://localhost:7437");
    await registered.get("getWhatsappStatus")!.handler({}, {});
    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:7437/plugins/whatsapp/status", expect.anything());

    fetchSpy.mockRestore();
  });
});

// ============================================================================
// createWhatsAppWebMCPExtension
// ============================================================================

describe("createWhatsAppWebMCPExtension", () => {
  function makeState(overrides: Partial<WhatsAppState> = {}): WhatsAppState {
    return {
      getSocket: () => null,
      getContacts: () => new Map(),
      getGroups: () => new Map(),
      getSessionKeys: () => [],
      getMessageCount: () => 0,
      getAccountId: () => "default",
      hasCredentials: () => false,
      getConnectTime: () => null,
      ...overrides,
    };
  }

  describe("getStatus", () => {
    it("returns disconnected when no socket", () => {
      const ext = createWhatsAppWebMCPExtension(makeState());
      const status = ext.getStatus();
      expect(status.connected).toBe(false);
      expect(status.phoneNumber).toBeNull();
      expect(status.qrState).toBe("awaiting_scan");
      expect(status.accountId).toBe("default");
      expect(status.uptimeMs).toBeNull();
    });

    it("returns connected with phone number when socket exists", () => {
      const mockSocket = {
        user: { id: "1234567890:12@s.whatsapp.net" },
      };
      const ext = createWhatsAppWebMCPExtension(makeState({
        getSocket: () => mockSocket as any,
        getConnectTime: () => Date.now() - 5000,
      }));
      const status = ext.getStatus();
      expect(status.connected).toBe(true);
      expect(status.phoneNumber).toBe("1234567890");
      expect(status.qrState).toBe("paired");
      expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it("returns paired qrState when has credentials but no socket", () => {
      const ext = createWhatsAppWebMCPExtension(makeState({
        hasCredentials: () => true,
      }));
      const status = ext.getStatus();
      expect(status.connected).toBe(false);
      expect(status.qrState).toBe("paired");
    });

    it("uses custom accountId", () => {
      const ext = createWhatsAppWebMCPExtension(makeState({
        getAccountId: () => "work-phone",
      }));
      expect(ext.getStatus().accountId).toBe("work-phone");
    });
  });

  describe("listChats", () => {
    it("returns empty array when no contacts or groups", () => {
      const ext = createWhatsAppWebMCPExtension(makeState());
      expect(ext.listChats()).toEqual([]);
    });

    it("lists groups with participant count", () => {
      const groups = new Map<string, any>([
        ["group1@g.us", { subject: "Family Chat", participants: [{ id: "a" }, { id: "b" }] }],
      ]);
      const ext = createWhatsAppWebMCPExtension(makeState({
        getGroups: () => groups,
      }));
      const chats = ext.listChats();
      expect(chats).toHaveLength(1);
      expect(chats[0]).toEqual({
        id: "group1@g.us",
        name: "Family Chat",
        type: "group",
        participantCount: 2,
      });
    });

    it("lists individual contacts with names", () => {
      const contacts = new Map<string, any>([
        ["1234@s.whatsapp.net", { id: "1234@s.whatsapp.net", notify: "Alice" }],
        ["5678@s.whatsapp.net", { id: "5678@s.whatsapp.net", name: "Bob" }],
      ]);
      const ext = createWhatsAppWebMCPExtension(makeState({
        getContacts: () => contacts,
      }));
      const chats = ext.listChats();
      expect(chats).toHaveLength(2);
      expect(chats[0].type).toBe("individual");
      expect(chats[0].name).toBe("Alice");
      expect(chats[1].name).toBe("Bob");
    });

    it("excludes contacts without names", () => {
      const contacts = new Map<string, any>([
        ["1234@s.whatsapp.net", { id: "1234@s.whatsapp.net" }],
      ]);
      const ext = createWhatsAppWebMCPExtension(makeState({
        getContacts: () => contacts,
      }));
      expect(ext.listChats()).toHaveLength(0);
    });

    it("excludes status@broadcast", () => {
      const contacts = new Map<string, any>([
        ["status@broadcast", { id: "status@broadcast", notify: "Status" }],
      ]);
      const ext = createWhatsAppWebMCPExtension(makeState({
        getContacts: () => contacts,
      }));
      expect(ext.listChats()).toHaveLength(0);
    });

    it("excludes group JIDs from contact list", () => {
      const contacts = new Map<string, any>([
        ["group1@g.us", { id: "group1@g.us", notify: "Group Contact" }],
      ]);
      const ext = createWhatsAppWebMCPExtension(makeState({
        getContacts: () => contacts,
      }));
      expect(ext.listChats()).toHaveLength(0);
    });
  });

  describe("getMessageStats", () => {
    it("returns zero stats when empty", () => {
      const ext = createWhatsAppWebMCPExtension(makeState());
      const stats = ext.getMessageStats();
      expect(stats.messagesProcessed).toBe(0);
      expect(stats.activeConversations).toBe(0);
      expect(stats.groupCount).toBe(0);
      expect(stats.individualCount).toBe(0);
    });

    it("reports message count from state", () => {
      const ext = createWhatsAppWebMCPExtension(makeState({
        getMessageCount: () => 42,
      }));
      expect(ext.getMessageStats().messagesProcessed).toBe(42);
    });

    it("counts active conversations from session keys", () => {
      const ext = createWhatsAppWebMCPExtension(makeState({
        getSessionKeys: () => ["whatsapp-123", "whatsapp-456", "whatsapp-789"],
      }));
      expect(ext.getMessageStats().activeConversations).toBe(3);
    });

    it("counts groups and individuals separately", () => {
      const groups = new Map<string, any>([
        ["g1@g.us", { subject: "G1" }],
        ["g2@g.us", { subject: "G2" }],
      ]);
      const contacts = new Map<string, any>([
        ["1@s.whatsapp.net", { id: "1@s.whatsapp.net", notify: "Alice" }],
        ["2@s.whatsapp.net", { id: "2@s.whatsapp.net" }], // no name -- excluded
        ["status@broadcast", { id: "status@broadcast", notify: "S" }], // excluded
      ]);
      const ext = createWhatsAppWebMCPExtension(makeState({
        getGroups: () => groups,
        getContacts: () => contacts,
      }));
      const stats = ext.getMessageStats();
      expect(stats.groupCount).toBe(2);
      expect(stats.individualCount).toBe(1);
    });
  });
});
