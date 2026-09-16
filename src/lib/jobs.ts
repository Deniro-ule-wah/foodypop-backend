import { getBoss, QUEUE_PAYMENT_RECONCILIATION, QUEUE_ORDER_DEADLINE } from "./boss";
import { logger } from "./logger";

// Job payloads carry only the minimum stable identifier. The worker
// reloads authoritative state from PostgreSQL — domain state is never
// serialized into a job, because a job sitting in a queue for minutes
// would otherwise act on a stale snapshot.

export interface PaymentReconciliationJob {
  paymentAttemptId: string;
}

export interface OrderDeadlineJob {
  orderId: string;
}

// Bounded retry/backoff using pg-boss's own mechanisms — no custom
// interval loop. retryBackoff makes each retry exponential from
// retryDelay, capped at retryDelayMax, so a prolonged Daraja outage
// backs off instead of producing a retry storm.
function retryOptions() {
  return {
    retryLimit: Number(process.env.RECONCILIATION_RETRY_LIMIT || 12),
    retryDelay: Math.ceil(Number(process.env.RECONCILIATION_BASE_BACKOFF_MS || 30_000) / 1000),
    retryBackoff: true,
    retryDelayMax: Math.ceil(Number(process.env.RECONCILIATION_MAX_BACKOFF_MS || 900_000) / 1000),
  };
}

/**
 * Enqueues reconciliation for a payment attempt.
 *
 * singletonKey is the paymentAttemptId, so pg-boss will not hold two
 * active reconciliation jobs for the same attempt — duplicate scheduling
 * is prevented at the queue level, in addition to the database-level
 * guarantees already enforced inside finalizeSuccessfulPayment().
 */
export async function enqueuePaymentReconciliation(
  paymentAttemptId: string,
  startAfterSeconds?: number
): Promise<string | null> {
  const payload: PaymentReconciliationJob = { paymentAttemptId };
  const options = {
    ...retryOptions(),
    singletonKey: paymentAttemptId,
    ...(startAfterSeconds !== undefined ? { startAfter: startAfterSeconds } : {}),
  };

  const jobId = await getBoss().send(QUEUE_PAYMENT_RECONCILIATION, payload, options);
  logger.debug({ paymentAttemptId, jobId, startAfterSeconds }, "Enqueued payment reconciliation");
  return jobId;
}

/**
 * Enqueues deadline processing for an order, deferred until the
 * deadline itself. deadlineAt/deadlineReason on the Order row remain
 * authoritative — the job is only the trigger, and the handler
 * re-reads the row before acting on it.
 */
export async function enqueueOrderDeadline(orderId: string, runAt: Date): Promise<string | null> {
  const payload: OrderDeadlineJob = { orderId };
  const jobId = await getBoss().sendAfter(
    QUEUE_ORDER_DEADLINE,
    payload,
    { singletonKey: orderId, retryLimit: 3, retryDelay: 60, retryBackoff: true },
    runAt
  );
  logger.debug({ orderId, jobId, runAt }, "Enqueued order deadline");
  return jobId;
}
