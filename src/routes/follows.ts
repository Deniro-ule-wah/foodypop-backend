import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { BadRequestError, NotFoundError } from "../lib/errors";
import { parsePagination, buildPage } from "../lib/pagination";

export const followsRouter = Router();

// Users follow DISHES, CUISINES, or CATEGORIES only — never people,
// per the Master Prompt's explicit anti-influencer principle. There is
// deliberately no "follow a vendor/creator" path here.
const followSchema = z.object({
  targetType: z.enum(["DISH", "CUISINE", "CATEGORY"]),
  targetId: z.string(),
});

// Confirms targetId actually references a real row before a follow is
// created. Without this, following a nonexistent id succeeded silently
// — fixed per BE-DOC-001 review, CTO-approved during the Documentation
// Freeze. Only checked on POST (creating a follow); DELETE doesn't need
// it, since deleting a follow on a since-removed target is a legitimate
// cleanup case, not an error.
async function assertTargetExists(targetType: "DISH" | "CUISINE" | "CATEGORY", targetId: string) {
  const exists = await (
    targetType === "DISH" ? prisma.dish.findUnique({ where: { id: targetId }, select: { id: true } }) :
    targetType === "CUISINE" ? prisma.cuisine.findUnique({ where: { id: targetId }, select: { id: true } }) :
    prisma.category.findUnique({ where: { id: targetId }, select: { id: true } })
  );
  if (!exists) {
    throw new NotFoundError(`${targetType.charAt(0) + targetType.slice(1).toLowerCase()} not found`);
  }
}

// POST /follows — follow a dish/cuisine/category
followsRouter.post("/", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = followSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError("Invalid follow data", parsed.error.flatten());
  }

  const { targetType, targetId } = parsed.data;
  const userId = req.user!.id;

  await assertTargetExists(targetType, targetId);

  // BUG-003 fix (Step 3): check existence before the upsert so the correct HTTP status
  // can be returned. RFC 9110 §9.3.3: 201 Created means a new resource was created;
  // 200 OK is correct when the resource already existed (idempotent re-follow).
  // Previously, a duplicate follow always returned 201, giving the client no way to
  // distinguish a new follow from a no-op. The extra findUnique adds one DB round trip
  // but is the cleanest solution — the upsert is retained as the conflict mechanism.
  const alreadyFollowed = await prisma.follow.findUnique({
    where: { userId_targetType_targetId: { userId, targetType, targetId } },
    select: { id: true },
  });

  const follow = await prisma.follow.upsert({
    where: { userId_targetType_targetId: { userId, targetType, targetId } },
    update: {},
    create: { userId, targetType, targetId },
  });

  res.status(alreadyFollowed ? 200 : 201).json(follow);
}));

// DELETE /follows — unfollow.
// Returns 204 No Content on success — the approved project convention
// for DELETE endpoints (CTO-approved change during the API Documentation
// Freeze milestone, prior to the freeze taking effect, specifically so
// the published spec documents true runtime behavior rather than an
// aspirational convention next to a contradicting example).
followsRouter.delete("/", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = followSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError("Invalid follow data", parsed.error.flatten());
  }

  const { targetType, targetId } = parsed.data;
  const userId = req.user!.id;

  await prisma.follow.deleteMany({ where: { userId, targetType, targetId } });
  res.status(204).send();
}));

// GET /follows?cursor=&limit= — the authenticated user's own follows.
// Paginated for consistency with every other list endpoint in this API
// (feed, search, vendor listing) — fixed under PH-003 API Consistency
// Validation; this previously returned a bare array, the only list
// endpoint (besides the small bounded lookup tables) that did.
followsRouter.get("/", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const pagination = parsePagination(req);
  const follows = await prisma.follow.findMany({
    where: { userId: req.user!.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], // id tiebreaker keeps cursor pagination stable
    ...pagination.prismaArgs,
  });
  res.json(buildPage(follows, pagination.limit));
}));
