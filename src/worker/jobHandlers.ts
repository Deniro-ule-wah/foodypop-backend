import type { Job } from "pg-boss";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { getBoss, QUEUE_PAYMENT_RECONCILIATION, QUEUE_ORDER_DEADLINE } from "../lib/boss";
import { enqueuePaymentReconciliation } from "../lib/jobs";
import { verifyAndReconcile, markLocalTimeout } from "../lib/reconciliation";
import type { PaymentReconciliationJob, OrderDeadlineJob } from "../lib/jobs";

// pg-boss handlers. The reconciliation STATE MACHINE is unchanged —
// these handlers only invoke the existing reconciliation service.
// finalizeSuccessfulPayment() remains the sole financial gate; nothing
// here introduces a second finalization path.

/**
 * PAYMENT_RECONCILIATION handler.
 *
 * Shape note: unlike the deterministic deadline reasons, reconciliation
 * is "check external state -> maybe transition, maybe retry". Retrying
 * is expressed by THROWING, which hands scheduling to pg-boss's own
 * bounded exponential backoff rather than a hand-rolled timer.
 */
async function handlePaymentReconciliation(
  jobs: Job<PaymentReconciliationJob>[]
): Promise<void> {
  for (const job of jobs) {
    const { paymentAttemptId } = job.data;

    // Reload authoritative state — never trust the job payload for
    // anything beyond the identifier.
    const attempt = await prisma.paymentAttempt.findUnique({
      where: { id: paymentAttemptId },
    });

    if (!attempt) {
      logger.warn({ paymentAttemptId }, "Reconciliation job for unknown attempt; discarding");
      return;
    }

    if (attempt.status === "SUCCESS" || attempt.status === "FAILED") {
      logger.debug({ paymentAttemptId, status: attempt.status }, "Attempt already terminal; no work");
      return;
    }

    const result = await verifyAndReconcile(paymentAttemptId);

    switch (result.outcome) {
      case "PROVIDER_SUCCESS":
      case "PROVIDER_FAILURE":
        // Definitive. Job completes; no retry.
        return;

      case "PROVIDER_UNREACHABLE":
      case "PROVIDER_UNKNOWN": {
        // Not definitive. If the reconciliation window has elapsed,
        // record LOCAL_TIMEOUT first — this does NOT stop reconciliation
        // and does NOT mean the payment failed; the attempt stays active
        // and keeps holding the one-active-attempt lock so no duplicate
        // charge can be initiated.
        const windowMs = Number(process.env.RECONCILIATION_WINDOW_MS || 10 * 60_000);
        const expired = Date.now() - attempt.createdAt.getTime() > windowMs;

        if (expired && attempt.status !== "TIMEOUT") {
          await markLocalTimeout(paymentAttemptId);
        }

        // Throwing defers to pg-boss retry/backoff. Bounded by
        // retryLimit; exhaustion leaves the attempt in a recoverable
        // non-terminal state for operations to resolve — deliberately
        // NOT auto-failed, and never auto-refunded.
        throw new Error(`Reconciliation not definitive (${result.outcome}); retrying`);
      }

      case "LOCAL_TIMEOUT":
        throw new Error("Reconciliation timed out locally; retrying");

      case "SKIPPED":
        logger.debug({ paymentAttemptId, reason: result.reason }, "Reconciliation skipped");
        return;
    }
  }
}

/**
 * ORDER_DEADLINE handler. Consequences are unchanged from the approved
 * behavior — PICKUP transitions to NO_SHOW; PREPARATION escalates and
 * must never auto-cancel; PAYMENT/VENDOR_ACCEPTANCE escalate only,
 * since their consequence policy is deliberately undecided.
 */
