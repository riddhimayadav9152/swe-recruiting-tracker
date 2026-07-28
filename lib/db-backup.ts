import fs from 'node:fs';
import path from 'node:path';
import { resolvedDatabaseFilePath } from '@/lib/prisma';

export type DatabaseBackupResult = { path: string; fileName: string };

/**
 * Copies the live SQLite database file to `data/backups/` with a timestamped
 * name, before any risky bulk write (an import commit). Throws if the
 * source database file can't be found or the copy fails — callers (see
 * app/api/import/commit/route.ts) treat that as fatal and abort the import
 * entirely rather than writing without a safety net.
 *
 * See docs/db-upgrades/next-action-due-kind.md for the same backup/restore
 * pattern already used by the nextActionDueKind backfill script.
 */
export function createDatabaseBackup(): DatabaseBackupResult {
  if (!resolvedDatabaseFilePath) {
    throw new Error('DATABASE_URL is not a file: URL — cannot create a filesystem backup');
  }
  if (!fs.existsSync(resolvedDatabaseFilePath)) {
    throw new Error(`Database file not found at ${resolvedDatabaseFilePath} — cannot back up before import`);
  }

  const repoRoot = path.resolve(process.cwd());
  const backupDir = path.join(repoRoot, 'data', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${path.basename(resolvedDatabaseFilePath)}.pre-import-${stamp}.bak`;
  const backupPath = path.join(backupDir, fileName);

  fs.copyFileSync(resolvedDatabaseFilePath, backupPath);

  return { path: backupPath, fileName };
}
