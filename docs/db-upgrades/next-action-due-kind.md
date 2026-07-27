# DB upgrade: `nextActionDueKind` on `Application`

## Why

`Application.nextActionDue` is populated by different workflows from two
different kinds of source value:

- A **calendar date** with no time component (e.g. `offerWorkflow` copies it
  straight from the offer's own `decisionDeadline`).
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

## Procedure

**1. Back up first.** The backfill script below also takes its own backup
automatically, but take one yourself too if you want an extra safety net:

```bash
cp data/dev.db "data/dev.db.backup-$(date +%Y%m%d%H%M%S)"
```

**2. Add the column.** `nextActionDueKind` is already declared in
`prisma/schema.prisma` with a safe default (`@default("timestamp")`), so
bringing any database up to date is just:

```bash
npx prisma db push
```

This is additive and non-destructive — existing rows get
`nextActionDueKind = 'timestamp'` for free, which is already correct for
every workflow-derived deadline except the offer-decision-deadline case
handled next.

**3. Backfill.** Run the backfill script, pointing `DATABASE_URL` at the
database to upgrade (it defaults to reading `.env` if `DATABASE_URL` isn't
set):

```bash
node scripts/backfill-next-action-due-kind.mjs
# or, for a specific database file:
DATABASE_URL="file:./data/some-other.db" node scripts/backfill-next-action-due-kind.mjs
```

The script:
- Copies the target `.db` file to `data/backups/` before making any changes.
- Verifies the `nextActionDueKind` column actually exists (exits with an
  error telling you to run step 2 first if not).
- Finds every application whose `status` is `Offer` and whose
  `nextActionDue` still exactly matches its own offer's `decisionDeadline`
  (the only case a date-only value could have ended up there) and sets
  `nextActionDueKind = 'date'` on those rows.
- Leaves every other row's `nextActionDueKind` untouched (already
  `'timestamp'`, which is correct).
- Is safe to re-run — already-backfilled rows are skipped.

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
- The column itself (step 2) never needs rolling back — it's additive and
  every row has a safe default, so leaving it in place is harmless even if
  you decide not to use it.
