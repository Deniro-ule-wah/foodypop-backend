import { Router } from "express";
import { z } from "zod";
import { createHash, randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { BadRequestError, ForbiddenError, NotFoundError, ConflictError } from "../lib/errors";
import { parsePagination, buildPage } from "../lib/pagination";
import { requireOrderVendorAccess, requireOrderCustomerAccess, requireVendorMembership } from "../lib/authz";
import { assertTransitionAllowed, OrderStatusName } from "../lib/orderStateMachine";
import { enqueueOrderDeadline } from "../lib/jobs";
import { logger } from "../lib/logger";

export const ordersRouter = Router();

const createOrderSchema = z.object({
  vendorId: z.string().min(1),
  fulfillmentMode: z.enum(["PICKUP", "DELIVERY"]).default("PICKUP"),
  items: z.array(z.object({
    offeringId: z.string().min(1),
    quantity: z.number().int().positive(),
  })).min(1),
});

/**
 * Writes a state transition + its event in ONE transaction
 * (transactional outbox). Every lifecycle change goes through here so no
 * route can transition an order without emitting the matching event.
 */
async function transitionOrder(
  orderId: string,
  from: OrderStatusName,
  to: OrderStatusName,
  eventType: string,
  payload: Record<string, unknown>,
  extraData: Record<string, unknown> = {}
) {
  assertTransitionAllowed(from, to);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Conditional update: guards against a concurrent transition racing
    // this one (e.g. vendor clicks "ready" as the deadline worker fires).
    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: from },
      data: { status: to, ...extraData },
    });

    if (claimed.count === 0) {
      throw new ConflictError("Order state changed concurrently; please retry");
    }

    await tx.orderEvent.create({
      data: { orderId, eventType, version: 1, payload: { orderId, ...payload } },
    });

    return tx.order.findUniqueOrThrow({ where: { id: orderId } });
  });
}

// POST /orders — customer creates an order. Idempotency-Key header required.
ordersRouter.post("/", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const idempotencyKey = req.header("Idempotency-Key");
  if (!idempotencyKey) {
    throw new BadRequestError("Idempotency-Key header is required");
  }

  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError("Invalid order data", parsed.error.flatten());

  const customerId = req.user!.id;
  const { vendorId, fulfillmentMode, items } = parsed.data;

  // Idempotent replay: same key returns the existing order rather than
  // creating a second one.
  const existing = await prisma.order.findUnique({
    where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
    include: { items: true },
  });
  if (existing) {
    if (existing.vendorId !== vendorId) {
      throw new ConflictError("Idempotency-Key was already used for a different order");
    }
    return res.status(200).json(existing);
  }

  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) throw new NotFoundError("Vendor not found");

  // Revalidate availability against PostgreSQL — never trust a
  // client-supplied price or a stale search/read model.
  const offeringIds = items.map((i) => i.offeringId);
  const dishes = await prisma.dish.findMany({ where: { id: { in: offeringIds } } });

  const itemRows = items.map((item) => {
    const dish = dishes.find((d: { id: string }) => d.id === item.offeringId);
    if (!dish) throw new NotFoundError(`Offering not found: ${item.offeringId}`);
    if (dish.vendorId !== vendorId) {
      throw new BadRequestError("All items must belong to the same vendor (one order = one vendor)");
    }
    if (!dish.isAvailable) {
      throw new BadRequestError(`Offering is unavailable: ${dish.name}`);
    }
    const unitPrice = dish.discountPrice ?? dish.price;
    return {
      offeringId: dish.id,
      quantity: item.quantity,
      unitPrice,
      subtotal: unitPrice * item.quantity,
    };
  });

  try {
    const order = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.order.create({
        data: {
          customerId,
          vendorId,
          fulfillmentMode,
          idempotencyKey,
          status: "PENDING_PAYMENT",
          items: { create: itemRows },
        },
        include: { items: true },
      });

      await tx.orderEvent.create({
        data: {
          orderId: created.id,
          eventType: "ORDER_CREATED",
          version: 1,
          payload: {
            orderId: created.id,
            vendorId,
            customerId,
            itemCount: itemRows.length,
            total: itemRows.reduce((sum, i) => sum + i.subtotal, 0),
          },
        },
      });

      return created;
    });

    return res.status(201).json(order);
  } catch (err) {
    // Unique-constraint violation = a concurrent request with the same
    // key won the race. The constraint IS the concurrency control.
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      const winner = await prisma.order.findUnique({
        where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
        include: { items: true },
      });
      if (winner) return res.status(200).json(winner);
    }
    throw err;
  }
}));

