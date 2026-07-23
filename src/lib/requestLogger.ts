import pinoHttp from "pino-http";
import { randomUUID } from "crypto";
import { logger } from "./logger";

// Assigns a request ID to every incoming request so a single request
// can be traced through logs end-to-end — useful the moment more than
// one request is in flight at once, which is immediately.
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers["x-request-id"];
    const id = (Array.isArray(existing) ? existing[0] : existing) || randomUUID();
    res.setHeader("x-request-id", id);
    return id;
  },
  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 500 || err) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
});
