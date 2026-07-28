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

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ datasources: { db: { url: databaseUrl } } });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
