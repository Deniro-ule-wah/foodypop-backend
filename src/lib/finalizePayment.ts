import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";

/**
 * THE ONLY successful-payment gate in FoodyPop V2.
 *
 * Neither the Order domain nor the Payments domain may independently
 * commit any part of this boundary — that is exactly how two
 * transaction boundaries (and therefore duplicate or partial financial
 * state) get created. Both domains contribute validation/shaping
 * helpers; this function owns the transaction.
 *
 * Four writes, one Postgres transaction, all-or-nothing:
 *   1. PaymentAttempt -> SUCCESS
 *   2. Order          -> PAID
 *   3. LedgerEntry    -> created
 *   4. OrderEvent     -> ORDER_PAID
 *
 * Safe against: duplicate callbacks, callback+worker races, repeated
 * reconciliation, late SUCCESS after TIMEOUT, late SUCCESS after
 * UNKNOWN, and concurrent finalization. The safety mechanism is the
 * conditional updateMany below — NOT an application-level check —
 * because only the database can win a genuine race.
 */

export interface ProviderVerification {
  providerReceipt?: string;
  providerReference?: string;
  raw?: unknown;
}

export interface FinalizationResult {
  finalized: boolean;
  reason?: "already_finalized" | "not_active";
  orderId?: string;
  ledgerEntryId?: string;
}

// TIMEOUT and UNKNOWN are NOT terminal — an attempt in either state may
// still legitimately resolve to SUCCESS. All three are "active".
const ACTIVE_STATUSES = ["PENDING", "TIMEOUT", "UNKNOWN"] as const;

export async function finalizeSuccessfulPayment(
  paymentAttemptId: string,
  providerVerification: ProviderVerification
): Promise<FinalizationResult> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Conditional update IS the concurrency control. If a concurrent
    // caller already finalized this attempt, `count` comes back 0 and we
    // no-op rather than double-applying the financial effect.
    const claimed = await tx.paymentAttempt.updateMany({
      where: {
        id: paymentAttemptId,
        status: { in: [...ACTIVE_STATUSES] },
      },
      data: {
        status: "SUCCESS",
        providerReceipt: providerVerification.providerReceipt ?? undefined,
        deadlineAt: null,
        deadlineReason: null,
      },
    });

    if (claimed.count === 0) {
      // Either already SUCCESS (duplicate finalization — benign and
      // expected) or FAILED (cannot be resurrected).
      const existing = await tx.paymentAttempt.findUnique({
        where: { id: paymentAttemptId },
        select: { status: true, orderId: true },
      });

      logger.info(
        { paymentAttemptId, currentStatus: existing?.status },
        "finalizeSuccessfulPayment no-op: attempt was not in an active state"
      );

      const reason = existing?.status === "SUCCESS" ? "already_finalized" : "not_active";

      return {
        finalized: false,
        reason,
        orderId: existing?.orderId,
      };
    }

    const attempt = await tx.paymentAttempt.findUniqueOrThrow({
      where: { id: paymentAttemptId },
    });

    // Order -> PAID, then immediately into PENDING_VENDOR_ACCEPTANCE:
    // payment success does NOT mean the vendor has accepted the
    // fulfilment obligation, so the order must land in a state that
    // still requires an explicit vendor decision.
    await tx.order.update({
      where: { id: attempt.orderId },
      data: {
        status: "PENDING_VENDOR_ACCEPTANCE",
        deadlineAt: null,
        deadlineReason: null,
      },
    });

    // Ledger: records the financial facts KNOWN AT PAYMENT TIME.
    // fees/commission/vendorPayableAmount/settlementState are left NULL
    // because their business policy is genuinely undefined — writing a
    // fabricated zero would be worse than an honest NULL.
    const ledgerEntry = await tx.ledgerEntry.create({
      data: {
        paymentAttemptId: attempt.id,
        orderId: attempt.orderId,
        grossAmount: attempt.amount,
        currency: attempt.currency,
        providerReference:
          providerVerification.providerReference ??
          providerVerification.providerReceipt ??
          attempt.providerCheckoutId,
      },
    });

    // Single canonical event, written in THIS transaction (transactional
    // outbox). Carries stable identifiers only — it is not a duplicate
    // copy of the ledger.
    await tx.orderEvent.create({
      data: {
        orderId: attempt.orderId,
        eventType: "ORDER_PAID",
        version: 1,
        payload: {
          orderId: attempt.orderId,
          paymentAttemptId: attempt.id,
          ledgerEntryId: ledgerEntry.id,
          amount: attempt.amount,
          currency: attempt.currency,
        },
      },
    });

    logger.info(
      { paymentAttemptId, orderId: attempt.orderId, ledgerEntryId: ledgerEntry.id },
      "Payment finalized"
    );

    return {
      finalized: true,
      orderId: attempt.orderId,
      ledgerEntryId: ledgerEntry.id,
    };
  });
}
