/**
 * Retry wrapper with exponential backoff for WhatsApp message sends.
 *
 * Distinguishes retryable errors (network, rate limit, socket drops)
 * from permanent failures (invalid JID, authentication) to fail fast
 * when retrying would be futile.
 */

import type { PluginLogger } from "@wopr-network/plugin-types";

export interface RetryConfig {
	/** Maximum number of retry attempts (default 3) */
	maxRetries: number;
	/** Base delay in ms before first retry (default 1000) */
	baseDelay: number;
	/** Maximum delay cap in ms (default 30000) */
	maxDelay: number;
	/** Jitter factor 0-1 to randomize delays (default 0.2) */
	jitter: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxRetries: 3,
	baseDelay: 1000,
	maxDelay: 30000,
	jitter: 0.2,
};

/**
 * Error classification for WhatsApp/Baileys errors.
 * - retryable: transient network/rate-limit issues worth retrying
 * - permanent: errors that will never succeed on retry
 */
export type ErrorClass = "retryable" | "permanent";

/** Patterns in error messages that indicate permanent failures. */
const PERMANENT_ERROR_PATTERNS = [
	/invalid jid/i,
	/not a valid/i,
	/not registered/i,
	/logged out/i,
	/authentication/i,
	/unauthorized/i,
	/forbidden/i,
	/not found/i,
	/bad request/i,
];

/** HTTP-like status codes from Baileys that are permanent. */
const PERMANENT_STATUS_CODES = new Set([400, 401, 403, 404, 410]);

/** Status codes that indicate rate limiting. */
const RATE_LIMIT_STATUS_CODES = new Set([429, 503]);

/**
 * Extract a numeric status code from a Baileys error, if present.
 * Baileys wraps errors with `output.statusCode` or `status`.
 */
function getErrorStatusCode(err: unknown): number | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	const e = err as Record<string, unknown>;
	const output = e.output as Record<string, unknown> | undefined;
	if (output && typeof output.statusCode === "number") return output.statusCode;
	if (typeof e.status === "number") return e.status;
	if (typeof e.statusCode === "number") return e.statusCode;
	return undefined;
}

/**
 * Extract a Retry-After hint (in ms) from an error, if present.
 * WhatsApp may include backoff hints on rate limit responses.
 */
export function extractRetryAfter(err: unknown): number | null {
	if (typeof err !== "object" || err === null) return null;
	const e = err as Record<string, unknown>;

	// Check for retryAfter or retry_after fields (seconds)
	for (const key of ["retryAfter", "retry_after", "retryAfterMs"]) {
		const val = e[key];
		if (typeof val === "number" && val > 0) {
			// retryAfterMs is already in ms; others are in seconds
			return key === "retryAfterMs" ? val : val * 1000;
		}
	}

	// Check inside data or headers
	const data = e.data as Record<string, unknown> | undefined;
	if (data && typeof data.retry_after === "number") {
		return data.retry_after * 1000;
	}

	return null;
}

/**
 * Classify whether an error is retryable or permanent.
 */
export function classifyError(err: unknown): ErrorClass {
	const statusCode = getErrorStatusCode(err);

	// Permanent status codes fail fast
	if (statusCode !== undefined && PERMANENT_STATUS_CODES.has(statusCode)) {
		return "permanent";
	}

	// Rate limit codes are always retryable
	if (statusCode !== undefined && RATE_LIMIT_STATUS_CODES.has(statusCode)) {
		return "retryable";
	}

	// Check error message patterns
	const message =
		err instanceof Error
			? err.message
			: typeof err === "object" && err !== null && "message" in err
				? String((err as { message: unknown }).message)
				: String(err);

	for (const pattern of PERMANENT_ERROR_PATTERNS) {
		if (pattern.test(message)) {
			return "permanent";
		}
	}

	// Connection/network errors are retryable
	if (
		/ECONNRESET|ETIMEDOUT|ENOTFOUND|ENETUNREACH|EPIPE|ECONNREFUSED|socket hang up|socket closed|connection closed|network/i.test(
			message,
		)
	) {
		return "retryable";
	}

	// Default: treat unknown errors as retryable (safer to retry than to drop)
	return "retryable";
}

/**
 * Calculate delay for a given attempt using exponential backoff with jitter.
 * If the error includes a Retry-After hint, that value is used instead
 * (capped at maxDelay).
 */
export function calculateDelay(
	attempt: number,
	config: RetryConfig,
	retryAfterMs: number | null,
): number {
	// Respect server-provided backoff hint
	if (retryAfterMs !== null && retryAfterMs > 0) {
		return Math.min(retryAfterMs, config.maxDelay);
	}

	// Exponential backoff: baseDelay * 2^attempt
	const exponential = config.baseDelay * 2 ** attempt;
	const capped = Math.min(exponential, config.maxDelay);

	// Add jitter: +/- jitter fraction
	const jitterRange = capped * config.jitter;
	const jitterOffset = (Math.random() * 2 - 1) * jitterRange;

	return Math.max(0, Math.round(capped + jitterOffset));
}

/**
 * Execute an async operation with retry and exponential backoff.
 *
 * @param operation - The async function to execute
 * @param label - Human-readable label for logging (e.g. "sendMessage to 1234@s.whatsapp.net")
 * @param logger - Plugin logger instance
 * @param config - Retry configuration (uses defaults if not provided)
 * @returns The result of the operation
 * @throws The last error if all retries are exhausted, or immediately for permanent errors
 */
export async function withRetry<T>(
	operation: () => Promise<T>,
	label: string,
	logger: PluginLogger,
	config: Partial<RetryConfig> = {},
): Promise<T> {
	const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
	let lastError: unknown;

	for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
		try {
			return await operation();
		} catch (err) {
			lastError = err;

			const errorClass = classifyError(err);
			const errorMessage = err instanceof Error ? err.message : String(err);

			// Permanent errors fail immediately, no retry
			if (errorClass === "permanent") {
				logger.error(
					`[retry] ${label}: permanent error, not retrying: ${errorMessage}`,
				);
				throw err;
			}

			// If we've exhausted retries, throw
			if (attempt >= cfg.maxRetries) {
				logger.error(
					`[retry] ${label}: all ${cfg.maxRetries} retries exhausted: ${errorMessage}`,
				);
				throw err;
			}

			// Calculate backoff delay
			const retryAfterMs = extractRetryAfter(err);
			const delay = calculateDelay(attempt, cfg, retryAfterMs);

			logger.warn(
				`[retry] ${label}: attempt ${attempt + 1}/${cfg.maxRetries + 1} failed (${errorMessage}), ` +
					`retrying in ${delay}ms${retryAfterMs ? " (using server hint)" : ""}`,
			);

			// Wait before retrying
			await sleep(delay);
		}
	}

	// Should never reach here, but TypeScript needs this
	throw lastError;
}

/** Promise-based sleep. Exported for testing. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
