/**
 * PG-BOSS INTEGRATION TESTS — require a real PostgreSQL database.
 *
 * NOT EXECUTED in the authoring environment (no Docker/Postgres there).
 * Written to run on a machine with the V2 migration applied:
 *
 *   docker compose up -d
 *   npx prisma migrate deploy
 *   npx vitest run tests/pgboss.integration.test.ts
 *
 * pg-boss creates its own schema (default: "pgboss") on first start;
 * no separate migration is needed for the queue tables themselves.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { startBoss, stopBoss, getBoss, bossHealth, QUEUE_PAYMENT_RECONCILIATION } from "../src/lib/boss";
import { registerWorkers, handlePaymentReconciliation, handleOrderDeadline } from "../src/worker/jobHandlers";
import { enqueuePaymentReconciliation } from "../src/lib/jobs";

const prisma = new PrismaClient();

let customerId: string;
let vendorId: string;
let dishId: string;

beforeAll(async () => {
  const suffix = Date.now();
  const customer = await prisma.user.create({
    data: { displayName: "PB Customer", email: `pb${suffix}@test.dev`, accountType: "CONSUMER" },
  });
  customerId = customer.id;

  const owner = await prisma.user.create({
    data: { displayName: "PB Owner", email: `pbo${suffix}@test.dev`, accountType: "VENDOR" },
  });
  const vendor = await prisma.vendor.create({ data: { userId: owner.id, name: `PB Vendor ${suffix}` } });
  vendorId = vendor.id;
  await prisma.vendorMembership.create({
    data: { userId: owner.id, vendorId: vendor.id, role: "OWNER" },
  });

  const dish = await prisma.dish.create({
    data: { name: `PB Dish ${suffix}`, price: 500, vendorId: vendor.id, isAvailable: true },
  });
  dishId = dish.id;

  await startBoss();
}, 60_000);

afterAll(async () => {
  await stopBoss();
  await prisma.$disconnect();
}, 30_000);

async function makeAttempt(status: "PENDING" | "TIMEOUT" | "UNKNOWN" | "SUCCESS" | "FAILED") {
  const order = await prisma.order.create({
    data: {
      customerId,
      vendorId,
      status: "PAID",
      idempotencyKey: `pb-${Date.now()}-${Math.random()}`,
      items: { create: [{ offeringId: dishId, quantity: 1, unitPrice: 500, subtotal: 500 }] },
    },
  });
  return prisma.paymentAttempt.create({
    data: {
      orderId: order.id,
      status,
      amount: 500,
      phoneNumber: "254712345678",
      paymentIdempotencyKey: `pbk-${Date.now()}-${Math.random()}`,
    },
  });
}

describe("pg-boss startup", () => {
  it("starts and reports healthy", () => {
    const health = bossHealth();
    expect(health.started).toBe(true);
    expect(health.queues).toContain(QUEUE_PAYMENT_RECONCILIATION);
    expect(health.queues).toContain("RECONCILIATION_SWEEP");
  });

  it("creates the required queues", async () => {
    const queues = await getBoss().getQueues();
    const names = queues.map((q: { name: string }) => q.name);
    expect(names).toContain(QUEUE_PAYMENT_RECONCILIATION);
    expect(names).toContain("ORDER_DEADLINE");
    expect(names).toContain("RECONCILIATION_SWEEP");
  });

  it("registers workers without error", async () => {
    await expect(registerWorkers()).resolves.not.toThrow();
  });
});

describe("PAYMENT_RECONCILIATION job enqueue", () => {
  it("enqueues a job and returns an id", async () => {
    const attempt = await makeAttempt("PENDING");
    const jobId = await enqueuePaymentReconciliation(attempt.id);
    expect(jobId).toBeTruthy();
  });

  it("singletonKey prevents a duplicate active job for the same attempt", async () => {
    const attempt = await makeAttempt("PENDING");
    const first = await enqueuePaymentReconciliation(attempt.id);
    const second = await enqueuePaymentReconciliation(attempt.id);

    expect(first).toBeTruthy();
    // pg-boss returns null when a singleton job is already queued.
    expect(second).toBeNull();
  });
});

describe("PAYMENT_RECONCILIATION handler semantics", () => {
  it("discards a job for an unknown attempt without throwing", async () => {
    await expect(
      handlePaymentReconciliation([{ id: "j1", name: QUEUE_PAYMENT_RECONCILIATION, data: { paymentAttemptId: "does-not-exist" } } as never])
    ).resolves.not.toThrow();
  });

  it.each(["SUCCESS", "FAILED"] as const)(
    "does no work when the attempt is already terminal (%s)",
    async (status) => {
      const attempt = await makeAttempt(status);
      const before = await prisma.reconciliationAttempt.count({ where: { paymentAttemptId: attempt.id } });

      await handlePaymentReconciliation([
        { id: "j2", name: QUEUE_PAYMENT_RECONCILIATION, data: { paymentAttemptId: attempt.id } } as never,
      ]);

      const after = await prisma.reconciliationAttempt.count({ where: { paymentAttemptId: attempt.id } });
      expect(after).toBe(before);
    }
  );

  it("THROWS on a non-definitive outcome so pg-boss retries", async () => {
    // No providerCheckoutId => reconciliation records PROVIDER_UNREACHABLE.
    // The handler must throw, delegating backoff to pg-boss rather than
    // silently completing the job.
    const attempt = await makeAttempt("PENDING");

    await expect(
      handlePaymentReconciliation([
        { id: "j3", name: QUEUE_PAYMENT_RECONCILIATION, data: { paymentAttemptId: attempt.id } } as never,
      ])
    ).rejects.toThrow();

    // Critically: status must be UNCHANGED. Unreachable is an
    // infrastructure failure, never a payment result.
    const after = await prisma.paymentAttempt.findUnique({ where: { id: attempt.id } });
    expect(after?.status).toBe("PENDING");

    const records = await prisma.reconciliationAttempt.findMany({
      where: { paymentAttemptId: attempt.id },
    });
    expect(records.some((r: { outcome: string }) => r.outcome === "PROVIDER_UNREACHABLE")).toBe(true);
  });
});

describe("ORDER_DEADLINE handler semantics", () => {
  it("PICKUP deadline transitions READY_FOR_PICKUP -> NO_SHOW", async () => {
    const order = await prisma.order.create({
      data: {
        customerId, vendorId, status: "READY_FOR_PICKUP",
        idempotencyKey: `ns-${Date.now()}-${Math.random()}`,
        deadlineAt: new Date(Date.now() - 1000),
        deadlineReason: "PICKUP",
      },
    });

    await handleOrderDeadline([{ id: "d1", name: "ORDER_DEADLINE", data: { orderId: order.id } } as never]);

    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after?.status).toBe("NO_SHOW");

    const events = await prisma.orderEvent.findMany({
      where: { orderId: order.id, eventType: "ORDER_NO_SHOW" },
    });
    expect(events).toHaveLength(1);
  });

  it("PREPARATION deadline escalates and does NOT cancel the order", async () => {
    const order = await prisma.order.create({
      data: {
        customerId, vendorId, status: "PREPARING",
        idempotencyKey: `pr-${Date.now()}-${Math.random()}`,
        deadlineAt: new Date(Date.now() - 1000),
        deadlineReason: "PREPARATION",
      },
    });

    await handleOrderDeadline([{ id: "d2", name: "ORDER_DEADLINE", data: { orderId: order.id } } as never]);

    const after = await prisma.order.findUnique({ where: { id: order.id } });
    // Still PREPARING — escalation only, never auto-cancellation.
    expect(after?.status).toBe("PREPARING");

    const events = await prisma.orderEvent.findMany({
      where: { orderId: order.id, eventType: "ORDER_PREPARATION_OVERDUE" },
    });
    expect(events).toHaveLength(1);
  });

  it("ignores a deadline that has since been rescheduled into the future", async () => {
    const order = await prisma.order.create({
      data: {
        customerId, vendorId, status: "READY_FOR_PICKUP",
        idempotencyKey: `fu-${Date.now()}-${Math.random()}`,
        deadlineAt: new Date(Date.now() + 60_000),
        deadlineReason: "PICKUP",
      },
    });

    await handleOrderDeadline([{ id: "d3", name: "ORDER_DEADLINE", data: { orderId: order.id } } as never]);

    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after?.status).toBe("READY_FOR_PICKUP");
  });
});

describe("Graceful shutdown", () => {
  it("stops cleanly and reports not-started afterwards", async () => {
    await stopBoss();
    expect(bossHealth().started).toBe(false);

    // Restart so afterAll's stopBoss() is a no-op rather than an error.
    await startBoss();
    expect(bossHealth().started).toBe(true);
  }, 30_000);
});
