import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { UnauthorizedError } from "../lib/errors";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

export interface AuthedRequest extends Request {
  user?: { id: string; accountType: string };
}

// Attaches req.user if a valid token is present. Does NOT block the
// request — routes decide for themselves whether auth is required
// (via requireAuth below), so existing unauthenticated routes keep
// working exactly as before until they're explicitly updated.
export function attachUser(req: AuthedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const token = header.slice("Bearer ".length);
      const payload = jwt.verify(token, JWT_SECRET) as { id: string; accountType: string };
      req.user = payload;
    } catch {
      // UND-007 (Step 3): invalid or expired token — req.user is left undefined and the
      // request continues as anonymous. This is intentional: routes that do not call
      // requireAuth (e.g. GET /dishes/feed) remain accessible to unauthenticated callers.
      // However, a client with an expired token hitting an optional-auth route receives a
      // normal 200 response with no indication that the token has expired. Token expiry
      // detection is the client's responsibility — inspect the JWT `exp` claim locally
      // before sending the token. Routes that require auth use requireAuth (below), which
      // will return 401 UNAUTHORIZED in this case.
    }
  }
  next();
}

// Use on any route that must be authenticated. Throws through the
// centralized error handler (PH-001) rather than responding directly,
// so this produces the same standard error shape as every other error.
export function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new UnauthorizedError());
  }
  next();
}

export function signToken(user: { id: string; accountType: string }): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "30d" });
}
