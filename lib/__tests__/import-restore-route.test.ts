import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { EXPORT_FORMAT_VERSION, METADATA_SHEET_NAME, REQUIRED_SHEET_NAMES } from '../export-format';

const projectRoot = path.resolve(__dirname, '..', '..');
const testDbPath = path.join(projectRoot, 'data', 'import-restore-route-test.db');

function pushSchema(databaseUrl: string) {
  execFileSync('npx', ['prisma', 'db', 'push', '--accept-data-loss', '--skip-generate'], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

function buildRestoreWorkbookBuffer(): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheets: Record<string, Array<Record<string, unknown>>> = {
    [METADATA_SHEET_NAME]: [{ 'Export Format Version': EXPORT_FORMAT_VERSION, 'Application Version': '0.1.0', 'Export Timestamp': new Date().toISOString(), 'Required Sheets': REQUIRED_SHEET_NAMES.join(', ') }],
    Applications: [{ 'Application Code': 'ROUTE-1', Company: 'Route Co', Role: 'Software Engineer', Status: 'Not Applied' }],
    'Job Descriptions': [], Assessments: [], Interviews: [], Offers: [], Contacts: [], Notes: [], 'Activity History': [], 'Resume Versions': [], Profile: [],
  };
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name);
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('POST /api/import/restore', () => {
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
    // Deliberately does NOT delete data/backups — that directory is shared
    // with other test files (e.g. db-backup.test.ts) that may be running
    // concurrently in a different worker; each backup file created here has
    // a unique timestamped name, so there's nothing of this test's own left
    // to clean up, and blowing away the whole shared directory would race
    // with those other files' own backups.
  });

  it('backs up before writing (returning only a safe fileName, never a path) and restores every sheet', async () => {
    const databaseUrl = `file:${testDbPath}`;
    pushSchema(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;
    vi.resetModules(); // lib/prisma.ts resolves DATABASE_URL once at import time.

    const { POST } = await import('../../app/api/import/restore/route');

    const buffer = buildRestoreWorkbookBuffer();
    const formData = new FormData();
    formData.set('file', new Blob([new Uint8Array(buffer)]), 'restore.xlsx');
    formData.set('mode', 'empty');
    const request = new Request('http://localhost/api/import/restore', { method: 'POST', body: formData });

    const response = await POST(request);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.backup).toEqual({ fileName: expect.any(String) });
    expect((body.backup as { path?: string }).path).toBeUndefined();
    expect(body.backup.fileName).not.toContain('/');
    expect(body.applications).toEqual({ created: 1, updated: 0 });
    expect(body.errors).toEqual([]);
    expect(body.mode).toBe('empty');

    const { prisma } = await import('../prisma');
    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'ROUTE-1' } });
    expect(app.company).toBe('Route Co');
    await prisma.$disconnect();
  });

  it('rejects a request with no file', async () => {
    const databaseUrl = `file:${testDbPath}`;
    pushSchema(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;
    vi.resetModules();

    const { POST } = await import('../../app/api/import/restore/route');
    const request = new Request('http://localhost/api/import/restore', { method: 'POST', body: new FormData() });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it('rejects a request with a missing or invalid mode', async () => {
    const databaseUrl = `file:${testDbPath}`;
    pushSchema(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;
    vi.resetModules();

    const { POST } = await import('../../app/api/import/restore/route');
    const buffer = buildRestoreWorkbookBuffer();
    const formData = new FormData();
    formData.set('file', new Blob([new Uint8Array(buffer)]), 'restore.xlsx');
    formData.set('mode', 'delete-everything');
    const request = new Request('http://localhost/api/import/restore', { method: 'POST', body: formData });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it('returns 422 (not 200, not 400) when preflight validation fails, still with structured errors and the backup filename', async () => {
    const databaseUrl = `file:${testDbPath}`;
    pushSchema(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;
    vi.resetModules();

    const { POST } = await import('../../app/api/import/restore/route');

    // A workbook whose Applications row has no Application Code — a
    // well-formed request (valid file, valid mode) that fails validation.
    const workbook = XLSX.utils.book_new();
    const sheets: Record<string, Array<Record<string, unknown>>> = {
      [METADATA_SHEET_NAME]: [{ 'Export Format Version': EXPORT_FORMAT_VERSION, 'Application Version': '0.1.0', 'Export Timestamp': new Date().toISOString(), 'Required Sheets': REQUIRED_SHEET_NAMES.join(', ') }],
      Applications: [{ Company: 'Route Co', Role: 'Software Engineer', Status: 'Not Applied' }],
      'Job Descriptions': [], Assessments: [], Interviews: [], Offers: [], Contacts: [], Notes: [], 'Activity History': [], 'Resume Versions': [], Profile: [],
    };
    for (const [name, rows] of Object.entries(sheets)) {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name);
    }
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const formData = new FormData();
    formData.set('file', new Blob([new Uint8Array(buffer)]), 'restore.xlsx');
    formData.set('mode', 'empty');
    const request = new Request('http://localhost/api/import/restore', { method: 'POST', body: formData });

    const response = await POST(request);
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.errors).toContainEqual({ sheet: 'Applications', rowNumber: 2, message: 'Application Code is required' });
    expect(body.backup).toEqual({ fileName: expect.any(String) });

    const { prisma } = await import('../prisma');
    expect(await prisma.application.count()).toBe(0);
    await prisma.$disconnect();
  });
});
