import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateDelay,
  classifyError,
  DEFAULT_RETRY_CONFIG,
  extractRetryAfter,
  type RetryConfig,
  withRetry,
} from "../src/retry.js";

// Mock logger
function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

// ─── classifyError ─────────────────────────────────────────────────

describe("classifyError", () => {
  it("classifies invalid JID as permanent", () => {
    expect(classifyError(new Error("invalid jid format"))).toBe("permanent");
  });

  it("classifies not registered as permanent", () => {
    expect(classifyError(new Error("Number not registered on WhatsApp"))).toBe("permanent");
  });

  it("classifies logged out as permanent", () => {
    expect(classifyError(new Error("Session logged out"))).toBe("permanent");
  });

  it("classifies authentication errors as permanent", () => {
    expect(classifyError(new Error("Authentication failed"))).toBe("permanent");
  });

  it("classifies 401 status as permanent", () => {
    const err = { output: { statusCode: 401 }, message: "Unauthorized" };
    expect(classifyError(err)).toBe("permanent");
  });

  it("classifies 403 status as permanent", () => {
    const err = { output: { statusCode: 403 }, message: "Forbidden" };
    expect(classifyError(err)).toBe("permanent");
  });

  it("classifies 404 status as permanent", () => {
    const err = { output: { statusCode: 404 }, message: "Not found" };
    expect(classifyError(err)).toBe("permanent");
  });

  it("classifies 400 status as permanent", () => {
    const err = { status: 400, message: "Bad request" };
    expect(classifyError(err)).toBe("permanent");
  });

  it("classifies 429 rate limit as retryable", () => {
    const err = { output: { statusCode: 429 }, message: "Too many requests" };
    expect(classifyError(err)).toBe("retryable");
  });

  it("classifies 503 as retryable", () => {
    const err = { status: 503, message: "Service unavailable" };
    expect(classifyError(err)).toBe("retryable");
  });

  it("classifies ECONNRESET as retryable", () => {
    expect(classifyError(new Error("read ECONNRESET"))).toBe("retryable");
  });

  it("classifies ETIMEDOUT as retryable", () => {
    expect(classifyError(new Error("connect ETIMEDOUT"))).toBe("retryable");
  });

  it("classifies socket hang up as retryable", () => {
    expect(classifyError(new Error("socket hang up"))).toBe("retryable");
  });

  it("classifies connection closed as retryable", () => {
    expect(classifyError(new Error("connection closed"))).toBe("retryable");
  });

  it("classifies unknown errors as retryable", () => {
    expect(classifyError(new Error("something weird happened"))).toBe("retryable");
  });

  it("handles non-Error objects", () => {
    expect(classifyError("string error")).toBe("retryable");
    expect(classifyError(42)).toBe("retryable");
    expect(classifyError(null)).toBe("retryable");
  });
});

// ─── extractRetryAfter ─────────────────────────────────────────────

describe("extractRetryAfter", () => {
  it("returns null for null/undefined", () => {
    expect(extractRetryAfter(null)).toBeNull();
    expect(extractRetryAfter(undefined)).toBeNull();
  });

  it("extracts retryAfter in seconds and converts to ms", () => {
    expect(extractRetryAfter({ retryAfter: 5 })).toBe(5000);
  });

  it("extracts retry_after in seconds and converts to ms", () => {
    expect(extractRetryAfter({ retry_after: 10 })).toBe(10000);
  });

  it("extracts retryAfterMs directly in ms", () => {
    expect(extractRetryAfter({ retryAfterMs: 3000 })).toBe(3000);
  });

  it("extracts retry_after from data object", () => {
    expect(extractRetryAfter({ data: { retry_after: 2 } })).toBe(2000);
  });

  it("returns null for errors without retry hints", () => {
    expect(extractRetryAfter(new Error("generic"))).toBeNull();
    expect(extractRetryAfter({})).toBeNull();
  });

  it("ignores zero and negative values", () => {
    expect(extractRetryAfter({ retryAfter: 0 })).toBeNull();
    expect(extractRetryAfter({ retryAfter: -1 })).toBeNull();
  });
});

