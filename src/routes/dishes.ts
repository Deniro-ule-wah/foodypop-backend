import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { recomputeTasteScore } from "../lib/tasteScore";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { parsePagination, buildPage } from "../lib/pagination";
import { logger } from "../lib/logger";
import { asyncHandler } from "../lib/asyncHandler";
import { BadRequestError, ForbiddenError, NotFoundError } from "../lib/errors";

export const dishesRouter = Router();

const createDishSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["FOOD", "DRINK"]).default("FOOD"),
  description: z.string().optional(),
  price: z.number().positive(),
  currency: z.string().length(3).optional(), // ISO 4217, e.g. "KES", "USD"
  discountPrice: z.number().positive().optional(),
  ingredients: z.array(z.string()).optional(),
  prepTimeMinutes: z.number().int().positive().optional(),
  deliveryAvail: z.boolean().optional(),
  pickupAvail: z.boolean().optional(),
  cuisineId: z.string().optional(),
  categoryId: z.string().optional(),
});

// POST /dishes — vendor uploads a dish
// Requires auth. vendorId is derived from the authenticated user's own
// vendor profile — never trusted from the request body — so one vendor
// can't upload dishes under another vendor's name.
dishesRouter.post("/", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = createDishSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError("Invalid dish data", parsed.error.flatten());
  }

  const vendor = await prisma.vendor.findUnique({ where: { userId: req.user!.id } });
  if (!vendor) {
    throw new ForbiddenError("Only vendor accounts can upload dishes. Register a vendor profile first.");
  }

  const dish = await prisma.dish.create({ data: { ...parsed.data, vendorId: vendor.id } });
  res.status(201).json(dish);
}));

// PATCH /dishes/:id — update a dish (price change, mark unavailable, etc.)
// Only the owning vendor can update their own dish.
const updateDishSchema = createDishSchema.partial().extend({
  isAvailable: z.boolean().optional(),
});

dishesRouter.patch("/:id", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = updateDishSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError("Invalid dish update data", parsed.error.flatten());
  }

  const vendor = await prisma.vendor.findUnique({ where: { userId: req.user!.id } });
  if (!vendor) throw new ForbiddenError("Vendor profile required");

  const dish = await prisma.dish.findUnique({ where: { id: req.params.id } });
  if (!dish) throw new NotFoundError("Dish not found");
  if (dish.vendorId !== vendor.id) {
    throw new ForbiddenError("You can only update your own dishes");
  }

  const updated = await prisma.dish.update({ where: { id: dish.id }, data: parsed.data });
  res.json(updated);
}));

// GET /dishes/search?q=biryani&cursor=&limit=
// Interim search: case-insensitive match on name/description/ingredients.
// This is the cheap version — a real Postgres full-text (tsvector) index
// or Meilisearch is the planned upgrade once search volume justifies it
// (see Progress Addendum). This is deliberately NOT the AI Clustering
// feature from the Master Prompt — that still needs real dish-volume
// data to learn variant groupings from; this just finds text matches.
dishesRouter.get("/search", asyncHandler(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ items: [], nextCursor: null, hasMore: false });

  const pagination = parsePagination(req);

  const dishes = await prisma.dish.findMany({
    where: {
      isAvailable: true,
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { ingredients: { has: q } },
      ],
    },
    orderBy: [{ tasteScore: "desc" }, { id: "desc" }], // id tiebreaker keeps cursor pagination stable
    ...pagination.prismaArgs,
    include: {
      vendor: { select: { id: true, name: true } },
      cuisine: true,
      category: true,
      media: { take: 1 },
    },
  });

  res.json(buildPage(dishes, pagination.limit));
}));

