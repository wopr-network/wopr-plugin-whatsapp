/**
 * Winston logger for WOPR WhatsApp Plugin
 *
 * Lazy-initialized: mkdirSync runs only when the logger is first accessed,
 * not at module import time, to avoid side effects during plugin loading.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import winston from "winston";

function createLogger(): winston.Logger {
	const WOPR_HOME =
		process.env.WOPR_HOME || path.join(process.env.HOME || "~", ".wopr");
	const logDir = path.join(WOPR_HOME, "logs");
	mkdirSync(logDir, { recursive: true });

	return winston.createLogger({
		level: "debug",
		format: winston.format.combine(
			winston.format.timestamp(),
			winston.format.errors({ stack: true }),
			winston.format.json(),
		),
		defaultMeta: { service: "wopr-plugin-whatsapp" },
		transports: [
			new winston.transports.File({
				filename: path.join(logDir, "whatsapp-plugin-error.log"),
				level: "error",
			}),
			new winston.transports.File({
				filename: path.join(logDir, "whatsapp-plugin.log"),
				level: "debug",
			}),
			new winston.transports.Console({
				format: winston.format.combine(
					winston.format.colorize(),
					winston.format.simple(),
				),
				level: "warn",
			}),
		],
	});
}

let _logger: winston.Logger | null = null;

export const logger: winston.Logger = new Proxy({} as winston.Logger, {
	get(_target, prop) {
		if (!_logger) {
			_logger = createLogger();
		}
		const value = (_logger as unknown as Record<string | symbol, unknown>)[
			prop
		];
		return typeof value === "function" ? value.bind(_logger) : value;
	},
});
