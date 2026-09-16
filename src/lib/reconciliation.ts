import { prisma } from "./prisma";
import { logger } from "./logger";
import { queryTransactionStatus } from "./daraja";
import { finalizeSuccessfulPayment } from "./finalizePayment";

// ONE shared verification path. The Daraja callback handler and the
// pg-boss reconciliation worker are two ENTRY POINTS into this same
// function — deliberately not two similar-but-separate implementations,
// which is how they would silently drift apart.

const BASE_BACKOFF_MS = Number(process.env.RECONCILIATION_BASE_BACKOFF_MS || 30_000);
const MAX_BACKOFF_MS = Number(process.env.RECONCILIATION_MAX_BACKOFF_MS || 15 * 60_000);

// Bounded, not an uncontrolled tight loop.
function nextBackoff(attemptCount: number): Date {
  const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, attemptCount), MAX_BACKOFF_MS);
  return new Date(Date.now() + delay);
}

export type ReconcileResult =
  | { outcome: "PROVIDER_SUCCESS"; finalized: boolean }
  | { outcome: "PROVIDER_FAILURE" }
  | { outcome: "PROVIDER_UNKNOWN" }
  | { outcome: "PROVIDER_UNREACHABLE" }
  | { outcome: "LOCAL_TIMEOUT" }
  | { outcome: "SKIPPED"; reason: string };

/**
 * Verifies a PaymentAttempt against Daraja's authoritative Transaction
 * Status API and applies the correct consequence.
 *
 * EVERY invocation writes a ReconciliationAttempt record — including the
 * unreachable case, which is precisely why that table exists: a
 * PROVIDER_UNREACHABLE event produces NO PaymentAttempt status change,
 * so it would otherwise leave no trace at all.
 */
export async function verifyAndReconcile(paymentAttemptId: string): Promise<ReconcileResult> {
  const attempt = await prisma.paymentAttempt.findUnique({
    where: { id: paymentAttemptId },
  });

  if (!attempt) {
    return { outcome: "SKIPPED", reason: "payment attempt not found" };
  }

  // SUCCESS and FAILED are terminal — nothing to reconcile.
  if (attempt.status === "SUCCESS" || attempt.status === "FAILED") {
    return { outcome: "SKIPPED", reason: `already terminal: ${attempt.status}` };
  }

  if (!attempt.providerCheckoutId) {
    // STK Push never successfully initiated, so there is nothing to
    // query. Leave status untouched; a deadline sweep handles it.
    await prisma.reconciliationAttempt.create({
      data: {
        paymentAttemptId,
        outcome: "PROVIDER_UNREACHABLE",
        errorDetail: "no providerCheckoutId — STK Push was never initiated",
      },
    });
    return { outcome: "PROVIDER_UNREACHABLE" };
  }

  const priorAttempts = await prisma.reconciliationAttempt.count({
    where: { paymentAttemptId },
  });

  const result = await queryTransactionStatus(attempt.providerCheckoutId);

  // --- Provider UNREACHABLE: infrastructure failure, NOT a payment
  // result. Status deliberately unchanged. Record + back off + retry.
  if (result.kind === "unreachable") {
    await prisma.$transaction([
      prisma.reconciliationAttempt.create({
        data: {
          paymentAttemptId,
          outcome: "PROVIDER_UNREACHABLE",
          errorDetail: result.error,
        },
      }),
      prisma.paymentAttempt.update({
        where: { id: paymentAttemptId },
        data: {
          // status intentionally NOT touched
          deadlineAt: nextBackoff(priorAttempts),
          deadlineReason: "PAYMENT_RECONCILIATION",
        },
      }),
    ]);
    logger.warn({ paymentAttemptId }, "Reconciliation: provider unreachable, status unchanged");
    return { outcome: "PROVIDER_UNREACHABLE" };
  }

  // --- Definitive SUCCESS: hand off to the single finalization gate.
  if (result.kind === "success") {
    await prisma.reconciliationAttempt.create({
      data: {
        paymentAttemptId,
        outcome: "PROVIDER_SUCCESS",
        providerResponse: result.raw as object,
      },
    });
    const finalization = await finalizeSuccessfulPayment(paymentAttemptId, {
      providerReceipt: result.receipt,
      raw: result.raw,
    });
    return { outcome: "PROVIDER_SUCCESS", finalized: finalization.finalized };
  }

  // --- Definitive FAILURE.
  if (result.kind === "failure") {
    await prisma.$transaction([
      prisma.reconciliationAttempt.create({
        data: {
          paymentAttemptId,
          outcome: "PROVIDER_FAILURE",
          providerResponse: result.raw as object,
          errorDetail: result.reason,
        },
      }),
      prisma.paymentAttempt.updateMany({
        where: { id: paymentAttemptId, status: { in: ["PENDING", "TIMEOUT", "UNKNOWN"] } },
        data: { status: "FAILED", deadlineAt: null, deadlineReason: null },
      }),
    ]);
    logger.info({ paymentAttemptId }, "Reconciliation: definitive failure");
    return { outcome: "PROVIDER_FAILURE" };
  }

  // --- Provider ANSWERED but ambiguously. Distinct from unreachable:
  // this DOES move status to UNKNOWN, and is recorded as a different
  // outcome so ops can tell the two apart.
  await prisma.$transaction([
    prisma.reconciliationAttempt.create({
      data: {
        paymentAttemptId,
        outcome: "PROVIDER_UNKNOWN",
        providerResponse: result.raw as object,
      },
    }),
    prisma.paymentAttempt.updateMany({
      where: { id: paymentAttemptId, status: { in: ["PENDING", "TIMEOUT"] } },
      data: { status: "UNKNOWN" },
    }),
    prisma.paymentAttempt.update({
      where: { id: paymentAttemptId },
      data: {
        deadlineAt: nextBackoff(priorAttempts),
        deadlineReason: "PAYMENT_RECONCILIATION",
      },
    }),
  ]);
  logger.info({ paymentAttemptId }, "Reconciliation: provider ambiguous");
  return { outcome: "PROVIDER_UNKNOWN" };
}

/**
 * Deadline-driven local timeout. Does NOT stop reconciliation — a
 * TIMEOUT attempt stays fully reconcilable and may still resolve to
 * SUCCESS later, which is why it continues to hold the
 * one-active-attempt lock.
 */
export async function markLocalTimeout(paymentAttemptId: string): Promise<ReconcileResult> {
  await prisma.$transaction([
    prisma.reconciliationAttempt.create({
      data: {
        paymentAttemptId,
        outcome: "LOCAL_TIMEOUT",
        errorDetail: "reconciliation deadline reached without definitive provider result",
      },
    }),
    prisma.paymentAttempt.updateMany({
      where: { id: paymentAttemptId, status: { in: ["PENDING", "UNKNOWN"] } },
      data: { status: "TIMEOUT" },
    }),
  ]);
  logger.info({ paymentAttemptId }, "Reconciliation: local timeout (still reconcilable)");
  return { outcome: "LOCAL_TIMEOUT" };
}
