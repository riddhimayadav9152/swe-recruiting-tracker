import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const projectRoot = path.resolve(__dirname, '..', '..');
const backupDir = path.join(projectRoot, 'data', 'backups');
const testDbPath = path.join(projectRoot, 'data', 'db-backup-test.db');

describe('createDatabaseBackup', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    vi.resetModules();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  });

  it('copies the resolved database file to data/backups with a timestamped name and returns its path', async () => {
    fs.writeFileSync(testDbPath, 'fake-sqlite-contents');
    process.env.DATABASE_URL = `file:${testDbPath}`;
    vi.resetModules(); // lib/prisma.ts resolves DATABASE_URL once at import time — force a fresh read.

    const { createDatabaseBackup } = await import('../db-backup');
    const result = createDatabaseBackup();

    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.fileName).toContain('db-backup-test.db');
    expect(result.fileName).toContain('pre-import-');
    expect(fs.readFileSync(result.path, 'utf8')).toBe('fake-sqlite-contents');
    expect(path.dirname(result.path)).toBe(backupDir);
  });

  it('is safe to call repeatedly — each call gets its own distinctly-named backup', async () => {
    fs.writeFileSync(testDbPath, 'v1');
    process.env.DATABASE_URL = `file:${testDbPath}`;
    vi.resetModules();

    const { createDatabaseBackup } = await import('../db-backup');
    const first = createDatabaseBackup();
    fs.writeFileSync(testDbPath, 'v2');
    // Timestamps are second-resolution; nudge so two calls in the same test
    // don't collide on filename.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = createDatabaseBackup();

    expect(first.path).not.toBe(second.path);
    expect(fs.readFileSync(first.path, 'utf8')).toBe('v1');
    expect(fs.readFileSync(second.path, 'utf8')).toBe('v2');
  });

  it('throws (aborting the caller) when the source database file does not exist', async () => {
    process.env.DATABASE_URL = `file:${path.join(projectRoot, 'data', 'does-not-exist.db')}`;
    vi.resetModules();

    const { createDatabaseBackup } = await import('../db-backup');
    expect(() => createDatabaseBackup()).toThrow(/not found/);
  });
});
