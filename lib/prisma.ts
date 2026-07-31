import path from 'path';
import { PrismaClient } from '@prisma/client';

// prisma/schema.prisma lives in `prisma/`, and the Prisma CLI resolves a
// relative sqlite `file:` URL relative to that directory — so `DATABASE_URL`
// in .env is written as `file:../data/dev.db` to land on repo-root/data/dev.db.
// Resolve it the same way here so the app always opens the same database file
// the CLI (`prisma db push`, `prisma studio`, etc.) operates on, regardless of
// the process's current working directory.
const repoRoot = path.resolve(process.cwd());
const schemaDir = path.join(repoRoot, 'prisma');
const defaultDbPath = path.join(repoRoot, 'data', 'dev.db');

const resolveDatabaseUrl = () => {
  const raw = process.env.DATABASE_URL;
  if (!raw) return `file:${defaultDbPath}`;
  if (!raw.startsWith('file:')) return raw;
  const filePart = raw.slice('file:'.length);
  if (path.isAbsolute(filePart)) return raw;
  return `file:${path.resolve(schemaDir, filePart)}`;
};

const databaseUrl = resolveDatabaseUrl();

// The plain absolute filesystem path backing `databaseUrl` — used by
// lib/db-backup.ts to copy the actual file this app reads/writes, resolved
// the exact same way (relative to prisma/schema.prisma's directory, not cwd).
export const resolvedDatabaseFilePath = databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : null;

// SQLite has no real concept of concurrent writers — Prisma's default
// connection pool (multiple connections against the same file) lets several
// requests race to check-then-insert against the same unique constraint
// (e.g. applicationCode), which can surface as a spurious P2002 under
// concurrent load (visible under Playwright's parallel workers hitting the
// same dev server). Forcing a single connection serializes all queries
// through one connection, matching SQLite's actual concurrency model,
// without changing `databaseUrl`/`resolvedDatabaseFilePath` (which lib/db-backup.ts
// needs as a plain file path, with no query string).
const prismaConnectionUrl = databaseUrl.startsWith('file:') ? `${databaseUrl}?connection_limit=1` : databaseUrl;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ datasources: { db: { url: prismaConnectionUrl } } });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
