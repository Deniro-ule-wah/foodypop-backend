import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

// Pretty-printed in dev for readability, structured JSON in production
// so logs are parseable by whatever log aggregation gets added later.
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: isProd ? undefined : { target: "pino-pretty", options: { colorize: true } },
});
