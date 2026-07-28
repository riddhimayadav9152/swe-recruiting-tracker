#!/usr/bin/env node
// One-time backfill for the `nextActionDueKind` column on Application.
// Run via `npm run backfill:next-action-due-kind` (uses `tsx`, since this
// file imports the TypeScript lib/backfill.ts directly — running it with
// plain `node` will fail to resolve that import).
// See docs/db-upgrades/next-action-due-kind.md for the full runbook
// (what this does, why, and how to roll it back). The actual backfill logic
// lives in lib/backfill.ts (imported below) so it can be unit tested
// directly against the test database — this script is just the CLI
// wrapper: resolve the DB, back it up, run the backfill, report results.
import { existsSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { backfillNextActionDueKind } from '../lib/backfill.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const schemaDir = path.join(repoRoot, 'prisma');

const resolveDatabaseUrl = () => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(repoRoot, '.env');
  if (existsSync(envPath)) {
    const match = /^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m.exec(readFileSync(envPath, 'utf8'));
    if (match) return match[1];
  }
  throw new Error('DATABASE_URL is not set and no .env file was found. Set DATABASE_URL and re-run.');
};

// Relative SQLite `file:` URLs in this project resolve from prisma/schema.prisma's
// own directory (`prisma/`), not the repo root or the caller's cwd — e.g.
// `file:../data/dev.db` resolves to `<repoRoot>/data/dev.db`. Mirror that
// same resolution here (see lib/prisma.ts) so this script always operates on
// the exact database file the app and the Prisma CLI use.
const toAbsoluteDbPath = (databaseUrl) => {
  const filePart = databaseUrl.replace(/^file:/, '');
  return path.isAbsolute(filePart) ? filePart : path.resolve(schemaDir, filePart);
};

const databaseUrl = resolveDatabaseUrl();
const dbPath = toAbsoluteDbPath(databaseUrl);

if (!existsSync(dbPath)) {
  console.error(`Database file not found at ${dbPath}. Nothing to upgrade.`);
  process.exit(1);
}

// Step 1: back up before touching anything.
const backupDir = path.join(repoRoot, 'data', 'backups');
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `${path.basename(dbPath)}.${stamp}.bak`);
copyFileSync(dbPath, backupPath);
console.log(`Backed up ${dbPath}\n     -> ${backupPath}`);

const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

async function main() {
  // Step 2: the column itself (and the nullable Assessment.timezone column)
  // is added by `npx prisma db push` picking up prisma/schema.prisma (with
  // nextActionDueKind's safe default of 'timestamp') — this script only
  // handles the backfill, which `db push` has no way to know how to do.
  const columns = await prisma.$queryRawUnsafe('PRAGMA table_info(Application);');
  if (!columns.some((col) => col.name === 'nextActionDueKind')) {
    console.error("nextActionDueKind column does not exist yet. Run `npx prisma db push` first, then re-run this script.");
    process.exitCode = 1;
    return;
  }

  const result = await backfillNextActionDueKind(prisma);

  console.log(`Backfilled ${result.updated} application(s) to nextActionDueKind = 'date':`);
  console.log(`  - matching Application Deadline:      ${result.byCategory.applicationDeadline}`);
  console.log(`  - matching Offer decision deadline:    ${result.byCategory.offerDecisionDeadline}`);
  console.log(`  - matching Interview follow-up date:   ${result.byCategory.interviewFollowUpDate}`);
  console.log("All other applications keep the existing/default nextActionDueKind = 'timestamp'.");
  console.log(`\nIf anything here looks wrong, restore the backup:\n  cp "${backupPath}" "${dbPath}"`);
}

main()
  .catch((error) => {
    console.error(error);
    console.error(`\nRestore the pre-backfill backup with:\n  cp "${backupPath}" "${dbPath}"`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
