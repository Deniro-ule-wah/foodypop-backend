# FoodyPop Backend — v0.4 (Auth + Pagination + Rate Limiting + Logging + Centralized Error Handling)

This is the starting point, not the whole platform. It implements exactly one
thing well: **the Dish is the star**, everything else (vendors, users) exists
to support it. Every later feature (Food Graph, Substitute/Complement Engine,
SEO pages, analytics) is built by *querying this data differently* — not by
adding new systems yet.

## What's here
- **Postgres schema** (`prisma/schema.prisma`) — User (now with passwordHash),
  Vendor, Dish (now with `currency`), Cuisine, Category, Media, TasteGesture
  (replaces "likes"), Review, Follow (dishes/cuisines/categories only —
  never people, per FoodyPop philosophy)
- **Auth**: JWT-based register/login. `src/middleware/auth.ts` decodes any
  bearer token on every request (`attachUser`) without blocking unauthenticated
  routes; `requireAuth` is applied per-route where identity must be trusted.
- **Express + TypeScript API** with:
  - `POST /auth/register`, `POST /auth/login` — get a token
  - `POST /vendors` *(auth required)* — register a vendor profile for the
    logged-in user
  - `GET /vendors?lat=&lng=&radiusKm=` — browse vendors, optionally sorted by
    distance (plain Haversine calc — see note below on why not PostGIS yet)
  - `GET /vendors/:id` — vendor profile + their dishes
  - `POST /dishes` *(auth required, vendor only)* — upload a dish; vendorId is
    derived from the token, never trusted from the request body
  - `PATCH /dishes/:id` *(auth required, owning vendor only)* — update price,
    availability, etc.
  - `GET /dishes/feed` — Discover-mode feed (filter by cuisine/category/budget)
  - `GET /dishes/search?q=` — interim case-insensitive text search (name,
    description, ingredients) — NOT the AI Clustering feature from the
    Master Prompt; that still needs real dish-volume data to learn from
  - `GET /dishes/:id` — full dish detail page data
  - `POST /dishes/:id/gestures` *(auth required)* — react with a taste
    gesture; userId comes from the token, never the request body
  - `POST /follows`, `DELETE /follows`, `GET /follows` *(auth required)* —
    follow/unfollow a dish, cuisine, or category (never a person)
  - `GET /cuisines`, `GET /categories` — lookups for upload/filter forms
- Seed script with a sample vendor + 2 dishes so the feed isn't empty on first run

### Why Haversine instead of PostGIS for vendor distance
PostGIS needs a database extension enabled and a geography column — real
infra to stand up. A plain lat/long Haversine calculation in JS works fine
at current (low) vendor counts and needs zero extra infra. The migration to
PostGIS is still the right move once vendor count makes calculating distance
over every row in JS too slow — not before.

## Pagination (BE-005)
Cursor-based, per CTO decision — stays stable under concurrent writes,
unlike offset pagination which can skip/repeat rows when data changes
between page requests. Applied to `/dishes/feed`, `/dishes/search`, and
plain `/vendors` listing (`?cursor=<id>&limit=<n>`, default limit 20, max 50).
Response shape: `{ items, nextCursor, hasMore }`.

**Known limitation:** the distance-sorted branch of `GET /vendors` (when
`lat`/`lng` are passed) sorts in application code, not the database, so it
uses simple limit-based truncation rather than true cursor pagination —
a cursor can't reference a position in a sort order the database itself
doesn't compute. Real cursor pagination there needs the PostGIS migration.

## Rate Limiting (BE-003)
In-memory (`express-rate-limit`), per CTO decision — appropriate for a
single instance; would need a shared store (Redis) if ever run across
multiple processes. Auth endpoints (`/auth/*`) get a stricter limit
(10 requests/15min) layered on top of the general API limit
(300 requests/15min).

## Logging (BE-004)
Structured logging via `pino`, per CTO decision. Every request gets a
traceable ID (`x-request-id` header, respects one if already provided).
Pretty-printed in development, structured JSON in production
(`NODE_ENV=production`) for future log aggregation. Set `LOG_LEVEL` in
`.env` to control verbosity.

