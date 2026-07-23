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
import { logger } from "./lib/logger";

const app = express();
app.use(cors());
app.use(express.json());
app.use(requestLogger); // structured request logging with per-request IDs (BE-004)
app.use(attachUser); // decodes token if present; does not block unauthenticated routes
app.use(apiLimiter); // general abuse/scrape protection (BE-003)

app.get("/health", (_req, res) => res.json({ ok: true, service: "foodypop-api" }));

// Auth endpoints get a stricter limiter layered on top of the general
// one — brute-force protection matters most here.
app.use("/auth", authLimiter, authRouter);
app.use("/dishes", dishesRouter);
app.use("/vendors", vendorsRouter);
app.use("/follows", followsRouter);
app.use("/", lookupsRouter);

// PH-001: centralized error handling. Order matters — notFoundHandler
// catches anything no router matched, and errorHandler (4-arg signature,
// required by Express to be recognized as error middleware) must be
// mounted LAST, after every route and every other middleware.
app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(PORT, () => {
  logger.info(`FoodyPop API running on http://localhost:${PORT}`);
});