// GET /orders — scoped list. Customer sees own; vendor members see their vendor's.
ordersRouter.get("/", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const pagination = parsePagination(req);
  const vendorId = typeof req.query.vendorId === "string" ? req.query.vendorId : undefined;

  if (vendorId) {
    await requireVendorMembership(req.user!.id, vendorId);
  }

  const orders = await prisma.order.findMany({
    where: vendorId ? { vendorId } : { customerId: req.user!.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...pagination.prismaArgs,
    include: { items: true },
  });

  res.json(buildPage(orders, pagination.limit));
}));

// GET /orders/:id — customer-owner OR any active member of the order's vendor.
ordersRouter.get("/:id", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { items: true, events: { orderBy: { createdAt: "desc" } } },
  });
  if (!order) throw new NotFoundError("Order not found");

  if (order.customerId !== req.user!.id) {
    await requireVendorMembership(req.user!.id, order.vendorId);
  }

  // Deliberately excludes PaymentAttempt/Ledger data — internal
  // financial detail never routes through customer/vendor Order APIs.
  res.json(order);
}));

// POST /orders/:id/accept — OWNER, MANAGER and STAFF are all permitted.
ordersRouter.post("/:id/accept", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const order = await requireOrderVendorAccess(req.user!.id, req.params.id);

  const accepted = await transitionOrder(
    order.id, order.status as OrderStatusName, "ACCEPTED",
    "ORDER_ACCEPTED", { actorUserId: req.user!.id }
  );

  // Acceptance starts preparation immediately.
  const preparing = await transitionOrder(
    accepted.id, "ACCEPTED", "PREPARING",
    "ORDER_PREPARING", { actorUserId: req.user!.id },
    { deadlineAt: null, deadlineReason: null }
  );

  res.json(preparing);
}));

const rejectSchema = z.object({
  reason: z.enum([
    "ITEM_UNAVAILABLE", "VENDOR_UNABLE", "CAPACITY_EXCEEDED",
    "VENDOR_CLOSING", "OPERATIONAL_ISSUE", "OTHER",
  ]),
});

// POST /orders/:id/reject — records a refund obligation; does NOT move money.
ordersRouter.post("/:id/reject", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError("Invalid rejection data", parsed.error.flatten());

  const order = await requireOrderVendorAccess(req.user!.id, req.params.id);

  const rejected = await transitionOrder(
    order.id, order.status as OrderStatusName, "VENDOR_REJECTED",
    "ORDER_VENDOR_REJECTED", { actorUserId: req.user!.id, reason: parsed.data.reason },
    { deadlineAt: null, deadlineReason: null }
  );

  await recordRefundObligation(order.id, "VENDOR_REJECTED");
  res.json(rejected);
}));

// POST /orders/:id/ready — issues the single-use pickup credential.
ordersRouter.post("/:id/ready", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const order = await requireOrderVendorAccess(req.user!.id, req.params.id);

  // 6-digit PIN, doubles as the QR payload. Stored hashed — never as
  // reusable plaintext.
  const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
  const codeHash = createHash("sha256").update(`${order.id}:${code}`).digest("hex");

  const pickupDeadlineMinutes = Number(process.env.PICKUP_DEADLINE_MINUTES || 120);

  const updated = await transitionOrder(
    order.id, order.status as OrderStatusName, "READY_FOR_PICKUP",
    "ORDER_READY_FOR_PICKUP", { actorUserId: req.user!.id },
    {
      deadlineAt: new Date(Date.now() + pickupDeadlineMinutes * 60_000),
      deadlineReason: "PICKUP",
    }
  );

  // Deadline job deferred to the pickup deadline — pg-boss, not a timer.
  if (updated.deadlineAt) {
    await enqueueOrderDeadline(order.id, updated.deadlineAt).catch((err) =>
      logger.error({ err, orderId: order.id }, "Failed to enqueue pickup deadline")
    );
  }

  await prisma.pickupCredential.upsert({
    where: { orderId: order.id },
    update: { codeHash, status: "UNUSED", issuedAt: new Date(), usedAt: null, usedBy: null },
    create: { orderId: order.id, codeHash, channel: "QR", status: "UNUSED" },
  });

  // Plaintext code returned exactly once, for the customer to present.
  res.json({ ...updated, pickupCode: code });
}));

