import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';
import { commitMultiSheetImport, parseMultiSheetWorkbook, type MultiSheetWorkbookData } from '../multi-sheet-import';

const projectRoot = path.resolve(__dirname, '..', '..');
const dbPath = path.resolve(projectRoot, 'data', 'multi-sheet-import-test.db');
const databaseUrl = `file:${dbPath}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

beforeAll(async () => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  execFileSync('npx', ['prisma', 'db', 'push', '--accept-data-loss', '--skip-generate'], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
});

beforeEach(async () => {
  await prisma.$transaction([
    prisma.activity.deleteMany(),
    prisma.note.deleteMany(),
    prisma.contact.deleteMany(),
    prisma.jobDescription.deleteMany(),
    prisma.assessment.deleteMany(),
    prisma.interview.deleteMany(),
    prisma.offer.deleteMany(),
    prisma.application.deleteMany(),
    prisma.resumeVersion.deleteMany(),
    prisma.userProfile.deleteMany(),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const emptySheets: MultiSheetWorkbookData = {
  applications: [], jobDescriptions: [], assessments: [], interviews: [], offers: [],
  contacts: [], notes: [], activities: [], resumeVersions: [], profile: [],
};

describe('commitMultiSheetImport', () => {
  it('creates a fresh application, reusing its supplied Application Code as its own code', async () => {
    const summary = await commitMultiSheetImport(prisma, {
      ...emptySheets,
      applications: [{ 'Application Code': 'RESTORE-1', Company: 'Acme', Role: 'SWE', Status: 'Not Applied' }],
    });
    expect(summary.applications).toEqual({ created: 1, updated: 0 });
    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-1' } });
    expect(app.company).toBe('Acme');
  });

  it('treats a supplied Application Code that matches an existing row as an UPDATE of that same record, not a new one', async () => {
    const existing = await prisma.application.create({ data: { applicationCode: 'RESTORE-CODE', company: 'Old Name Co', role: 'SWE', status: 'Not Applied', currentStage: 'Discovered' } });
    const summary = await commitMultiSheetImport(prisma, {
      ...emptySheets,
      applications: [{ 'Application Code': 'RESTORE-CODE', Company: 'Updated Name Co', Role: 'SWE', Status: 'Applied' }],
    });
    expect(summary.applications).toEqual({ created: 0, updated: 1 });
    expect(await prisma.application.count()).toBe(1);
    const updated = await prisma.application.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.company).toBe('Updated Name Co');
    expect(updated.status).toBe('Applied');
  });

  it('generates a fresh code for a new row with no supplied Application Code at all, never colliding with an existing one', async () => {
    await prisma.application.create({ data: { applicationCode: 'ACME-SOFT-260101', company: 'Acme', role: 'Software Engineer', status: 'Not Applied', currentStage: 'Discovered' } });
    const summary = await commitMultiSheetImport(prisma, {
      ...emptySheets,
      applications: [{ Company: 'Acme', Role: 'Software Engineer', Status: 'Not Applied' }],
    });
    expect(summary.applications).toEqual({ created: 1, updated: 0 });
    expect(await prisma.application.count()).toBe(2);
    const codes = (await prisma.application.findMany({ select: { applicationCode: true } })).map((a) => a.applicationCode);
    expect(new Set(codes).size).toBe(2); // no collision between the pre-existing row and the newly restored one
  });

  it('matches an existing Resume Version by name case-insensitively instead of creating a duplicate', async () => {
    await prisma.resumeVersion.create({ data: { name: 'SWE Resume 2026', targetType: 'SWE' } });
    const summary = await commitMultiSheetImport(prisma, {
      ...emptySheets,
      resumeVersions: [{ Name: 'swe resume 2026', 'Target Type': 'SWE' }],
    });
    expect(summary.resumeVersions).toEqual({ created: 0, matched: 1 });
    expect(await prisma.resumeVersion.count()).toBe(1);
  });

  it('links an Application to its Resume Version by name, resolved after Resume Versions are committed first', async () => {
    const summary = await commitMultiSheetImport(prisma, {
      ...emptySheets,
      resumeVersions: [{ Name: 'SWE Resume 2026', 'Target Type': 'SWE' }],
      applications: [{ 'Application Code': 'RESTORE-2', Company: 'Acme', Role: 'SWE', Status: 'Applied', 'Resume Version': 'SWE Resume 2026' }],
    });
    expect(summary.resumeVersions.created).toBe(1);
    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-2' }, include: { resumeVersion: true } });
    expect(app.resumeVersion?.name).toBe('SWE Resume 2026');
  });

  it('gracefully treats a malformed date cell as null rather than throwing', async () => {
    const summary = await commitMultiSheetImport(prisma, {
      ...emptySheets,
      applications: [{ 'Application Code': 'RESTORE-3', Company: 'Acme', Role: 'SWE', Status: 'Not Applied', 'Application Deadline': 'not-a-date', 'Date Found': '2026-02-31' }],
    });
    expect(summary.applications).toEqual({ created: 1, updated: 0 });
    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-3' } });
    expect(app.applicationDeadline).toBeNull();
    expect(app.dateFound).toBeNull();
  });

  it('upserts the Offer for the same application rather than duplicating it on a second restore', async () => {
    await commitMultiSheetImport(prisma, {
      ...emptySheets,
      applications: [{ 'Application Code': 'RESTORE-4', Company: 'Acme', Role: 'SWE', Status: 'Offer' }],
      offers: [{ 'Application Code': 'RESTORE-4', 'Offer Date': '2026-08-01', 'Decision Deadline': '2026-09-01', Compensation: '$150k' }],
    });
    const summary = await commitMultiSheetImport(prisma, {
      ...emptySheets,
      applications: [{ 'Application Code': 'RESTORE-4', Company: 'Acme', Role: 'SWE', Status: 'Offer' }],
      offers: [{ 'Application Code': 'RESTORE-4', 'Offer Date': '2026-08-01', 'Decision Deadline': '2026-10-01', Compensation: '$160k' }],
    });
    expect(summary.offers).toEqual({ created: 1 });
    expect(await prisma.offer.count()).toBe(1);
    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-4' }, include: { offers: true } });
    expect(app.offers?.decisionDeadline?.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(app.offers?.compensationSummary).toBe('$160k');
  });

  it('upserts the Profile singleton rather than creating a second row on a second restore', async () => {
    await commitMultiSheetImport(prisma, { ...emptySheets, profile: [{ Name: 'Riddhima Yadav', School: 'UT Austin' }] });
    const summary = await commitMultiSheetImport(prisma, { ...emptySheets, profile: [{ Name: 'Riddhima Yadav', School: 'UT Austin Updated' }] });
    expect(summary.profile).toEqual({ created: false, updated: true });
    expect(await prisma.userProfile.count()).toBe(1);
    const profile = await prisma.userProfile.findFirstOrThrow();
    expect(profile.school).toBe('UT Austin Updated');
  });

  it('reports a missing-required-field error for a child-sheet row instead of crashing the whole restore', async () => {
    const summary = await commitMultiSheetImport(prisma, {
      ...emptySheets,
      applications: [{ 'Application Code': 'RESTORE-5', Company: 'Acme', Role: 'SWE', Status: 'Applied' }],
      notes: [{ 'Application Code': 'RESTORE-5', Content: '' }],
    });
    expect(summary.errors).toEqual([{ sheet: 'Notes', rowNumber: 2, message: 'Content is required' }]);
    expect(summary.notes).toEqual({ created: 0 });
  });
});

describe('parseMultiSheetWorkbook', () => {
  it('returns an empty array for a sheet that does not exist in the workbook, rather than throwing', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ Company: 'Acme' }]), 'Applications');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const parsed = parseMultiSheetWorkbook(buffer);
    expect(parsed.applications).toHaveLength(1);
    expect(parsed.assessments).toEqual([]);
    expect(parsed.profile).toEqual([]);
  });
});
