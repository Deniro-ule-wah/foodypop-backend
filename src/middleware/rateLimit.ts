import rateLimit from "express-rate-limit";
import { TooManyRequestsError } from "../lib/errors";

// In-memory rate limiting per the BE-003 decision — appropriate while
// running a single instance. If this ever runs across multiple
// instances/processes, this needs to move to a shared store (Redis)
// since in-memory limits don't share state across processes.

// Both limiters use a custom `handler` (rather than the `message`
// option) so a 429 goes through `next(err)` into the same centralized
// error middleware as every other error in this API, producing the
// standard { error: { code, message, requestId } } envelope instead
// of express-rate-limit's own default plain-string body. This was a
// real inconsistency found during BE-DOC-004 (the API Documentation
// Freeze) — the 429 was the one response in the entire API that
// bypassed PH-001's centralized error handling — and fixed here,
// CTO-approved, the same way the DELETE /follows 204 change was.

// Stricter limit on auth endpoints — brute-force protection matters
// most here.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(new TooManyRequestsError("Too many attempts. Please try again later."));
  },
});

// Looser general limit across the rest of the API — protects against
// abusive scraping/spam without getting in the way of normal use.
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(new TooManyRequestsError("Too many requests. Please slow down."));
  },
});