const verifyPickupSchema = z.object({ code: z.string().min(1) });

// POST /orders/:id/verify-pickup — vendor verifies the customer's code.
// Vendor assertion alone can never complete an order.
ordersRouter.post("/:id/verify-pickup", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = verifyPickupSchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError("Invalid verification data", parsed.error.flatten());

  const order = await requireOrderVendorAccess(req.user!.id, req.params.id);
  const codeHash = createHash("sha256").update(`${order.id}:${parsed.data.code}`).digest("hex");

  // Atomic claim: UPDATE ... WHERE status='UNUSED' is the concurrency
  // boundary. Two simultaneous verifications — only one can win.
  const claimed = await prisma.pickupCredential.updateMany({
    where: { orderId: order.id, codeHash, status: "UNUSED" },
    data: { status: "USED", usedAt: new Date(), usedBy: req.user!.id },
  });

  if (claimed.count === 0) {
    throw new ForbiddenError("Invalid or already-used pickup credential");
  }

  const collected = await transitionOrder(
    order.id, order.status as OrderStatusName, "COLLECTED",
    "ORDER_COLLECTED", { actorUserId: req.user!.id },
    { deadlineAt: null, deadlineReason: null }
  );

  // COLLECTED -> COMPLETED is the same business moment.
  const completed = await transitionOrder(
    collected.id, "COLLECTED", "COMPLETED",
    "ORDER_COMPLETED", { actorUserId: req.user!.id },
    { completedAt: new Date() }
  );

  res.json(completed);
}));

// POST /orders/:id/cancel — customer-initiated.
ordersRouter.post("/:id/cancel", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const order = await requireOrderCustomerAccess(req.user!.id, req.params.id);
  const current = order.status as OrderStatusName;

  if (current === "PAID" || current === "PENDING_VENDOR_ACCEPTANCE") {
    const cancelled = await transitionOrder(
      order.id, current, "CUSTOMER_CANCELLED",
      "ORDER_CUSTOMER_CANCELLED", { actorUserId: req.user!.id },
      { deadlineAt: null, deadlineReason: null }
    );
    await recordRefundObligation(order.id, "CUSTOMER_CANCELLED");
    return res.json(cancelled);
  }

  // Post-acceptance cancellation eligibility and refund percentage are
  // an unresolved financial policy. Rejecting rather than inventing one.
  if (current === "ACCEPTED" || current === "PREPARING") {
    throw new BadRequestError(
      "Post-acceptance cancellation policy is not yet defined; contact support",
      { orderStatus: current, policy: "BLOCKED_PENDING_DECISION" }
    );
  }

  throw new BadRequestError(`Order cannot be cancelled from status ${current}`);
}));

/**
 * Records that a refund is OWED. Does not move money — refund execution
 * (Daraja reversal/B2C) is explicitly out of V2 scope.
 * REFUND_PENDING does NOT mean the customer has been refunded.
 */
export async function recordRefundObligation(
  orderId: string,
  reason: "VENDOR_REJECTED" | "CUSTOMER_CANCELLED" | "DISPUTE_RESOLVED"
) {
  const successful = await prisma.paymentAttempt.findFirst({
    where: { orderId, status: "SUCCESS" },
    include: { ledgerEntry: true },
  });

  // No successful payment means no money was ever captured, so there is
  // nothing to refund.
  if (!successful) return null;

  const existing = await prisma.refundObligation.findFirst({ where: { orderId } });
  if (existing) return existing;

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const obligation = await tx.refundObligation.create({
      data: {
        orderId,
        originatingPaymentAttemptId: successful.id,
        ledgerEntryId: successful.ledgerEntry?.id ?? null,
        amount: successful.amount,
        currency: successful.currency,
        reason,
        status: "REFUND_PENDING",
      },
    });

    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: "REFUND_OBLIGATION_RECORDED",
        version: 1,
        payload: {
          orderId,
          refundObligationId: obligation.id,
          amount: successful.amount,
          currency: successful.currency,
          reason,
        },
      },
    });

    return obligation;
  });
}
