import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { BadRequestError, ConflictError } from "../lib/errors";
import { requireOrderCustomerAccess } from "../lib/authz";
import { initiateStkPush, isValidKenyanPhone, normalizePhone } from "../lib/daraja";
import { verifyAndReconcile } from "../lib/reconciliation";
import { enqueuePaymentReconciliation } from "../lib/jobs";

export const paymentsRouter = Router();

const initiateSchema = z.object({
  phoneNumber: z.string().min(9),
});

// POST /orders/:id/payment-attempts
// Mounted under the orders router path in index.ts.
export const orderPaymentsRouter = Router({ mergeParams: true });

orderPaymentsRouter.post("/", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const paymentIdempotencyKey = req.header("Payment-Idempotency-Key");
  if (!paymentIdempotencyKey) {
    throw new BadRequestError("Payment-Idempotency-Key header is required");
  }

  const parsed = initiateSchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError("Invalid payment data", parsed.error.flatten());

  // Phone is captured FRESH here — deliberately independent of
  // User.phone. A customer may pay from a different M-Pesa number.
  if (!isValidKenyanPhone(parsed.data.phoneNumber)) {
    throw new BadRequestError("A valid Kenyan M-Pesa phone number is required");
  }
  const phoneNumber = normalizePhone(parsed.data.phoneNumber);

  const orderId = req.params.id;
  const order = await requireOrderCustomerAccess(req.user!.id, orderId);

  if (order.status !== "PENDING_PAYMENT") {
    throw new BadRequestError(`Order is not awaiting payment (status: ${order.status})`);
  }

  // Idempotent replay of the same initiation request.
  const existing = await prisma.paymentAttempt.findUnique({
    where: { orderId_paymentIdempotencyKey: { orderId, paymentIdempotencyKey } },
  });
  if (existing) return res.status(200).json(existing);

  const items = await prisma.orderItem.findMany({ where: { orderId } });
  const amount = items.reduce((sum: number, i: { subtotal: number }) => sum + i.subtotal, 0);
  if (amount <= 0) throw new BadRequestError("Order total must be greater than zero");

  const reconciliationDelayMs = Number(process.env.RECONCILIATION_FIRST_CHECK_MS || 45_000);

  let attempt;
  try {
    attempt = await prisma.paymentAttempt.create({
      data: {
        orderId,
        status: "PENDING",
        amount,
        currency: "KES",
        phoneNumber,
        paymentIdempotencyKey,
        deadlineAt: new Date(Date.now() + reconciliationDelayMs),
        deadlineReason: "PAYMENT_RECONCILIATION",
      },
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      // Either the same idempotency key raced us, or — critically — an
      // attempt in PENDING/TIMEOUT/UNKNOWN already holds the
      // one-active-per-order partial unique index. The latter is the
      // database-enforced guarantee against double-charging a customer
      // whose first attempt merely timed out.
      const replay = await prisma.paymentAttempt.findUnique({
        where: { orderId_paymentIdempotencyKey: { orderId, paymentIdempotencyKey } },
      });
      if (replay) return res.status(200).json(replay);

      throw new ConflictError(
        "This order already has an active payment attempt. It must reach SUCCESS or FAILED before a new attempt can be made."
      );
    }
    throw err;
  }

  const push = await initiateStkPush({
    phoneNumber,
    amount,
    accountReference: orderId.slice(0, 12),
    description: "FoodyPop order",
  });

  if (push.kind === "initiated") {
    // Schedule the first reconciliation check via pg-boss. deadlineAt on
    // the row stays authoritative; the sweep re-enqueues anything whose
    // job was lost.
    await enqueuePaymentReconciliation(
      attempt.id,
      Math.ceil(reconciliationDelayMs / 1000)
    ).catch((err) => logger.error({ err, paymentAttemptId: attempt.id }, "Failed to enqueue reconciliation"));

    const updated = await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        providerRequestId: push.merchantRequestId ?? null,
        providerCheckoutId: push.checkoutRequestId ?? null,
      },
    });
    return res.status(201).json(updated);
  }

  // Push rejected or Daraja unreachable. The attempt stays PENDING and
  // reconcilable — we must NOT assume no money moved. It is recorded and
  // left for reconciliation rather than marked FAILED.
  await prisma.reconciliationAttempt.create({
    data: {
      paymentAttemptId: attempt.id,
      outcome: push.kind === "unreachable" ? "PROVIDER_UNREACHABLE" : "PROVIDER_UNKNOWN",
      errorDetail: push.error,
      providerResponse: push.kind === "rejected" ? (push.raw as object) : undefined,
    },
  });

  // Even a failed push must be reconciled — we cannot assume no money
  // moved. Enqueue so the attempt is resolved rather than abandoned.
  await enqueuePaymentReconciliation(
    attempt.id,
    Math.ceil(reconciliationDelayMs / 1000)
  ).catch((err) => logger.error({ err, paymentAttemptId: attempt.id }, "Failed to enqueue reconciliation"));

  logger.warn({ paymentAttemptId: attempt.id, kind: push.kind }, "STK Push did not initiate cleanly");
  return res.status(202).json(attempt);
}));

// POST /payments/callback/daraja — PUBLIC, UNAUTHENTICATED, UNTRUSTED.
// The payload is a trigger only. It never sets payment state; we always
// go back to Daraja's Transaction Status API for the authoritative
// answer. Always returns 200 so Daraja does not retry-storm us.
paymentsRouter.post("/callback/daraja", asyncHandler(async (req, res) => {
  const body = req.body as {
    Body?: { stkCallback?: { CheckoutRequestID?: string; ResultCode?: number; ResultDesc?: string } };
  };
  const checkoutRequestId = body?.Body?.stkCallback?.CheckoutRequestID;

  logger.info({ checkoutRequestId }, "Daraja callback received (untrusted trigger)");

  if (!checkoutRequestId) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const attempt = await prisma.paymentAttempt.findFirst({
    where: { providerCheckoutId: checkoutRequestId },
  });

  if (!attempt) {
    logger.warn({ checkoutRequestId }, "Callback for unknown checkout id");
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  // Deliberately ignore the callback's claimed ResultCode entirely.
  await verifyAndReconcile(attempt.id);

  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
}));
