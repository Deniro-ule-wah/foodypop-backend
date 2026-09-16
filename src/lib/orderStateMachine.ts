import { BadRequestError } from "./errors";

// The state machine is DATA, not scattered if-checks. Every legal edge
// is listed here exactly once; anything absent is illegal by default and
// fails deterministically. This is what makes terminal-state
// immutability structurally true rather than something each route has to
// remember to enforce.

export type OrderStatusName =
  | "PENDING_PAYMENT"
  | "PAID"
  | "PENDING_VENDOR_ACCEPTANCE"
  | "ACCEPTED"
  | "PREPARING"
  | "READY_FOR_PICKUP"
  | "COLLECTED"
  | "COMPLETED"
  | "CUSTOMER_CANCELLED"
  | "VENDOR_REJECTED"
  | "CANCELLED_AFTER_ACCEPTANCE"
  | "NO_SHOW";

const ALLOWED_TRANSITIONS: Record<OrderStatusName, OrderStatusName[]> = {
  PENDING_PAYMENT: ["PAID"],
  // PAID -> PENDING_VENDOR_ACCEPTANCE is immediate/automatic on payment
  // finalization; the customer may also cancel from either.
  PAID: ["PENDING_VENDOR_ACCEPTANCE", "CUSTOMER_CANCELLED"],
  PENDING_VENDOR_ACCEPTANCE: ["ACCEPTED", "VENDOR_REJECTED", "CUSTOMER_CANCELLED"],
  // Accepting starts preparation immediately — no separate "start
  // preparing" command was ever locked.
  ACCEPTED: ["PREPARING", "CANCELLED_AFTER_ACCEPTANCE"],
  PREPARING: ["READY_FOR_PICKUP", "CANCELLED_AFTER_ACCEPTANCE"],
  READY_FOR_PICKUP: ["COLLECTED", "NO_SHOW"],
  // COLLECTED -> COMPLETED is immediate/automatic; they are the same
  // business moment, kept as separate states for downstream clarity.
  COLLECTED: ["COMPLETED"],

  // Terminal. Immutable. Disputes never reopen these — a Support Case
  // references the Order without mutating it.
  COMPLETED: [],
  NO_SHOW: [],
  CUSTOMER_CANCELLED: [],
  VENDOR_REJECTED: [],
  CANCELLED_AFTER_ACCEPTANCE: [],
};

export function isTransitionAllowed(from: OrderStatusName, to: OrderStatusName): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransitionAllowed(from: OrderStatusName, to: OrderStatusName): void {
  if (!isTransitionAllowed(from, to)) {
    throw new BadRequestError(
      `Illegal order state transition: ${from} -> ${to}`,
      { from, to, allowed: ALLOWED_TRANSITIONS[from] ?? [] }
    );
  }
}

export function isTerminal(status: OrderStatusName): boolean {
  return (ALLOWED_TRANSITIONS[status] ?? []).length === 0;
}