// ─── calculateDelay ────────────────────────────────────────────────

describe("calculateDelay", () => {
  const config: RetryConfig = {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
    jitter: 0,
  };

  it("uses exponential backoff: 1s, 2s, 4s, 8s, ...", () => {
    expect(calculateDelay(0, config, null)).toBe(1000);
    expect(calculateDelay(1, config, null)).toBe(2000);
    expect(calculateDelay(2, config, null)).toBe(4000);
    expect(calculateDelay(3, config, null)).toBe(8000);
  });

  it("caps delay at maxDelay", () => {
    expect(calculateDelay(10, config, null)).toBe(30000);
  });

  it("uses server retry-after hint when provided", () => {
    expect(calculateDelay(0, config, 5000)).toBe(5000);
  });

  it("caps retry-after hint at maxDelay", () => {
    expect(calculateDelay(0, config, 60000)).toBe(30000);
  });

  it("adds jitter when configured", () => {
    const jitterConfig: RetryConfig = { ...config, jitter: 0.5 };
    // With jitter=0.5, delay should be within +/- 50% of base
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      delays.add(calculateDelay(0, jitterConfig, null));
    }
    // With randomness, we should get at least a few different values
    // (extremely unlikely to get same value 20 times with 50% jitter)
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1500);
    }
  });
});

// ─── withRetry ─────────────────────────────────────────────────────

describe("withRetry", () => {
  let mockLogger: ReturnType<typeof createMockLogger>;

  // Use real timers with very short delays to avoid fake-timer unhandled rejection issues
  const shortConfig = {
    maxRetries: 3,
    baseDelay: 5,
    maxDelay: 50,
    jitter: 0,
  };

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  it("returns the result on first success", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(op, "test-op", mockLogger, shortConfig);
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries on transient error and succeeds", async () => {
    const op = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue("ok");

    const result = await withRetry(op, "test-op", mockLogger, shortConfig);
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it("fails immediately on permanent error without retrying", async () => {
    const permErr = new Error("invalid jid");
    const op = vi.fn().mockRejectedValue(permErr);

    await expect(withRetry(op, "test-op", mockLogger, shortConfig)).rejects.toThrow("invalid jid");

    expect(op).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("permanent error"));
  });

  it("throws after exhausting all retries", async () => {
    const transientErr = new Error("ETIMEDOUT");
    const op = vi.fn().mockRejectedValue(transientErr);

    await expect(
      withRetry(op, "test-op", mockLogger, {
        maxRetries: 2,
        baseDelay: 5,
        maxDelay: 20,
        jitter: 0,
      }),
    ).rejects.toThrow("ETIMEDOUT");

    // 1 initial + 2 retries = 3 total attempts
    expect(op).toHaveBeenCalledTimes(3);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("retries exhausted"));
  });

  it("respects server retry-after hint in log", async () => {
    const rateLimitErr = Object.assign(new Error("rate limited"), {
      status: 429,
      retryAfter: 0.01, // 10ms in seconds
    });
    const op = vi.fn().mockRejectedValueOnce(rateLimitErr).mockResolvedValue("ok");

    const result = await withRetry(op, "test-op", mockLogger, shortConfig);
    expect(result).toBe("ok");
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("using server hint"));
  });

  it("uses default config when none provided", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(op, "test-op", mockLogger);
    expect(result).toBe("ok");
  });

  it("retries multiple times before succeeding", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue("ok");

    const result = await withRetry(op, "test-op", mockLogger, shortConfig);
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
  });
});

// ─── DEFAULT_RETRY_CONFIG ──────────────────────────────────────────

describe("DEFAULT_RETRY_CONFIG", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_CONFIG.baseDelay).toBe(1000);
    expect(DEFAULT_RETRY_CONFIG.maxDelay).toBe(30000);
    expect(DEFAULT_RETRY_CONFIG.jitter).toBeGreaterThan(0);
    expect(DEFAULT_RETRY_CONFIG.jitter).toBeLessThanOrEqual(1);
  });
});
