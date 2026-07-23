import { Request } from "express";

export interface ParsedPagination {
  limit: number;
  prismaArgs: {
    take: number;
    cursor?: { id: string };
    skip?: number;
  };
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Shared by any endpoint that needs just the limit (e.g. the vendor
// distance-sort branch, which can't use full cursor pagination — see
// vendors.ts) — kept separate so DEFAULT_LIMIT/MAX_LIMIT never drift
// out of sync between the cursor and non-cursor code paths.
export function parseLimit(req: Request): number {
  const limitRaw = Number(req.query.limit);
  return Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;
}

// Cursor-based, per the BE-005 decision: stays stable under concurrent
// writes (dishes being added/updated while someone is paging through),
// unlike offset pagination which can skip or repeat rows when the
// underlying data changes between page requests.
export function parsePagination(req: Request): ParsedPagination {
  const limit = parseLimit(req);
  const cursorId = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

  return {
    limit,
    prismaArgs: cursorId
      ? { take: limit + 1, cursor: { id: cursorId }, skip: 1 }
      : { take: limit + 1 },
  };
}

// Call after fetching with prismaArgs: trims the extra over-fetched row
// and computes the next cursor, so callers don't duplicate this logic.
export function buildPage<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? items[items.length - 1].id : null;
  return { items, nextCursor, hasMore };
}