async function handleOrderDeadline(jobs: Job<OrderDeadlineJob>[]): Promise<void> {
  for (const job of jobs) {
    const { orderId } = job.data;

    // deadlineAt/deadlineReason on the Order row remain authoritative —
    // the job is only a trigger.
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || !order.deadlineAt || !order.deadlineReason) return;
    if (order.deadlineAt.getTime() > Date.now()) return; // rescheduled since enqueue

    switch (order.deadlineReason) {
      case "PICKUP": {
        const claimed = await prisma.order.updateMany({
          where: { id: order.id, status: "READY_FOR_PICKUP" },
          data: { status: "NO_SHOW", deadlineAt: null, deadlineReason: null },
        });
        if (claimed.count > 0) {
          await prisma.orderEvent.create({
            data: {
              orderId: order.id,
              eventType: "ORDER_NO_SHOW",
              version: 1,
              payload: { orderId: order.id, reason: "PICKUP_DEADLINE_EXCEEDED" },
            },
          });
          logger.info({ orderId: order.id }, "Order transitioned to NO_SHOW");
        }
        break;
      }

      case "PREPARATION": {
        // ESCALATION ONLY — explicitly must NOT auto-cancel.
        await prisma.$transaction([
          prisma.orderEvent.create({
            data: {
              orderId: order.id,
              eventType: "ORDER_PREPARATION_OVERDUE",
              version: 1,
              payload: { orderId: order.id, escalation: true },
            },
          }),
          prisma.order.update({
            where: { id: order.id },
            data: { deadlineAt: null, deadlineReason: null },
          }),
        ]);
        logger.warn({ orderId: order.id }, "Preparation overdue — escalated, NOT cancelled");
        break;
      }

      case "VENDOR_ACCEPTANCE":
      case "PAYMENT": {
        await prisma.$transaction([
          prisma.orderEvent.create({
            data: {
              orderId: order.id,
              eventType: `ORDER_${order.deadlineReason}_DEADLINE_REACHED`,
              version: 1,
              payload: { orderId: order.id, policy: "BLOCKED_PENDING_DECISION" },
            },
          }),
          prisma.order.update({
            where: { id: order.id },
            data: { deadlineAt: null, deadlineReason: null },
          }),
        ]);
        logger.warn(
          { orderId: order.id, reason: order.deadlineReason },
          "Order deadline reached; consequence policy undefined — escalated only"
        );
        break;
      }

      default:
        break;
    }
  }
}

/**
 * Sweeps rows whose deadline has passed but which have no live pg-boss
 * job — e.g. attempts created while the process was down, or jobs lost
 * before enqueue succeeded. Registered as a pg-boss schedule (cron),
 * NOT a setInterval, so it remains part of the single job mechanism.
 */
async function handleReconciliationSweep(): Promise<void> {
  const due = await prisma.paymentAttempt.findMany({
    where: {
      deadlineAt: { lte: new Date(), not: null },
      deadlineReason: "PAYMENT_RECONCILIATION",
      status: { in: ["PENDING", "TIMEOUT", "UNKNOWN"] },
    },
    take: Number(process.env.DEADLINE_BATCH_SIZE || 50),
    select: { id: true },
  });

  for (const attempt of due) {
    // singletonKey prevents duplicate active jobs for the same attempt.
    await enqueuePaymentReconciliation(attempt.id);
  }

  if (due.length > 0) {
    logger.info({ count: due.length }, "Reconciliation sweep enqueued orphaned attempts");
  }
}

export const QUEUE_RECONCILIATION_SWEEP = "RECONCILIATION_SWEEP";

/**
 * Registers all workers. Called after startBoss() so the queues exist.
 */
export async function registerWorkers(): Promise<void> {
  const boss = getBoss();

  await boss.createQueue(QUEUE_RECONCILIATION_SWEEP);

  await boss.work<PaymentReconciliationJob>(
    QUEUE_PAYMENT_RECONCILIATION,
    { batchSize: Number(process.env.RECONCILIATION_BATCH_SIZE || 5) },
    handlePaymentReconciliation
  );

  await boss.work<OrderDeadlineJob>(
    QUEUE_ORDER_DEADLINE,
    { batchSize: Number(process.env.DEADLINE_BATCH_SIZE || 20) },
    handleOrderDeadline
  );

  await boss.work(QUEUE_RECONCILIATION_SWEEP, async () => {
    await handleReconciliationSweep();
  });

  // Safety net for anything that never got enqueued (process restart,
  // enqueue failure). pg-boss's own scheduler — not a custom timer.
  await boss.schedule(
    QUEUE_RECONCILIATION_SWEEP,
    process.env.RECONCILIATION_SWEEP_CRON || "*/2 * * * *"
  );

  logger.info("pg-boss workers registered");
}

export { handlePaymentReconciliation, handleOrderDeadline, handleReconciliationSweep };
