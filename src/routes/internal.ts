import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { NotFoundError } from "../lib/errors";
import { requirePlatformStaff } from "../lib/authz";
import { parsePagination, buildPage } from "../lib/pagination";

export const internalRouter = Router();

// FoodyPop internal staff only. READ-ONLY by design — there are
// deliberately no mutation endpoints here. No PlatformStaff role may
// mutate Order or payment state, and refund EXECUTION is out of V2
// scope entirely, so no endpoint pretends to perform one.
//
// Note the inverse relationship with vendor roles: VendorMembership.STAFF
// can run fulfillment but sees nothing here; PlatformStaff sees
// financials but can mutate nothing.

// SUPPORT gets investigation-relevant fields; FINANCE/ADMIN get full
// financial detail. Same endpoint, different shape per role.
function scopePaymentForRole(
  attempt: Record<string, unknown>,
  role: string
): Record<string, unknown> {
  if (role === "FINANCE" || role === "ADMIN") return attempt;

  const {
    id, orderId, status, currency, createdAt, updatedAt,
    reconciliationAttempts,
  } = attempt as Record<string, unknown>;

  // SUPPORT/OPS: enough to investigate a case, without full financial
  // exposure (no amount, no provider receipt, no ledger).
  return { id, orderId, status, currency, createdAt, updatedAt, reconciliationAttempts };
}

// GET /internal/payments/:paymentAttemptId
internalRouter.get("/payments/:paymentAttemptId", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const staff = await requirePlatformStaff(req.user!.id, ["SUPPORT", "OPS", "FINANCE", "ADMIN"]);

  const attempt = await prisma.paymentAttempt.findUnique({
    where: { id: req.params.paymentAttemptId },
    include: {
      reconciliationAttempts: { orderBy: { attemptedAt: "desc" } },
      ledgerEntry: true,
    },
  });

  if (!attempt) throw new NotFoundError("Payment attempt not found");

  res.json(scopePaymentForRole(attempt as unknown as Record<string, unknown>, staff.role));
}));

// GET /internal/ledger — FINANCE and ADMIN only.
internalRouter.get("/ledger", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  await requirePlatformStaff(req.user!.id, ["FINANCE", "ADMIN"]);

  const pagination = parsePagination(req);
  const entries = await prisma.ledgerEntry.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...pagination.prismaArgs,
  });

  res.json(buildPage(entries, pagination.limit));
}));

// GET /internal/refund-obligations
internalRouter.get("/refund-obligations", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  await requirePlatformStaff(req.user!.id, ["SUPPORT", "FINANCE", "ADMIN"]);

  const pagination = parsePagination(req);
  const obligations = await prisma.refundObligation.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...pagination.prismaArgs,
  });

  res.json(buildPage(obligations, pagination.limit));
}));
