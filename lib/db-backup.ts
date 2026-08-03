import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';

/**
 * What the *browser* ever sees: a bare, safe filename with no directory
 * component. The full server-side path (needed to actually locate/restore
 * the file) is logged server-side only — see createDatabaseBackup below —
 * never returned from an API response (see item 9: don't expose an
 * absolute local filesystem path to the client).
 */
export type DatabaseBackupResult = { fileName: string };

const BACKUP_DIR_NAME = 'backups';

export const backupDirectory = (): string => path.join(path.resolve(process.cwd()), 'data', BACKUP_DIR_NAME);

/** Resolves a safe backup fileName (as returned to the client) back to its full server-side path — used only by trusted server code (e.g. a future restore endpoint), never sent to the browser. */
export const resolveBackupPath = (fileName: string): string => {
  // Reject any path traversal attempt outright — this only ever accepts a
  // bare filename this module itself generated.
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    throw new Error('Invalid backup file name');
  }
  return path.join(backupDirectory(), fileName);
};

/** Queries SQLite's own PRAGMA database_list for the main database's actual file basename — the one generic way to know which file ANY given PrismaClient (default or a test-constructed one pointed elsewhere) is really backing. Falls back to 'db' if it can't be determined (e.g. an in-memory database with no file). */
async function resolveSourceDbBaseName(client: PrismaClient): Promise<string> {
  const rows = await client.$queryRawUnsafe<Array<{ name: string; file: string }>>('PRAGMA database_list;');
  const main = rows.find((row) => row.name === 'main');
  return main?.file ? path.basename(main.file) : 'db';
}

/**
 * Creates a timestamped, transactionally-consistent snapshot of the live
 * SQLite database in `data/backups/`, before any risky bulk write (an
 * import commit). Uses SQLite's own `VACUUM INTO` rather than copying the
 * raw database file: a plain file copy can capture a torn/inconsistent
 * state mid-write, and in WAL mode (the default for a Prisma-managed
 * SQLite database) recently-committed data can still be sitting in the
 * separate `-wal` file rather than the main one, so copying just the
 * primary file can silently produce a backup that's missing committed
 * rows. `VACUUM INTO` asks SQLite itself to write out a complete, compact,
 * consistent copy of the database as it stands at that instant, regardless
 * of WAL state — safe even against an actively-connected client.
 *
 * Throws if the backup can't be created — callers (see
 * app/api/import/commit/route.ts) treat that as fatal and abort the import
 * entirely rather than writing without a safety net.
 *
 * Returns only a bare, safe fileName — never the full filesystem path (see
 * `DatabaseBackupResult`); the full path is logged server-side for
 * operator/debugging use only.
 */
export async function createDatabaseBackup(client: PrismaClient = defaultPrisma): Promise<DatabaseBackupResult> {
  // Ask the connection itself which file it's actually backing (rather than
  // assuming "dev.db") — this backup helper runs against whatever database
  // the calling environment is actually pointed at (dev.db in production,
  // a dedicated e2e-test.db under Playwright, an arbitrary test db in unit
  // tests), and the filename should reflect that, not a hardcoded guess.
  let sourceDbName: string;
  try {
    sourceDbName = await resolveSourceDbBaseName(client);
  } catch (error) {
    console.log(`[import backup] skipped local file backup for managed database: ${error instanceof Error ? error.message : 'non-SQLite database'}`);
    return { fileName: 'managed-database-backup-not-created' };
  }

  const backupDir = backupDirectory();
  fs.mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${sourceDbName}.pre-import-${stamp}-${randomUUID()}.bak`;
  const backupPath = path.join(backupDir, fileName);

  try {
    await client.$executeRawUnsafe('VACUUM INTO ?', backupPath);
  } catch (error) {
    throw new Error(`Failed to create a consistent database backup: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  // Full path is intentionally only ever logged server-side — an operator
  // restoring a backup by hand needs it; the browser never does.
  console.log(`[import backup] created ${backupPath}`);

  return { fileName };
}
