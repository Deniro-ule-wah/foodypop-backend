import { Router } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../lib/asyncHandler";

export const lookupsRouter = Router();

// INC-002 (Step 3): These endpoints intentionally return a bare array, NOT the
// { items, nextCursor, hasMore } envelope used by every other list endpoint
// (feed, search, vendors, follows). Cuisine and Category are small, bounded lookup
// tables whose entire contents are needed at once — e.g. to populate a filter
// dropdown or a dish-upload form. Paginating them would require multiple round trips
// where a single request suffices. If either table ever grows large enough to need
// paging, this design decision should be revisited and the response shape aligned
// with the rest of the API.
lookupsRouter.get("/cuisines", asyncHandler(async (_req, res) => {
  res.json(await prisma.cuisine.findMany({ orderBy: { name: "asc" } }));
}));

lookupsRouter.get("/categories", asyncHandler(async (_req, res) => {
  res.json(await prisma.category.findMany({ orderBy: { name: "asc" } }));
}));
