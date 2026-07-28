# Import backups and how to restore one

## What happens automatically

Every time you click **Confirm Import** (either commit mode — see below),
the server copies the live SQLite database file to `data/backups/` **before
writing anything**, using `lib/db-backup.ts`'s `createDatabaseBackup()`. If
that copy fails for any reason (disk full, permissions, the database file
somehow missing), the import is aborted immediately and nothing is written —
there is no path where an import runs without a fresh backup already on
disk.

The backup's filename is returned in the commit response and shown in the
"Import result" panel, e.g.:

```
data/backups/dev.db.pre-import-2026-07-28T02-15-30-000Z.bak
```

## The two commit modes

- **Per-row (recommended)** — each row is written in its own transaction. If
  one row fails, it's reported as an error but every other row still commits
  normally.
- **Entire batch (all-or-nothing)** — every row is written inside a single
  transaction. If any row fails, the whole import is rolled back and the
  database ends up exactly as it was before you clicked Confirm Import —
  in this mode you may not even need the backup to recover, since the
  database was never actually changed. The backup is still taken up front
  regardless, since a mode choice made in the UI shouldn't change how
  cautious the server itself behaves.

## Restoring a backup

**1. Find the backup.** Either read the filename from the "Import result"
panel right after the import, or list `data/backups/` — it's sorted
chronologically by the timestamp in the filename:

```bash
ls -la data/backups/
```

**2. Stop anything using the database** (the Next.js dev server, if it's
running).

**3. Copy the backup over the live database file.** The live path is
whatever `DATABASE_URL` in `.env` resolves to — by default
`data/dev.db` (see the note on relative SQLite URLs in
`docs/db-upgrades/next-action-due-kind.md` if you're pointing at a
different file):

```bash
cp data/backups/dev.db.pre-import-2026-07-28T02-15-30-000Z.bak data/dev.db
```

**4. Restart the dev server.** That's it — the restore is a plain file
copy, since SQLite's entire database lives in that one file.

## If you only want to undo the import, not everything since

If other changes have happened since the import you want to undo (so
restoring the whole backup file would also lose those), you have two
options:

- **Prefer this going forward**: use **Entire batch** mode next time — a
  failed/unwanted batch import that mode protects against never touches the
  database in the first place, so there's nothing to undo.
- **After the fact**: there's no automatic "undo just this import" — the
  backup restore above is a full point-in-time rollback. Manually deleting
  the specific rows an import created is possible via the Activity view
  (imported rows are tagged with the `Imported from workbook` /
  `Updated from workbook` activity event types, which record which
  application they touched) but is not tool-assisted today.
