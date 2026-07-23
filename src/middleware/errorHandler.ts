import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AppError, NotFoundError } from "../lib/errors";
import { logger } from "../lib/logger";

// Every error response from this API, regardless of source, comes out as:
// { "error": { "code": "...", "message": "...", "requestId": "...", "details"?: ... } }
// This replaces the previously inconsistent shapes (some plain strings,
// some raw Zod .flatten() objects) with one standard contract, per PH-001.

export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
}

function isPrismaKnownError(err: unknown): err is { code: string; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    (err as { code: string }).code.startsWith("P")
  );
}

// Must keep all four parameters (err, req, res, next) — Express only
// recognizes this as error-handling middleware if the function's arity is 4.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = (req as unknown as { id?: string }).id;

  // Known, intentional application errors (thrown via errors.ts classes)
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, requestId }, err.message);
    } else {
      logger.warn({ code: err.code, requestId, path: req.path }, err.message);
    }
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
        requestId,
      },
    });
  }

  // Zod validation errors thrown directly (rather than safeParse'd) —
  // kept as a safety net; route handlers should generally safeParse and
  // throw BadRequestError themselves, but this catches any that don't.
  if (err instanceof ZodError) {
    logger.warn({ requestId, path: req.path }, "Validation error");
    return res.status(400).json({
      error: {
        code: "BAD_REQUEST",
        message: "Validation failed",
        details: err.flatten(),
        requestId,
      },
    });
  }

  // Prisma known request errors — e.g. unique constraint violations that
  // slipped through without an explicit application-level check first.
  // Checked by shape (duck-typed) rather than `instanceof Prisma.
  // PrismaClientKnownRequestError` — that export's typing has proven
  // inconsistent across Prisma client builds/environments, and a `code`
  // field check is exactly as reliable here since Prisma's own error
  // classes always carry one.
  if (isPrismaKnownError(err)) {
    if (err.code === "P2002") {
      logger.warn({ requestId, path: req.path }, "Unique constraint violation");
      return res.status(409).json({
        error: { code: "CONFLICT", message: "Resource already exists", requestId },
      });
    }
    if (err.code === "P2025") {
      logger.warn({ requestId, path: req.path }, "Record not found");
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Resource not found", requestId },
      });
    }
  }

  // Anything unrecognized: log full detail server-side, but never leak
  // internals (stack traces, raw DB errors) to the client.
  logger.error({ err, requestId, path: req.path }, "Unhandled error");
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong", requestId },
  });
}