// GET /dishes/feed?mode=discover|cuisineId=&categoryId=&maxBudget=&cursor=&limit=
// This is the Discover-mode feed for v0. Hungry/Thirsty modes need
// distance + delivery-speed data that isn't reliable until there's
// real vendor location + order data, so start here.
dishesRouter.get("/feed", asyncHandler(async (req, res) => {
  const { cuisineId, categoryId, maxBudget, kind } = req.query;

  // BUG-006 fix (Step 3): validate `kind` at runtime, not just via TypeScript cast.
  // The previous `kind as "FOOD" | "DRINK"` is compile-time only — an invalid value
  // like ?kind=PIZZA passed through, reached Prisma, and produced a raw driver error
  // causing a 500 INTERNAL_ERROR instead of a 400 BAD_REQUEST.
  if (kind !== undefined && kind !== "" && kind !== "FOOD" && kind !== "DRINK") {
    throw new BadRequestError('kind must be "FOOD" or "DRINK"');
  }

  // BUG-005 / EDGE-002 fix (Step 3): validate maxBudget explicitly as a finite,
  // non-negative number before passing it to Prisma.
  // Previous issues:
  //   (1) ?maxBudget=abc → Number("abc") = NaN passed to Prisma — undefined DB behavior.
  //   (2) ?maxBudget=0  → falsy in JS, so the price filter was silently skipped entirely,
  //       meaning free (zero-price) dishes could never be filtered for specifically.
  let budgetFilter: { lte: number } | undefined;
  if (maxBudget !== undefined && maxBudget !== "") {
    const parsedBudget = Number(maxBudget);
    if (!Number.isFinite(parsedBudget) || parsedBudget < 0) {
      throw new BadRequestError("maxBudget must be a non-negative number");
    }
    budgetFilter = { lte: parsedBudget };
  }

  const pagination = parsePagination(req);

  const dishes = await prisma.dish.findMany({
    where: {
      isAvailable: true,
      ...(cuisineId ? { cuisineId: String(cuisineId) } : {}),
      ...(categoryId ? { categoryId: String(categoryId) } : {}),
      ...(kind ? { kind: kind as "FOOD" | "DRINK" } : {}),
      ...(budgetFilter !== undefined ? { price: budgetFilter } : {}),
    },
    orderBy: [{ tasteScore: "desc" }, { id: "desc" }], // id tiebreaker keeps cursor pagination stable
    ...pagination.prismaArgs,
    include: {
      vendor: { select: { id: true, name: true } },
      cuisine: true,
      category: true,
      media: { take: 1 },
    },
  });

  res.json(buildPage(dishes, pagination.limit));
}));

// GET /dishes/:id — full dish detail page data
dishesRouter.get("/:id", asyncHandler(async (req, res) => {
  const dish = await prisma.dish.findUnique({
    where: { id: req.params.id },
    include: {
      vendor: true,
      cuisine: true,
      category: true,
      media: true,
      // INC-004 (Step 3): reviews and gestures are fetched without a take limit —
      // intentional at seed scale. A popular dish with thousands of reviews or gestures
      // will return an unbounded payload. Add take: N here when real traffic justifies it.
      reviews: { include: { user: { select: { displayName: true } } } },
      gestures: true,
    },
  });

  if (!dish) throw new NotFoundError("Dish not found");

  // increment view count (fire-and-forget style, don't block response)
  prisma.dish.update({ where: { id: dish.id }, data: { viewCount: { increment: 1 } } })
    .catch((err: unknown) => logger.error({ err, dishId: dish.id }, "Failed to increment dish view count"));

  res.json(dish);
}));

// POST /dishes/:id/gestures — react with a taste gesture (replaces "likes")
// Requires auth. userId comes from the verified token, never the body,
// so a request can no longer submit gestures as any arbitrary user.
const gestureSchema = z.object({
  type: z.enum([
    "DELICIOUS", "SWEET", "BITTER", "SOUR", "SALTY",
    "SPICY", "REFRESHING", "CRISPY", "RICH", "FILLING",
  ]),
});

dishesRouter.post("/:id/gestures", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = gestureSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError("Invalid gesture data", parsed.error.flatten());
  }

  const userId = req.user!.id;
  const { type } = parsed.data;
  const dishId = req.params.id;

  // Validate the dish actually exists before touching it — without this,
  // gesturing on a nonexistent dish ID hits the DB and fails with a raw
  // 500, inconsistent with every other "resource not found" path in the
  // API. Fixed per BE-DOC-001 review, CTO-approved during the
  // Documentation Freeze.
  const dish = await prisma.dish.findUnique({ where: { id: dishId }, select: { id: true } });
  if (!dish) throw new NotFoundError("Dish not found");

  // one active gesture per user per dish — upsert on the unique constraint
  await prisma.tasteGesture.upsert({
    where: { dishId_userId: { dishId, userId } },
    update: { type },
    create: { dishId, userId, type },
  });

  const tasteScore = await recomputeTasteScore(dishId);
  res.json({ ok: true, tasteScore });
}));
