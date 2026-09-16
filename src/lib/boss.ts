import type { PgBoss } from "pg-boss";
import { logger } from "./logger";

// pg-boss v12 is a pure ESM package exporting a NAMED `PgBoss` class.
// This project compiles to CommonJS, so a static import would fail at
// runtime — the dynamic import below is the correct interop path, not a
// workaround. The type-only import above keeps full type safety.

// Single shared pg-boss lifecycle. Runs in the SAME process as the API
// (locked decision) while remaining an independently observable runtime
// component with its own start/stop lifecycle.
//
// PostgreSQL is the only job infrastructure dependency — pg-boss stores
// its queues in the same database. No Redis/Kafka/RabbitMQ.

export const QUEUE_PAYMENT_RECONCILIATION = "PAYMENT_RECONCILIATION";
export const QUEUE_ORDER_DEADLINE = "ORDER_DEADLINE";
export const QUEUE_RECONCILIATION_SWEEP = "RECONCILIATION_SWEEP";

let boss: PgBoss | null = null;
let started = false;
let stopping = false;

const activeQueues = new Set<string>();

export function registerActiveQueue(queueName: string) {
  activeQueues.add(queueName);
}

export function getBoss(): PgBoss {
  if (!boss) throw new Error("pg-boss has not been started");
  return boss;
}

export function bossHealth() {
  return {
    started,
    stopping,
    queues: Array.from(activeQueues),
  };
}

/**
 * Starts pg-boss and creates the required queues. Worker registration
 * happens separately (see worker/index.ts) so that queue existence is
 * guaranteed before any handler subscribes to it.
 */
export async function startBoss(): Promise<PgBoss> {
  if (boss && started) return boss;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to start pg-boss");

  const { PgBoss: PgBossCtor } = await import("pg-boss");

  boss = new PgBossCtor({
    connectionString,
    // pg-boss keeps its own tables in a dedicated schema so it never
    // collides with the application's Prisma-managed schema.
    schema: process.env.PGBOSS_SCHEMA || "pgboss",
    max: Number(process.env.PGBOSS_POOL_MAX || 5),
  });

  boss.on("error", (err: Error) => {
    logger.error({ err }, "pg-boss error");
  });

  await boss.start();

  activeQueues.clear();
  const requiredQueues = [
    QUEUE_PAYMENT_RECONCILIATION,
    QUEUE_ORDER_DEADLINE,
    QUEUE_RECONCILIATION_SWEEP,
  ];

  for (const queue of requiredQueues) {
    try {
      await boss.createQueue(queue);
      activeQueues.add(queue);
    } catch (err) {
      logger.error({ err, queue, operation: "createQueue" }, `Failed to create queue ${queue}`);
      throw err;
    }
  }

  started = true;
  logger.info({ queues: bossHealth().queues }, "pg-boss started");
  return boss;
}

/**
 * Stops accepting new work, drains in-flight handlers, then closes.
 * `graceful: true` lets running jobs finish rather than killing them
 * mid-transaction — important because a reconciliation handler may be
 * inside finalizeSuccessfulPayment() when a deploy rolls the process.
 */
export async function stopBoss(): Promise<void> {
  if (!boss || !started || stopping) return;
  stopping = true;

  try {
    await boss.stop({
      graceful: true,
      timeout: Number(process.env.PGBOSS_SHUTDOWN_TIMEOUT_MS || 15_000),
    });
    logger.info("pg-boss stopped");
  } catch (err) {
    logger.error({ err }, "pg-boss shutdown error");
  } finally {
    started = false;
    stopping = false;
    boss = null;
    activeQueues.clear();
  }
}
