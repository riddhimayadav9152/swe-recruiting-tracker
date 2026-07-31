import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { pushPrismaSchema, resetSqliteTestDatabaseFile } from '../../tests/helpers/test-database';

const projectRoot = path.resolve(__dirname, '..', '..');
const testDbPath = path.join(projectRoot, 'data', 'db-backup-test.db');
const testDatabaseUrl = 'file:../data/db-backup-test.db';

async function clearDatabase(databaseUrl: string) {
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await client.$transaction([
    client.activity.deleteMany(),
    client.note.deleteMany(),
    client.contact.deleteMany(),
    client.jobDescription.deleteMany(),
    client.applicationLink.deleteMany(),
    client.assessment.deleteMany(),
    client.interview.deleteMany(),
    client.offer.deleteMany(),
    client.document.deleteMany(),
    client.application.deleteMany(),
    client.resumeVersion.deleteMany(),
    client.userProfile.deleteMany(),
  ]);
  await client.$disconnect();
}

async function prepareTestDatabase(): Promise<string> {
  resetSqliteTestDatabaseFile(projectRoot, testDbPath);
  pushPrismaSchema(projectRoot, testDatabaseUrl);
  await clearDatabase(testDatabaseUrl);
  return testDatabaseUrl;
}

describe('createDatabaseBackup', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    vi.resetModules();
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const p = `${testDbPath}${suffix}`;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    // Deliberately does NOT delete the shared data/backups directory — other
    // test files (e.g. import-restore-route.test.ts) may be creating their
    // own backups there concurrently in a different worker; every backup
    // filename here is timestamp-unique, so there's nothing of THIS test's
    // own left to clean up, and clearing the whole shared directory would
    // race with those other files' backups instead.
  });

  it('returns only a bare, safe fileName — never an absolute filesystem path', async () => {
    const databaseUrl = await prepareTestDatabase();
    process.env.DATABASE_URL = databaseUrl;
    vi.resetModules(); // lib/prisma.ts / lib/db-backup.ts resolve DATABASE_URL once at import time.

    const { createDatabaseBackup } = await import('../db-backup');
    const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const result = await createDatabaseBackup(client);
    await client.$disconnect();

    expect(result).toEqual({ fileName: expect.any(String) });
    expect((result as { path?: string }).path).toBeUndefined();
    expect(result.fileName).not.toContain('/');
    expect(result.fileName).not.toContain(projectRoot);
    expect(result.fileName).toContain('pre-import-');
  });

  it('creates a real, independently-openable, integrity-checked SQLite file with every committed row — even one written under WAL', async () => {
    const databaseUrl = await prepareTestDatabase();
    process.env.DATABASE_URL = databaseUrl;
    vi.resetModules();

    const { createDatabaseBackup } = await import('../db-backup');
    const { resolveBackupPath } = await import('../db-backup');

    // A live, WAL-mode client (Prisma's SQLite default) with committed rows
    // that may still be sitting in the separate -wal file, not the main
    // database file — exactly the scenario a naive file copy would miss.
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await writer.application.create({
      data: { applicationCode: 'BACKUP-TEST-1', company: 'Backup Test Co', role: 'Software Engineer', status: 'Not Applied', currentStage: 'Discovered' },
    });
    await writer.application.create({
      data: { applicationCode: 'BACKUP-TEST-2', company: 'Backup Test Co 2', role: 'Data Scientist', status: 'Applied', currentStage: 'Application Submitted', dateApplied: new Date('2026-07-01T00:00:00.000Z') },
    });

    // Back up while the writer connection is still open and active.
    const result = await createDatabaseBackup(writer);
    const backupPath = resolveBackupPath(result.fileName);
    expect(fs.existsSync(backupPath)).toBe(true);

    // Open the backup with a completely SEPARATE Prisma/SQLite client.
    const reader = new PrismaClient({ datasources: { db: { url: `file:${backupPath}` } } });

    const integrityCheck = await reader.$queryRawUnsafe<Array<{ integrity_check: string }>>('PRAGMA integrity_check;');
    expect(integrityCheck[0].integrity_check).toBe('ok');

    const applications = await reader.application.findMany({ orderBy: { applicationCode: 'asc' } });
    expect(applications).toHaveLength(2);
    expect(applications[0].applicationCode).toBe('BACKUP-TEST-1');
    expect(applications[1].applicationCode).toBe('BACKUP-TEST-2');
    expect(applications[1].dateApplied?.toISOString().slice(0, 10)).toBe('2026-07-01');

    await writer.$disconnect();
    await reader.$disconnect();
  });

  it('rejects a fileName containing a path separator or traversal, refusing to resolve outside the backups directory', async () => {
    vi.resetModules();
    const { resolveBackupPath } = await import('../db-backup');
    expect(() => resolveBackupPath('../../etc/passwd')).toThrow(/Invalid backup file name/);
    expect(() => resolveBackupPath('sub/dir.bak')).toThrow(/Invalid backup file name/);
  });

  it('is safe to call repeatedly — each call gets its own distinctly-named backup', async () => {
    const databaseUrl = await prepareTestDatabase();
    process.env.DATABASE_URL = databaseUrl;
    vi.resetModules();

    const { createDatabaseBackup, resolveBackupPath } = await import('../db-backup');
    const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    const first = await createDatabaseBackup(client);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // timestamps are second-resolution
    const second = await createDatabaseBackup(client);
    await client.$disconnect();

    expect(first.fileName).not.toBe(second.fileName);
    expect(fs.existsSync(resolveBackupPath(first.fileName))).toBe(true);
    expect(fs.existsSync(resolveBackupPath(second.fileName))).toBe(true);
  });
});
