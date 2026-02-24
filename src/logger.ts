/**
 * Winston logger for WOPR WhatsApp Plugin
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import winston from "winston";

const WOPR_HOME =
	process.env.WOPR_HOME || path.join(process.env.HOME || "~", ".wopr");
const logDir = path.join(WOPR_HOME, "logs");
mkdirSync(logDir, { recursive: true });

export const logger = winston.createLogger({
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
