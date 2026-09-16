import { describe, it, expect } from "vitest";
import {
  isTransitionAllowed,
  assertTransitionAllowed,
  isTerminal,
  OrderStatusName,
} from "../src/lib/orderStateMachine";

describe("Order state machine — legal happy path", () => {
  const path: [OrderStatusName, OrderStatusName][] = [
    ["PENDING_PAYMENT", "PAID"],
    ["PAID", "PENDING_VENDOR_ACCEPTANCE"],
    ["PENDING_VENDOR_ACCEPTANCE", "ACCEPTED"],
    ["ACCEPTED", "PREPARING"],
    ["PREPARING", "READY_FOR_PICKUP"],
    ["READY_FOR_PICKUP", "COLLECTED"],
    ["COLLECTED", "COMPLETED"],
  ];

  it.each(path)("allows %s -> %s", (from, to) => {
    expect(isTransitionAllowed(from, to)).toBe(true);
  });
});

describe("Order state machine — fake edges must fail deterministically", () => {
  const illegal: [OrderStatusName, OrderStatusName][] = [
    ["PENDING_PAYMENT", "PREPARING"],
    ["PAID", "COMPLETED"],
    ["VENDOR_REJECTED", "ACCEPTED"],
    ["COMPLETED", "PREPARING"],
    ["NO_SHOW", "COMPLETED"],
    ["PENDING_PAYMENT", "COMPLETED"],
    ["READY_FOR_PICKUP", "PREPARING"],
    ["CUSTOMER_CANCELLED", "PAID"],
  ];

  it.each(illegal)("rejects %s -> %s", (from, to) => {
    expect(isTransitionAllowed(from, to)).toBe(false);
    expect(() => assertTransitionAllowed(from, to)).toThrow();
  });
});

describe("Terminal states are immutable", () => {
  const terminals: OrderStatusName[] = [
    "COMPLETED",
    "NO_SHOW",
    "CUSTOMER_CANCELLED",
    "VENDOR_REJECTED",
    "CANCELLED_AFTER_ACCEPTANCE",
  ];

  it.each(terminals)("%s has no outbound transitions", (status) => {
    expect(isTerminal(status)).toBe(true);
  });

  it("no terminal state can reach any other state", () => {
    const all: OrderStatusName[] = [
      "PENDING_PAYMENT", "PAID", "PENDING_VENDOR_ACCEPTANCE", "ACCEPTED",
      "PREPARING", "READY_FOR_PICKUP", "COLLECTED", "COMPLETED",
      "CUSTOMER_CANCELLED", "VENDOR_REJECTED", "CANCELLED_AFTER_ACCEPTANCE", "NO_SHOW",
    ];
    for (const terminal of terminals) {
      for (const target of all) {
        expect(isTransitionAllowed(terminal, target)).toBe(false);
      }
    }
  });
});

describe("Cancellation rights differ before and after acceptance", () => {
  it("customer may cancel before vendor acceptance", () => {
    expect(isTransitionAllowed("PAID", "CUSTOMER_CANCELLED")).toBe(true);
    expect(isTransitionAllowed("PENDING_VENDOR_ACCEPTANCE", "CUSTOMER_CANCELLED")).toBe(true);
  });

  it("post-acceptance cancellation is a DIFFERENT terminal state", () => {
    expect(isTransitionAllowed("ACCEPTED", "CUSTOMER_CANCELLED")).toBe(false);
    expect(isTransitionAllowed("ACCEPTED", "CANCELLED_AFTER_ACCEPTANCE")).toBe(true);
    expect(isTransitionAllowed("PREPARING", "CANCELLED_AFTER_ACCEPTANCE")).toBe(true);
  });

  it("vendor rejection is only possible before acceptance", () => {
    expect(isTransitionAllowed("PENDING_VENDOR_ACCEPTANCE", "VENDOR_REJECTED")).toBe(true);
    expect(isTransitionAllowed("ACCEPTED", "VENDOR_REJECTED")).toBe(false);
  });
});

describe("No-show is only reachable from READY_FOR_PICKUP", () => {
  it("allows READY_FOR_PICKUP -> NO_SHOW", () => {
    expect(isTransitionAllowed("READY_FOR_PICKUP", "NO_SHOW")).toBe(true);
  });

  it("rejects NO_SHOW from any earlier state", () => {
    const earlier: OrderStatusName[] = ["PENDING_PAYMENT", "PAID", "ACCEPTED", "PREPARING"];
    for (const s of earlier) {
      expect(isTransitionAllowed(s, "NO_SHOW")).toBe(false);
    }
  });
});
