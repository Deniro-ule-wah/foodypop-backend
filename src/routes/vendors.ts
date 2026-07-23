import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { parsePagination, buildPage, parseLimit } from "../lib/pagination";
import { asyncHandler } from "../lib/asyncHandler";
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors";

export const vendorsRouter = Router();

const createVendorSchema = z.object({
  name: z.string().min(1),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  address: z.string().optional(),
});

// POST /vendors — turn the authenticated user into a vendor.
// userId is derived from the token, never the request body.
vendorsRouter.post("/", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = createVendorSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError("Invalid vendor data", parsed.error.flatten());
  }

  const existing = await prisma.vendor.findUnique({ where: { userId: req.user!.id } });
  if (existing) throw new ConflictError("This account already has a vendor profile");

  const vendor = await prisma.vendor.create({ data: { ...parsed.data, userId: req.user!.id } });
  res.status(201).json(vendor);
}));

// GET /vendors?lat=&lng=&radiusKm=&cursor=&limit= — browse vendors,
// optionally sorted by distance. Uses a plain Haversine calculation in
// JS rather than PostGIS — fine at current scale, and the planned
// upgrade (see Progress Addendum, gap #8) is an indexed geography
// column once vendor count justifies it.
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

vendorsRouter.get("/", asyncHandler(async (req, res) => {
  const { lat, lng, radiusKm } = req.query;

  // EDGE-006 fix (Step 3): if either coordinate is present, both must be supplied.
  // Previously, ?lat=-1.29 (without lng) silently fell through to the plain listing,
  // ignoring the supplied coordinate with no error or indication to the caller.
  if (lat !== undefined || lng !== undefined) {
    if (!lat || !lng) {
      throw new BadRequestError("Both lat and lng are required for distance filtering");
    }

    const userLat = Number(lat);
    const userLng = Number(lng);

    // BUG-004 fix (Step 3): validate that lat/lng parse to real finite numbers before
    // passing to the Haversine formula. Previously, ?lat=abc&lng=xyz produced NaN
    // distances — every vendor failed the radius filter and the API returned a silent
    // empty list with no error, giving the caller no signal their input was invalid.
    if (!Number.isFinite(userLat) || !Number.isFinite(userLng)) {
      throw new BadRequestError("lat and lng must be valid numbers");
    }

    // BUG-004 fix (Step 3): validate radiusKm if supplied — NaN/non-positive values
    // previously reached the Haversine filter silently.
    let radius = 25;
    if (radiusKm !== undefined && radiusKm !== "") {
      const parsedRadius = Number(radiusKm);
      if (!Number.isFinite(parsedRadius) || parsedRadius <= 0) {
        throw new BadRequestError("radiusKm must be a positive number");
      }
      radius = parsedRadius;
    }

    // NOTE ON PAGINATION HERE: distance sort happens in application code
    // (see Haversine above), not at the database level, so true DB-level
    // cursor pagination doesn't apply to this branch — a cursor can't
    // reference a position in a sort order the database itself doesn't
    // know about. This uses a simple limit/truncation instead. Real
    // cursor pagination on distance requires the PostGIS migration
    // (Progress Addendum gap #8) so the database can order by distance
    // directly. Flagging this as known technical debt, not an oversight.
    const limit = parseLimit(req);

    const vendors = await prisma.vendor.findMany({
      include: { _count: { select: { dishes: true } } },
    });

    type VendorRow = { latitude: number | null; longitude: number | null; [key: string]: unknown };

    const withDistance = (vendors as VendorRow[])
      .filter((v) => v.latitude != null && v.longitude != null)
      .map((v) => ({
        ...v,
        distanceKm: Math.round(haversineKm(userLat, userLng, v.latitude as number, v.longitude as number) * 10) / 10,
      }))
      .filter((v) => v.distanceKm <= radius)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    return res.json({
      items: withDistance.slice(0, limit),
      hasMore: withDistance.length > limit,
      nextCursor: null, // see note above — not implemented for distance sort yet
    });
  }

  // Plain listing (no distance sort) — real DB-level cursor pagination.
  const pagination = parsePagination(req);
  const vendors = await prisma.vendor.findMany({
    orderBy: [{ id: "desc" }],
    ...pagination.prismaArgs,
    include: { _count: { select: { dishes: true } } },
  });

  res.json(buildPage(vendors, pagination.limit));
}));

// GET /vendors/:id — vendor profile + their dishes
vendorsRouter.get("/:id", asyncHandler(async (req, res) => {
  const vendor = await prisma.vendor.findUnique({
    where: { id: req.params.id },
    // INC-005 (Step 3): dishes are fetched without a take limit — intentional at seed
    // scale. A vendor with hundreds of dishes will return an unbounded payload.
    // Add take: N here when real traffic justifies it.
    include: { dishes: { where: { isAvailable: true } } },
  });

  if (!vendor) throw new NotFoundError("Vendor not found");
  res.json(vendor);
}));
