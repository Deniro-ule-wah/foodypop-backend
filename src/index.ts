import "dotenv/config";
import express from "express";
import cors from "cors";
import { dishesRouter } from "./routes/dishes";
import { vendorsRouter } from "./routes/vendors";
import { lookupsRouter } from "./routes/lookups";
import { authRouter } from "./routes/auth";
import { followsRouter } from "./routes/follows";
import { attachUser } from "./middleware/auth";
import { authLimiter, apiLimiter } from "./middleware/rateLimit";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler";
import { requestLogger } from "./lib/requestLogger";
import { ordersRouter } from "./routes/orders";
import { paymentsRouter, orderPaymentsRouter } from "./routes/payments";
import { internalRouter } from "./routes/internal";
import { startBoss, stopBoss, bossHealth } from "./lib/boss";
import { registerWorkers } from "./worker/jobHandlers";
import { logger } from "./lib/logger";

const app = express();
app.use(cors());
app.use(express.json());
app.use(requestLogger); // structured request logging with per-request IDs (BE-004)
app.use(attachUser); // decodes token if present; does not block unauthenticated routes
app.use(apiLimiter); // general abuse/scrape protection (BE-003)

app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "foodypop-api", worker: bossHealth() })
);

// Auth endpoints get a stricter limiter layered on top of the general
// one — brute-force protection matters most here.
app.use("/auth", authLimiter, authRouter);
app.use("/dishes", dishesRouter);
app.use("/vendors", vendorsRouter);
app.use("/follows", followsRouter);
// V2
app.use("/orders/:id/payment-attempts", orderPaymentsRouter);
app.use("/orders", ordersRouter);
app.use("/payments", paymentsRouter);
app.use("/internal", internalRouter);
app.use("/", lookupsRouter);

// PH-001: centralized error handling. Order matters — notFoundHandler
// catches anything no router matched, and errorHandler (4-arg signature,
// required by Express to be recognized as error middleware) must be
// mounted LAST, after every route and every other middleware.
app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const server = app.listen(PORT, async () => {
  logger.info(`FoodyPop API running on http://localhost:${PORT}`);
  // pg-boss runs in the SAME process as the API (locked decision) but
  // stays an independently observable component with its own lifecycle.
  try {
    await startBoss();
    await registerWorkers();
  } catch (err) {
    logger.error({ err }, "Failed to start pg-boss — background jobs will not run");
  }
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  await stopBoss();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
