-- FoodyPop V2: Orders, Payments, Ledger, Membership
-- Additive only. No V1 table is dropped or altered destructively.
-- Vendor.userId is retained (deprecated legacy pointer, two-phase removal).

-- ===== ENUMS =====
CREATE TYPE "VendorRole" AS ENUM ('OWNER', 'MANAGER', 'STAFF');
CREATE TYPE "PlatformRole" AS ENUM ('SUPPORT', 'OPS', 'FINANCE', 'ADMIN');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'PENDING_VENDOR_ACCEPTANCE', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'COLLECTED', 'COMPLETED', 'CUSTOMER_CANCELLED', 'VENDOR_REJECTED', 'CANCELLED_AFTER_ACCEPTANCE', 'NO_SHOW');
CREATE TYPE "FulfillmentMode" AS ENUM ('PICKUP', 'DELIVERY');
CREATE TYPE "DeadlineReason" AS ENUM ('PAYMENT', 'VENDOR_ACCEPTANCE', 'PREPARATION', 'PICKUP', 'PAYMENT_RECONCILIATION');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'TIMEOUT', 'UNKNOWN');
CREATE TYPE "ReconciliationOutcome" AS ENUM ('PROVIDER_SUCCESS', 'PROVIDER_FAILURE', 'PROVIDER_UNKNOWN', 'PROVIDER_UNREACHABLE', 'LOCAL_TIMEOUT');
CREATE TYPE "PickupChannel" AS ENUM ('QR', 'PIN');
CREATE TYPE "PickupCredentialStatus" AS ENUM ('UNUSED', 'USED', 'INVALIDATED');
CREATE TYPE "RefundReason" AS ENUM ('VENDOR_REJECTED', 'CUSTOMER_CANCELLED', 'DISPUTE_RESOLVED');
CREATE TYPE "RefundStatus" AS ENUM ('REFUND_PENDING');

-- ===== TABLES =====
CREATE TABLE "VendorMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "role" "VendorRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VendorMembership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlatformStaff" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformStaff_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "fulfillmentMode" "FulfillmentMode" NOT NULL DEFAULT 'PICKUP',
    "idempotencyKey" TEXT NOT NULL,
    "deadlineAt" TIMESTAMP(3),
    "deadlineReason" "DeadlineReason",
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL,
    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PickupCredential" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "channel" "PickupChannel" NOT NULL DEFAULT 'QR',
    "status" "PickupCredentialStatus" NOT NULL DEFAULT 'UNUSED',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "usedBy" TEXT,
    CONSTRAINT "PickupCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "phoneNumber" TEXT NOT NULL,
    "paymentIdempotencyKey" TEXT NOT NULL,
    "providerRequestId" TEXT,
    "providerCheckoutId" TEXT,
    "providerReceipt" TEXT,
    "deadlineAt" TIMESTAMP(3),
    "deadlineReason" "DeadlineReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReconciliationAttempt" (
    "id" TEXT NOT NULL,
    "paymentAttemptId" TEXT NOT NULL,
    "outcome" "ReconciliationOutcome" NOT NULL,
    "providerResponse" JSONB,
    "errorDetail" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReconciliationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "paymentAttemptId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "grossAmount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "fees" DOUBLE PRECISION,
    "commission" DOUBLE PRECISION,
    "vendorPayableAmount" DOUBLE PRECISION,
    "settlementState" TEXT,
    "providerReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefundObligation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "originatingPaymentAttemptId" TEXT NOT NULL,
    "ledgerEntryId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "reason" "RefundReason" NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REFUND_PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefundObligation_pkey" PRIMARY KEY ("id")
);