## Centralized Error Handling (PH-001)
Every error response from every endpoint now comes out in one standard shape:
```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Human-readable description",
    "requestId": "uuid-for-tracing",
    "details": { "...optional, e.g. Zod field errors..." }
  }
}
```
Route handlers `throw` typed errors (`BadRequestError`, `UnauthorizedError`,
`ForbiddenError`, `NotFoundError`, `ConflictError` — see `src/lib/errors.ts`)
instead of manually calling `res.status().json()`. A single middleware
(`src/middleware/errorHandler.ts`, mounted last in `index.ts`) formats every
one of these — plus unhandled Zod errors, known Prisma errors (unique
constraint violations, missing records), and any unexpected exception — into
the shape above, logging appropriately via `pino` without ever leaking
internal details (stack traces, raw DB errors) to the client.

**This changed existing response shapes.** Errors that previously looked
like `{"error": "You can only update your own dishes"}` now look like
`{"error": {"code": "FORBIDDEN", "message": "You can only update your own
dishes", "requestId": "..."}}`. If you're building a mobile/frontend client
against error responses, read from `error.message` / `error.code`, not a
bare `error` string. This is exactly why regression testing is the very
next step before this can be considered stable — see Suggested Next Steps.

## Known Behaviors and Edge Cases

These are documented facts about the current API — not bugs in the remaining code, but
behaviors a client developer must know about:

- **`DELETE /follows` uses a request body** — not all HTTP clients forward a body on
  DELETE (some browsers, proxies, and `fetch` implementations drop it silently). Pass
  `targetType` and `targetId` in the JSON body. If requests silently do nothing, verify
  your HTTP client is actually sending the body (INC-001).

- **`GET /cuisines` and `GET /categories` return a bare array** — unlike every other list
  endpoint (which returns `{ items, nextCursor, hasMore }`), these return a plain JSON
  array. Intentional: they are small, bounded lookup tables whose full contents are needed
  at once for filter dropdowns and upload forms (INC-002).

- **`Dish.saveCount` exists in the schema but is never written** — the column is reserved
  for a future "save to collection" feature. No write path exists yet; the value will
  always be `0` (UND-005).

- **Expired JWT on optional-auth routes** — routes that do not call `requireAuth` (e.g.
  `GET /dishes/feed`) silently treat an expired token as anonymous. The response is a
  normal 200 with no indication of expiry. Clients must inspect the JWT `exp` claim
  locally before sending the token (UND-007).

- **Cursor pointing to a deleted record** — if a client holds a `nextCursor` value and
  the record it references is deleted before the next page request, Prisma silently starts
  from the beginning of the dataset or returns an empty page. Known edge case of
  cursor-based pagination at scale (EDGE-001).

- **`GET /dishes/:id` and `GET /vendors/:id` have unbounded includes** — at seed scale
  this is fine. A dish with thousands of reviews or gestures, or a vendor with hundreds
  of dishes, will return a very large payload. `take:` limits should be added once real
  traffic justifies it (INC-004, INC-005).

## What's deliberately NOT here yet (and why)
- **Hungry/Thirsty intent modes** — need real delivery-speed/distance data first
- **Food Graph / Substitute / Complement engines** — need real dish volume to
  learn relationships from; building this on 2 seed dishes would be guessing
- **SEO city/cuisine pages, vendor analytics, live streaming, monetization** —
  all scale-phase features per the roadmap in the master doc
- **Media upload** — storage provider decision is made (Cloudflare R2), but
  per explicit engineering guardrails this remains PREPARATION ONLY until
  Backend Stabilization closes and real R2 credentials are supplied. There
  is no upload endpoint, no R2 integration, and — correcting an earlier
  inconsistency — no storage SDK dependency in package.json either; an
  AWS SDK package was added ahead of schedule in a previous pass and was
  removed as out-of-scope. Don't mistake a dependency being present for the
  feature existing, and don't add one until this is formally promoted.

