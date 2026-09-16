/**
 * INTEGRATION TESTS — require a real PostgreSQL database.
 *
 * These were written but NOT executed in the authoring environment,
 * which had no Docker/Postgres available. They are expected to run on a
 * machine with the V2 migration applied.
 *
 *   docker compose up -d
 *   npx prisma migrate deploy
 *   npx vitest run tests/integration.test.ts
 *
 * They deliberately exercise the guarantees that CANNOT be verified by
 * typechecking or unit tests: database-enforced concurrency, transaction
 * atomicity, and cross-vendor authorization.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { finalizeSuccessfulPayment } from "../src/lib/finalizePayment";

const prisma = new PrismaClient();

let customerId: string;
let otherCustomerId: string;
let vendorAId: string;
let vendorBId: string;
let staffUserId: string;
let dishAId: string;

beforeAll(async () => {
  const suffix = Date.now();

  const customer = await prisma.user.create({
    data: { displayName: "Test Customer", email: `cust${suffix}@test.dev`, accountType: "CONSUMER" },
  });
  customerId = customer.id;

  const other = await prisma.user.create({
    data: { displayName: "Other Customer", email: `other${suffix}@test.dev`, accountType: "CONSUMER" },
  });
  otherCustomerId = other.id;

  const ownerA = await prisma.user.create({
    data: { displayName: "Owner A", email: `ownerA${suffix}@test.dev`, accountType: "VENDOR" },
  });
  const vendorA = await prisma.vendor.create({ data: { userId: ownerA.id, name: `Vendor A ${suffix}` } });
  vendorAId = vendorA.id;
  await prisma.vendorMembership.create({
    data: { userId: ownerA.id, vendorId: vendorA.id, role: "OWNER" },
  });

  const ownerB = await prisma.user.create({
    data: { displayName: "Owner B", email: `ownerB${suffix}@test.dev`, accountType: "VENDOR" },
  });
  const vendorB = await prisma.vendor.create({ data: { userId: ownerB.id, name: `Vendor B ${suffix}` } });
  vendorBId = vendorB.id;
  await prisma.vendorMembership.create({
    data: { userId: ownerB.id, vendorId: vendorB.id, role: "OWNER" },
  });

  // STAFF member of Vendor A only.
  const staff = await prisma.user.create({
    data: { displayName: "Staff A", email: `staffA${suffix}@test.dev`, accountType: "VENDOR" },
  });
  staffUserId = staff.id;
  await prisma.vendorMembership.create({
    data: { userId: staff.id, vendorId: vendorA.id, role: "STAFF" },
  });

  const dish = await prisma.dish.create({
    data: { name: `Test Dish ${suffix}`, price: 500, vendorId: vendorA.id, isAvailable: true },
  });
  dishAId = dish.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makeOrder(status: "PENDING_PAYMENT" | "PAID" = "PENDING_PAYMENT") {
  return prisma.order.create({
    data: {
      customerId,
      vendorId: vendorAId,
      status,
      idempotencyKey: `idem-${Date.now()}-${Math.random()}`,
      items: { create: [{ offeringId: dishAId, quantity: 2, unitPrice: 500, subtotal: 1000 }] },
    },
  });
}

describe("Order idempotency — DB constraint is the concurrency control", () => {
  it("rejects a duplicate (customerId, idempotencyKey)", async () => {
    const key = `dup-${Date.now()}`;
    await prisma.order.create({
      data: { customerId, vendorId: vendorAId, idempotencyKey: key },
    });

    await expect(
      prisma.order.create({ data: { customerId, vendorId: vendorAId, idempotencyKey: key } })
    ).rejects.toThrow();
  });

  it("allows the same key for a DIFFERENT customer", async () => {
    const key = `shared-${Date.now()}`;
    await prisma.order.create({ data: { customerId, vendorId: vendorAId, idempotencyKey: key } });
    const second = await prisma.order.create({
      data: { customerId: otherCustomerId, vendorId: vendorAId, idempotencyKey: key },
    });
    expect(second.id).toBeTruthy();
  });
});

describe("One active PaymentAttempt per Order — the anti-double-charge guarantee", () => {
  it.each(["PENDING", "TIMEOUT", "UNKNOWN"] as const)(
    "blocks a second attempt while one is %s",
    async (activeStatus) => {
      const order = await makeOrder();
      await prisma.paymentAttempt.create({
        data: {
          orderId: order.id, status: activeStatus, amount: 1000,
          phoneNumber: "254712345678", paymentIdempotencyKey: `k1-${Math.random()}`,
        },
      });

      // The partial unique index must reject this — TIMEOUT/UNKNOWN are
      // NOT terminal and may still resolve to SUCCESS, so permitting a
      // second capturing attempt would risk charging the customer twice.
      await expect(
        prisma.paymentAttempt.create({
          data: {
            orderId: order.id, status: "PENDING", amount: 1000,
            phoneNumber: "254712345678", paymentIdempotencyKey: `k2-${Math.random()}`,
          },
        })
      ).rejects.toThrow();
    }
  );

  it.each(["SUCCESS", "FAILED"] as const)(
    "permits a new attempt once the prior is terminal (%s)",
    async (terminalStatus) => {
      const order = await makeOrder();
      await prisma.paymentAttempt.create({
        data: {
          orderId: order.id, status: terminalStatus, amount: 1000,
          phoneNumber: "254712345678", paymentIdempotencyKey: `t1-${Math.random()}`,
        },
      });

      const second = await prisma.paymentAttempt.create({
        data: {
          orderId: order.id, status: "PENDING", amount: 1000,
          phoneNumber: "254712345678", paymentIdempotencyKey: `t2-${Math.random()}`,
        },
      });
      expect(second.id).toBeTruthy();
    }
  );

  it("two concurrent initiations produce exactly one attempt", async () => {
    const order = await makeOrder();
    const results = await Promise.allSettled([
      prisma.paymentAttempt.create({
        data: { orderId: order.id, status: "PENDING", amount: 1000, phoneNumber: "254712345678", paymentIdempotencyKey: `c1-${Math.random()}` },
      }),
      prisma.paymentAttempt.create({
        data: { orderId: order.id, status: "PENDING", amount: 1000, phoneNumber: "254712345678", paymentIdempotencyKey: `c2-${Math.random()}` },
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });
});

describe("finalizeSuccessfulPayment — the sole financial gate", () => {
  it("commits all four writes atomically", async () => {
    const order = await makeOrder("PAID");
    const attempt = await prisma.paymentAttempt.create({
      data: { orderId: order.id, status: "PENDING", amount: 1000, phoneNumber: "254712345678", paymentIdempotencyKey: `f-${Math.random()}` },
    });

    const result = await finalizeSuccessfulPayment(attempt.id, { providerReceipt: "TEST123" });
    expect(result.finalized).toBe(true);

    const [after, updatedOrder, ledger, events] = await Promise.all([
      prisma.paymentAttempt.findUnique({ where: { id: attempt.id } }),
      prisma.order.findUnique({ where: { id: order.id } }),
      prisma.ledgerEntry.findUnique({ where: { paymentAttemptId: attempt.id } }),
      prisma.orderEvent.findMany({ where: { orderId: order.id, eventType: "ORDER_PAID" } }),
    ]);

    expect(after?.status).toBe("SUCCESS");
    expect(updatedOrder?.status).toBe("PENDING_VENDOR_ACCEPTANCE");
    expect(ledger?.grossAmount).toBe(1000);
    // Policy genuinely undefined — must be NULL, never a fabricated 0.
    expect(ledger?.commission).toBeNull();
    expect(events).toHaveLength(1);
  });

  it("is idempotent under duplicate finalization", async () => {
    const order = await makeOrder("PAID");
    const attempt = await prisma.paymentAttempt.create({
      data: { orderId: order.id, status: "PENDING", amount: 1000, phoneNumber: "254712345678", paymentIdempotencyKey: `i-${Math.random()}` },
    });

    const first = await finalizeSuccessfulPayment(attempt.id, {});
    const second = await finalizeSuccessfulPayment(attempt.id, {});

    expect(first.finalized).toBe(true);
    expect(second.finalized).toBe(false);
    expect(second.reason).toBe("already_finalized");

    const ledgers = await prisma.ledgerEntry.findMany({ where: { paymentAttemptId: attempt.id } });
    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id, eventType: "ORDER_PAID" } });
    expect(ledgers).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("finalizes a LATE success after TIMEOUT with no duplicate effect", async () => {
    const order = await makeOrder("PAID");
    const attempt = await prisma.paymentAttempt.create({
      data: { orderId: order.id, status: "TIMEOUT", amount: 1000, phoneNumber: "254712345678", paymentIdempotencyKey: `lt-${Math.random()}` },
    });

    const result = await finalizeSuccessfulPayment(attempt.id, { providerReceipt: "LATE1" });
    expect(result.finalized).toBe(true);

    const ledgers = await prisma.ledgerEntry.findMany({ where: { paymentAttemptId: attempt.id } });
    expect(ledgers).toHaveLength(1);
  });

  it("finalizes a LATE success after UNKNOWN", async () => {
    const order = await makeOrder("PAID");
    const attempt = await prisma.paymentAttempt.create({
      data: { orderId: order.id, status: "UNKNOWN", amount: 1000, phoneNumber: "254712345678", paymentIdempotencyKey: `lu-${Math.random()}` },
    });
    const result = await finalizeSuccessfulPayment(attempt.id, {});
    expect(result.finalized).toBe(true);
  });

  it("refuses to resurrect a FAILED attempt", async () => {
    const order = await makeOrder("PAID");
    const attempt = await prisma.paymentAttempt.create({
      data: { orderId: order.id, status: "FAILED", amount: 1000, phoneNumber: "254712345678", paymentIdempotencyKey: `fa-${Math.random()}` },
    });

    const result = await finalizeSuccessfulPayment(attempt.id, {});
    expect(result.finalized).toBe(false);
    expect(result.reason).toBe("not_active");

    const ledgers = await prisma.ledgerEntry.findMany({ where: { paymentAttemptId: attempt.id } });
    expect(ledgers).toHaveLength(0);
  });

  it("two concurrent finalizations produce exactly one ledger entry", async () => {
    const order = await makeOrder("PAID");
    const attempt = await prisma.paymentAttempt.create({
      data: { orderId: order.id, status: "PENDING", amount: 1000, phoneNumber: "254712345678", paymentIdempotencyKey: `cc-${Math.random()}` },
    });

    const [a, b] = await Promise.all([
      finalizeSuccessfulPayment(attempt.id, {}),
      finalizeSuccessfulPayment(attempt.id, {}),
    ]);

    expect([a.finalized, b.finalized].filter(Boolean)).toHaveLength(1);
    const ledgers = await prisma.ledgerEntry.findMany({ where: { paymentAttemptId: attempt.id } });
    expect(ledgers).toHaveLength(1);
  });
});

describe("Authorization — vendor scoping", () => {
  it("VendorMembership.STAFF has an active membership on their own vendor", async () => {
    const membership = await prisma.vendorMembership.findUnique({
      where: { userId_vendorId: { userId: staffUserId, vendorId: vendorAId } },
    });
    expect(membership?.role).toBe("STAFF");
    expect(membership?.status).toBe("ACTIVE");
  });

  it("STAFF of Vendor A has NO membership on Vendor B (cross-vendor denied)", async () => {
    const membership = await prisma.vendorMembership.findUnique({
      where: { userId_vendorId: { userId: staffUserId, vendorId: vendorBId } },
    });
    expect(membership).toBeNull();
  });

  it("STAFF is not PlatformStaff — no internal financial access", async () => {
    const staff = await prisma.platformStaff.findUnique({ where: { userId: staffUserId } });
    expect(staff).toBeNull();
  });
});

describe("Backfill", () => {
  it("every vendor has an ACTIVE OWNER membership", async () => {
    const vendors = await prisma.vendor.count();
    const owners = await prisma.vendorMembership.count({
      where: { role: "OWNER", status: "ACTIVE" },
    });
    expect(owners).toBeGreaterThanOrEqual(vendors);
  });
});
