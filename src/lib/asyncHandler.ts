import { Request, Response, NextFunction, RequestHandler } from "express";

// Express 4 does not automatically forward rejected promises from async
// route handlers to error-handling middleware — without this wrapper, an
// unhandled rejection in an async handler just hangs or crash-logs
// silently instead of producing a proper error response.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
