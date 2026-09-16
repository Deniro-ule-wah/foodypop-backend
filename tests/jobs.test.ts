import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Unit-level tests for the pg-boss job layer. These verify scheduling
// options, payload shape, and retry configuration WITHOUT a database —
// actual queue behavior is covered by the integration tests, which
// cannot run in this sandbox.

const sendMock = vi.fn().mockResolvedValue("job-id-1");
const sendAfterMock = vi.fn().mockResolvedValue("job-id-2");

vi.mock("../src/lib/boss", () => ({
  getBoss: () => ({ send: sendMock, sendAfter: sendAfterMock }),
  QUEUE_PAYMENT_RECONCILIATION: "PAYMENT_RECONCILIATION",
  QUEUE_ORDER_DEADLINE: "ORDER_DEADLINE",
}));

import { enqueuePaymentReconciliation, enqueueOrderDeadline } from "../src/lib/jobs";

beforeEach(() => {
  sendMock.mockClear();
  sendAfterMock.mockClear();
});

afterEach(() => {
  delete process.env.RECONCILIATION_RETRY_LIMIT;
  delete process.env.RECONCILIATION_BASE_BACKOFF_MS;
  delete process.env.RECONCILIATION_MAX_BACKOFF_MS;
});

describe("PAYMENT_RECONCILIATION job scheduling", () => {
  it("targets the approved queue name", async () => {
    await enqueuePaymentReconciliation("pa_123");
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBe("PAYMENT_RECONCILIATION");
  });

  it("carries only the minimum stable identifier in the payload", async () => {
    await enqueuePaymentReconciliation("pa_123");
    const payload = sendMock.mock.calls[0][1];
    // Domain state must NOT be serialized — the worker reloads
    // authoritative state from PostgreSQL.
    expect(payload).toEqual({ paymentAttemptId: "pa_123" });
    expect(Object.keys(payload)).toHaveLength(1);
  });

  it("uses bounded exponential backoff, not an unbounded retry storm", async () => {
    await enqueuePaymentReconciliation("pa_123");
    const options = sendMock.mock.calls[0][2];

    expect(options.retryBackoff).toBe(true);
    expect(options.retryLimit).toBeGreaterThan(0);
    expect(Number.isFinite(options.retryLimit)).toBe(true);
    expect(options.retryDelayMax).toBeGreaterThan(options.retryDelay);
  });

  it("uses the paymentAttemptId as singletonKey to prevent duplicate active jobs", async () => {
    await enqueuePaymentReconciliation("pa_123");
    expect(sendMock.mock.calls[0][2].singletonKey).toBe("pa_123");
  });

  it("supports a deferred first check", async () => {
    await enqueuePaymentReconciliation("pa_123", 45);
    expect(sendMock.mock.calls[0][2].startAfter).toBe(45);
  });

  it("omits startAfter when no delay is requested", async () => {
    await enqueuePaymentReconciliation("pa_123");
    expect(sendMock.mock.calls[0][2].startAfter).toBeUndefined();
  });

  it("honours configured retry bounds", async () => {
    process.env.RECONCILIATION_RETRY_LIMIT = "7";
    process.env.RECONCILIATION_BASE_BACKOFF_MS = "60000";
    process.env.RECONCILIATION_MAX_BACKOFF_MS = "600000";

    await enqueuePaymentReconciliation("pa_x");
    const options = sendMock.mock.calls[0][2];

    expect(options.retryLimit).toBe(7);
    expect(options.retryDelay).toBe(60);      // seconds
    expect(options.retryDelayMax).toBe(600);  // seconds
  });
});

describe("ORDER_DEADLINE job scheduling", () => {
  it("defers the job until the deadline itself", async () => {
    const runAt = new Date(Date.now() + 60_000);
    await enqueueOrderDeadline("order_1", runAt);

    expect(sendAfterMock).toHaveBeenCalledTimes(1);
    const [queue, payload, options, date] = sendAfterMock.mock.calls[0];

    expect(queue).toBe("ORDER_DEADLINE");
    expect(payload).toEqual({ orderId: "order_1" });
    expect(options.singletonKey).toBe("order_1");
    expect(date).toBe(runAt);
  });

  it("bounds deadline retries", async () => {
    await enqueueOrderDeadline("order_1", new Date());
    const options = sendAfterMock.mock.calls[0][2];
    expect(options.retryLimit).toBe(3);
    expect(options.retryBackoff).toBe(true);
  });
});
