#!/usr/bin/env node
// One-time backfill for the `nextActionDueKind` column on Application.
// See docs/db-upgrades/next-action-due-kind.md for the full runbook
// (what this does, why, and how to roll it back).
import { existsSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

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
  // Step 2: the column itself is added by `npx prisma db push` picking up
  // `nextActionDueKind` from prisma/schema.prisma (with its safe default of
  // 'timestamp') — this script only handles the backfill, which `db push`
  // has no way to know how to do.
  const columns = await prisma.$queryRawUnsafe('PRAGMA table_info(Application);');
  if (!columns.some((col) => col.name === 'nextActionDueKind')) {
    console.error("nextActionDueKind column does not exist yet. Run `npx prisma db push` first, then re-run this script.");
    process.exitCode = 1;
    return;
  }

  // Step 3: backfill. The only workflow that ever populates nextActionDue
  // from a date-only source is offerWorkflow, which copies it straight from
  // the offer's own decisionDeadline (see lib/workflows/applications.ts) —
  // every other workflow sets a real timestamp. So an application is only
  // reclassified as 'date' when its current nextActionDue still matches its
  // offer's decisionDeadline exactly; everything else keeps the safe
  // 'timestamp' default untouched.
  const candidates = await prisma.application.findMany({
    where: { status: 'Offer', nextActionDue: { not: null } },
    include: { offers: true },
  });

  let updated = 0;
  for (const application of candidates) {
    if (application.nextActionDueKind === 'date') continue;
    if (!application.offers?.decisionDeadline) continue;
    if (application.offers.decisionDeadline.getTime() !== application.nextActionDue?.getTime()) continue;
    await prisma.application.update({ where: { id: application.id }, data: { nextActionDueKind: 'date' } });
    updated += 1;
  }

  console.log(`Backfilled ${updated} application(s) to nextActionDueKind = 'date'.`);
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
