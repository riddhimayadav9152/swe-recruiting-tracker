# DB upgrade: `nextActionDueKind` on `Application`

## Why

`Application.nextActionDue` is populated by different workflows from two
different kinds of source value:

- A **calendar date** with no time component (e.g. `offerWorkflow` copies it
  straight from the offer's own `decisionDeadline`, or an imported/created
  application copies it from `applicationDeadline`).
- A **real timestamp** (e.g. "one day before the scheduled interview").

Formatting these the same way is wrong in both directions — a calendar date
formatted with a time-of-day component is misleading, and a real timestamp
that happens to land on exact UTC midnight must NOT be reformatted as a fixed
calendar day (that's the bug `nextActionDueKind` exists to prevent; see
`lib/dates.ts`'s `formatByKind`). Which kind applies is tracked explicitly on
the row itself rather than inferred from the value, because inference is
exactly what broke before.

This project has no formal migration history (`prisma db push` only, no
`prisma/migrations/`), so this column was originally added with a plain `db
push`. This document is the retroactive, repeatable procedure for applying
that same change — column + backfill — to any other copy of the database
(a restored backup, a machine that hasn't pulled recently, etc.), safely.

## A note on relative SQLite URLs

`DATABASE_URL` in `.env` is `file:../data/dev.db`. Prisma resolves a relative
`file:` URL **relative to `prisma/schema.prisma`'s own directory** (`prisma/`),
not the repo root and not whatever directory you happen to run a command
from. So `file:../data/dev.db` means `<repo root>/data/dev.db` — the `../`
is what walks back up out of `prisma/` to the repo root. `lib/prisma.ts`
resolves it this exact same way at runtime, and
`scripts/backfill-next-action-due-kind.mjs` mirrors it too, so both always
operate on the same physical file the app and the Prisma CLI use.

**When pointing either of them at some other repository-root-relative
database file, write it the same way**: `file:../data/example.db` — not
`file:./data/example.db` or `file:data/example.db`, which would resolve
inside `prisma/` instead and silently create/read the wrong file.

## Procedure

**1. Back up first.** The backfill script below also takes its own backup
automatically, but take one yourself too if you want an extra safety net:

```bash
cp data/dev.db "data/dev.db.backup-$(date +%Y%m%d%H%M%S)"
```

**2. Add the column(s).** `nextActionDueKind` (on `Application`) and
`timezone` (a nullable column on `Assessment`, added alongside it for the OA
deadline timezone feature) are already declared in `prisma/schema.prisma`
with safe defaults/nullability, so bringing any database up to date is just:

```bash
npx prisma db push
```

This is additive and non-destructive:
- `Application.nextActionDueKind` gets `'timestamp'` for free on every
  existing row, which is already correct for every workflow-derived deadline
  except the three date-only cases the backfill below handles.
- `Assessment.timezone` gets `NULL` for free on every existing row — display
  code already falls back to the viewer's local time when it's null (see
  `formatInZone` in `lib/dates.ts`), so no backfill is needed for it.

**3. Backfill `nextActionDueKind`.** Run the backfill script, pointing
`DATABASE_URL` at the database to upgrade (it defaults to reading `.env` if
`DATABASE_URL` isn't set):

```bash
npm run backfill:next-action-due-kind
# or, for a specific repository-root database file:
DATABASE_URL="file:../data/some-other.db" npm run backfill:next-action-due-kind
```

(The script is TypeScript, run via `tsx` — that's what the npm script wraps;
don't invoke it with plain `node`.)

The script (logic lives in `lib/backfill.ts`, unit tested in
`lib/__tests__/backfill.test.ts`):
- Copies the target `.db` file to `data/backups/` before making any changes.
- Verifies the `nextActionDueKind` column actually exists (exits with an
  error telling you to run step 2 first if not).
- Reclassifies a row to `nextActionDueKind = 'date'` when its current
  `nextActionDue` exactly matches one of the three known date-only sources:
  - its own `applicationDeadline`,
  - its related `Offer.decisionDeadline`,
  - any of its `Interview.followUpDate`s.
- Leaves every other row's `nextActionDueKind` untouched (already
  `'timestamp'`, which is correct — a real timestamp can coincidentally land
  on any of the above values only in vanishingly unlikely cases, which is an
  acceptable, documented trade-off of matching by value rather than tracking
  provenance directly).
- Is safe to re-run — already-backfilled rows (and rows with no
  `nextActionDue` at all) are skipped, and it never touches rows that don't
  match any of the three categories.

**4. Verify.**

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
new PrismaClient().application.groupBy({ by: ['nextActionDueKind'], _count: true }).then(console.log);
"
```

Spot-check a couple of `Offer`-status applications in the UI — their "Due"
date should still read correctly (no time-of-day, no off-by-one-day shift).

## Rollback / recovery

- **Before you've verified the backfill**: restore the backup the script
  printed the path to (or the manual one from step 1):
  ```bash
  cp data/backups/<file>.bak data/dev.db
  ```
- **After other changes have piled on top** (so restoring the whole file
  isn't an option): the backfill only ever *sets* `nextActionDueKind`, it
  never deletes data, so reverting it is a single update statement:
  ```bash
  node -e "
  const { PrismaClient } = require('@prisma/client');
  new PrismaClient().application.updateMany({ where: { nextActionDueKind: 'date' }, data: { nextActionDueKind: 'timestamp' } }).then(console.log);
  "
  ```
  (This is exactly the pre-backfill state, since every row started as the
  column's `'timestamp'` default.)
- The columns themselves (step 2) never need rolling back — both are
  additive with safe defaults/nullability, so leaving them in place is
  harmless even if you decide not to use them.
