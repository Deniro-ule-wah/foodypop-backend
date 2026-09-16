import { prisma } from "./prisma";
import { ForbiddenError, NotFoundError } from "./errors";

// Single source of truth for V2 authorization. Every V2 route imports
// from here — authorization logic is never reimplemented per-controller,
// because a subtly-different copy in one route is exactly how IDOR bugs
// get introduced.

// NAMING HAZARD, deliberate note: VendorMembership.STAFF and
// PlatformStaff are near-inverses of each other —
//   VendorMembership.STAFF  -> CAN do fulfillment, CANNOT see financials
//   PlatformStaff (any role) -> CAN see financials, CANNOT mutate orders
// Never use a bare `STAFF` identifier anywhere in this codebase without
// its qualifying prefix.

export type VendorRoleName = "OWNER" | "MANAGER" | "STAFF";
export type PlatformRoleName = "SUPPORT" | "OPS" | "FINANCE" | "ADMIN";

/**
 * Resolves the caller's ACTIVE membership for a specific vendor.
 * Throws ForbiddenError if they have none — this is the cross-vendor
 * boundary, and it is mandatory for every role including STAFF.
 */
export async function requireVendorMembership(
  userId: string,
  vendorId: string,
  allowedRoles?: VendorRoleName[]
) {
  const membership = await prisma.vendorMembership.findUnique({
    where: { userId_vendorId: { userId, vendorId } },
  });

  if (!membership || membership.status !== "ACTIVE") {
    throw new ForbiddenError("You do not have access to this vendor");
  }

  if (allowedRoles && !allowedRoles.includes(membership.role as VendorRoleName)) {
    throw new ForbiddenError("Your vendor role does not permit this action");
  }

  return membership;
}

/**
 * Loads an Order and asserts the caller may perform vendor fulfillment
 * actions on it. All three vendor roles (OWNER/MANAGER/STAFF) are
 * permitted — STAFF included, per the locked authorization matrix.
 * The vendor-scoping check is what prevents cross-vendor access.
 */
export async function requireOrderVendorAccess(userId: string, orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError("Order not found");

  await requireVendorMembership(userId, order.vendorId);
  return order;
}

/**
 * Loads an Order and asserts the caller owns it as the customer.
 */
export async function requireOrderCustomerAccess(userId: string, orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError("Order not found");

  if (order.customerId !== userId) {
    // Deliberately the same shape as any other forbidden action — does
    // not reveal whether the order exists under a different customer.
    throw new ForbiddenError("You do not have access to this order");
  }

  return order;
}

/**
 * Asserts the caller is ACTIVE FoodyPop internal staff with one of the
 * given roles. Used only by /internal/* read endpoints.
 *
 * PlatformStaff has NO Order/payment mutation authority anywhere in V2 —
 * there is deliberately no `requirePlatformStaffMutation` helper,
 * because no such endpoint exists.
 */
export async function requirePlatformStaff(
  userId: string,
  allowedRoles: PlatformRoleName[]
) {
  const staff = await prisma.platformStaff.findUnique({ where: { userId } });

  if (!staff || staff.status !== "ACTIVE") {
    throw new ForbiddenError("Internal access required");
  }

  if (!allowedRoles.includes(staff.role as PlatformRoleName)) {
    throw new ForbiddenError("Your staff role does not permit this action");
  }

  return staff;
}