## Setup

```bash
# 1. Start Postgres
docker compose up -d

# 2. Install dependencies
npm install

# 3. Configure environment (set a real random string for JWT_SECRET)
cp .env.example .env

# 4. Create the database tables
# Note: no migration has ever actually been run against a live database yet
# (this project was built without Docker available) — this command creates
# the FULL schema, including auth + currency + follows, as the very first
# migration. There is no earlier "init" migration to conflict with.
npm run prisma:migrate

# 5. Seed sample data
npm run seed
# Safe to re-run — uses upserts throughout, will not crash or duplicate data.
# Demo account created by seed:
#   email:    vendor@foodypop.dev
#   password: FoodyPop2026!

# 6. Start the API
npm run dev
```

API will be live at `http://localhost:4000`. Try:
```bash
curl http://localhost:4000/dishes/feed

# register + get a token
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"vendor2@foodypop.dev","password":"supersecret1","displayName":"Test Vendor","accountType":"VENDOR"}'

# use the returned token to register a vendor profile
curl -X POST http://localhost:4000/vendors \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token from above>" \
  -d '{"name":"Test Kitchen","latitude":-1.29,"longitude":36.82,"address":"Nairobi"}'
```

### Honest verification status
Update: this project has now actually been run live, on a real machine,
against a real Postgres instance — the first-ever migration, seeding,
registration/login, cross-vendor authorization rejection, follows,
cursor pagination, search, rate limiting, and vendor distance sort +
dish soft-delete were all executed and passed cleanly (see
`foodypop-directive-2-verification-report.md` for full evidence).

That verification happened BEFORE this PH-001 change. The centralized
error handling work above changes response shapes for several of those
already-verified paths (e.g. the 403/401/404 error bodies). Per the
project's own engineering guardrails, this means regression testing
(re-running that full checklist against these new error shapes) is
required before PH-001 can be considered DONE — it is currently
type-checked and reasoned through by hand, matching the same standard
every other "done" item in this project has had to clear before, not
yet, DONE.

### Step 3 Assistance Fixes — Regression Testing Required

The following changes were applied in the Step 3 assistance pass. Every path
that has changed **must be re-tested** against a live database before sign-off:

| Fix ID | File | What changed |
|---|---|---|
| BUG-004 | `src/routes/vendors.ts` | Invalid/NaN `lat`/`lng` now returns `400` (was: silent empty list) |
| BUG-005 | `src/routes/dishes.ts` | Invalid `maxBudget` now returns `400` (was: NaN passed to Prisma) |
| BUG-006 | `src/routes/dishes.ts` | Invalid `kind` value now returns `400` (was: `500` from Prisma driver) |
| BUG-003 | `src/routes/follows.ts` | Duplicate follow returns `200`; new follow returns `201` (was: always `201`) |
| EDGE-002 | `src/routes/dishes.ts` | `?maxBudget=0` now correctly applies zero-price filter (was: silently ignored) |
| EDGE-006 | `src/routes/vendors.ts` | Single coordinate without the other now returns `400` (was: silently ignored) |
| EDGE-003 | `prisma/seed.ts` | Demo user now has password `FoodyPop2026!` (was: no password — login always `401`) |
| EDGE-004 | `prisma/seed.ts` | Seed is now idempotent via upserts (was: crash on re-run with `P2002`) |
| INC-006 | `src/routes/auth.ts` | `password` capped at 72 chars; `displayName` capped at 100 chars |

## Suggested next steps (in order)
1. Wire up a mobile screen (Expo/React Native) that just hits `/dishes/feed`
   and renders a scrollable list — no gestures/swipe navigation yet, just prove
   the data flows end to end.
2. Add real vendor auth (start with email/password, add OAuth later).
3. Add image upload (start with local disk or S3-compatible bucket; the Media
   model already supports it).
4. Only once you have 50-100 real dishes from real vendors, revisit the Food
   Graph / Substitute Engine — before that, there's no signal to learn from.