-- ===== INDEXES =====
CREATE UNIQUE INDEX "VendorMembership_userId_vendorId_key" ON "VendorMembership"("userId", "vendorId");
CREATE INDEX "VendorMembership_vendorId_status_idx" ON "VendorMembership"("vendorId", "status");
CREATE UNIQUE INDEX "PlatformStaff_userId_key" ON "PlatformStaff"("userId");
CREATE UNIQUE INDEX "Order_customerId_idempotencyKey_key" ON "Order"("customerId", "idempotencyKey");
CREATE INDEX "Order_vendorId_status_idx" ON "Order"("vendorId", "status");
CREATE INDEX "Order_deadlineAt_deadlineReason_idx" ON "Order"("deadlineAt", "deadlineReason");
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");
CREATE INDEX "OrderEvent_orderId_createdAt_idx" ON "OrderEvent"("orderId", "createdAt");
CREATE INDEX "OrderEvent_eventType_createdAt_idx" ON "OrderEvent"("eventType", "createdAt");
CREATE UNIQUE INDEX "PickupCredential_orderId_key" ON "PickupCredential"("orderId");
CREATE UNIQUE INDEX "PickupCredential_codeHash_key" ON "PickupCredential"("codeHash");
CREATE UNIQUE INDEX "PaymentAttempt_orderId_paymentIdempotencyKey_key" ON "PaymentAttempt"("orderId", "paymentIdempotencyKey");
CREATE INDEX "PaymentAttempt_status_deadlineAt_idx" ON "PaymentAttempt"("status", "deadlineAt");
CREATE INDEX "ReconciliationAttempt_paymentAttemptId_attemptedAt_idx" ON "ReconciliationAttempt"("paymentAttemptId", "attemptedAt");
CREATE UNIQUE INDEX "LedgerEntry_paymentAttemptId_key" ON "LedgerEntry"("paymentAttemptId");
CREATE INDEX "LedgerEntry_orderId_idx" ON "LedgerEntry"("orderId");
CREATE INDEX "RefundObligation_orderId_idx" ON "RefundObligation"("orderId");
CREATE INDEX "RefundObligation_status_idx" ON "RefundObligation"("status");

-- CRITICAL: one active PaymentAttempt per Order.
-- TIMEOUT and UNKNOWN are NOT terminal — an attempt in either state may
-- still resolve to SUCCESS via reconciliation, so it must still block a
-- second capturing attempt. This is the database-enforced guarantee
-- against duplicate customer charges. Partial indexes cannot be
-- expressed in Prisma schema, hence raw SQL.
CREATE UNIQUE INDEX "PaymentAttempt_one_active_per_order"
ON "PaymentAttempt" ("orderId")
WHERE "status" IN ('PENDING', 'TIMEOUT', 'UNKNOWN');

-- ===== FOREIGN KEYS =====
ALTER TABLE "VendorMembership" ADD CONSTRAINT "VendorMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorMembership" ADD CONSTRAINT "VendorMembership_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlatformStaff" ADD CONSTRAINT "PlatformStaff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Dish"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PickupCredential" ADD CONSTRAINT "PickupCredential_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReconciliationAttempt" ADD CONSTRAINT "ReconciliationAttempt_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundObligation" ADD CONSTRAINT "RefundObligation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundObligation" ADD CONSTRAINT "RefundObligation_originatingPaymentAttemptId_fkey" FOREIGN KEY ("originatingPaymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundObligation" ADD CONSTRAINT "RefundObligation_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===== BACKFILL: Vendor.userId -> VendorMembership OWNER =====
-- Idempotent: ON CONFLICT DO NOTHING means re-running is safe and
-- creates no duplicate memberships.
INSERT INTO "VendorMembership" ("id", "userId", "vendorId", "role", "status", "createdAt", "updatedAt")
SELECT
    'vm_' || md5(v."id" || v."userId"),
    v."userId",
    v."id",
    'OWNER'::"VendorRole",
    'ACTIVE'::"MembershipStatus",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Vendor" v
ON CONFLICT ("userId", "vendorId") DO NOTHING;

-- Backfill verification: fails the migration loudly if any vendor did
-- not receive an OWNER membership, rather than silently locking that
-- vendor out of their own orders.
DO $$
DECLARE
    vendor_count INTEGER;
    owner_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO vendor_count FROM "Vendor";
    SELECT COUNT(*) INTO owner_count FROM "VendorMembership" WHERE "role" = 'OWNER' AND "status" = 'ACTIVE';
    IF owner_count < vendor_count THEN
        RAISE EXCEPTION 'Backfill incomplete: % vendors but only % OWNER memberships', vendor_count, owner_count;
    END IF;
END $$;
