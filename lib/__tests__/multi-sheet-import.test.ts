import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';
import { commitMultiSheetImport, parseMultiSheetWorkbook, type MultiSheetWorkbookData, type ParsedMultiSheetWorkbook } from '../multi-sheet-import';
import { EXPORT_FORMAT_VERSION, METADATA_SHEET_NAME, REQUIRED_SHEET_NAMES } from '../export-format';

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

const ALL_SHEET_NAMES = [METADATA_SHEET_NAME, ...REQUIRED_SHEET_NAMES];

const emptySheets: MultiSheetWorkbookData = {
  metadata: [{ 'Export Format Version': EXPORT_FORMAT_VERSION, 'Application Version': '0.1.0', 'Export Timestamp': new Date().toISOString(), 'Required Sheets': REQUIRED_SHEET_NAMES.join(', ') }],
  resumeVersions: [], applications: [], jobDescriptions: [], assessments: [], interviews: [], offers: [],
  contacts: [], notes: [], activities: [], profile: [],
};

/** Builds a valid parsed workbook (real Metadata sheet, every required sheet present) with the given per-sheet overrides — so each test only has to specify the rows it actually cares about. */
const buildParsed = (overrides: Partial<MultiSheetWorkbookData> = {}, presentSheetNames: string[] = ALL_SHEET_NAMES): ParsedMultiSheetWorkbook => ({
  sheets: { ...emptySheets, ...overrides },
  presentSheetNames,
});

describe('commitMultiSheetImport — happy paths', () => {
  it('creates a fresh application, reusing its supplied Application Code as its own code', async () => {
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'RESTORE-1', Company: 'Acme', Role: 'SWE', Status: 'Not Applied' }],
    }), 'empty');
    expect(summary.ok).toBe(true);
    expect(summary.applications).toEqual({ created: 1, updated: 0 });
    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-1' } });
    expect(app.company).toBe('Acme');
    expect(app.currentStage).toBe('Discovered'); // derived from Status, matching deriveInitialStage('Not Applied')
  });

  it('treats a supplied Application Code that matches an existing row as an UPDATE of that same record, not a new one', async () => {
    const existing = await prisma.application.create({ data: { applicationCode: 'RESTORE-CODE', company: 'Old Name Co', role: 'SWE', status: 'Not Applied', currentStage: 'Discovered' } });
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'RESTORE-CODE', Company: 'Updated Name Co', Role: 'SWE', Status: 'Applied' }],
    }), 'replace');
    expect(summary.ok).toBe(true);
    expect(summary.applications).toEqual({ created: 0, updated: 1 });
    expect(await prisma.application.count()).toBe(1);
    const updated = await prisma.application.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.company).toBe('Updated Name Co');
    expect(updated.status).toBe('Applied');
    expect(updated.currentStage).toBe('Application Submitted'); // re-derived from the new Status, not carried over
  });

  it('ignores a tampered/mismatched "Current Stage" cell entirely — stage is always derived from Status', async () => {
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'RESTORE-STAGE', Company: 'Acme', Role: 'SWE', Status: 'Applied', 'Current Stage': 'Totally Fabricated Stage' }],
    }), 'empty');
    expect(summary.ok).toBe(true);
    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-STAGE' } });
    expect(app.currentStage).toBe('Application Submitted');
  });

  it('generates a fresh code for a new row with no supplied Application Code at all, never colliding with an existing one', async () => {
    await prisma.application.create({ data: { applicationCode: 'ACME-SOFT-260101', company: 'Acme', role: 'Software Engineer', status: 'Not Applied', currentStage: 'Discovered' } });
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ Company: 'Acme', Role: 'Software Engineer', Status: 'Not Applied' }],
    }), 'replace');
    expect(summary.ok).toBe(true);
    expect(summary.applications).toEqual({ created: 1, updated: 0 });
    expect(await prisma.application.count()).toBe(2);
    const codes = (await prisma.application.findMany({ select: { applicationCode: true } })).map((a) => a.applicationCode);
    expect(new Set(codes).size).toBe(2);
  });

  it('matches an existing Resume Version by name case-insensitively instead of creating a duplicate', async () => {
    await prisma.resumeVersion.create({ data: { name: 'SWE Resume 2026', targetType: 'SWE' } });
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      resumeVersions: [{ Name: 'swe resume 2026', 'Target Type': 'SWE' }],
    }), 'empty');
    expect(summary.ok).toBe(true);
    expect(summary.resumeVersions).toEqual({ created: 0, matched: 1 });
    expect(await prisma.resumeVersion.count()).toBe(1);
  });

  it('links an Application to its Resume Version by name, resolved after Resume Versions are committed first', async () => {
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      resumeVersions: [{ Name: 'SWE Resume 2026', 'Target Type': 'SWE' }],
      applications: [{ 'Application Code': 'RESTORE-2', Company: 'Acme', Role: 'SWE', Status: 'Applied', 'Resume Version': 'SWE Resume 2026' }],
    }), 'empty');
    expect(summary.ok).toBe(true);
    expect(summary.resumeVersions.created).toBe(1);
    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-2' }, include: { resumeVersion: true } });
    expect(app.resumeVersion?.name).toBe('SWE Resume 2026');
  });

  it('upserts the Offer for the same application rather than duplicating it on a second restore', async () => {
    await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'RESTORE-4', Company: 'Acme', Role: 'SWE', Status: 'Offer', 'Decision Deadline': '2026-09-01' }],
      offers: [{ 'Application Code': 'RESTORE-4', 'Offer Date': '2026-08-01', 'Decision Deadline': '2026-09-01', Compensation: '$150k' }],
    }), 'empty');
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'RESTORE-4', Company: 'Acme', Role: 'SWE', Status: 'Offer', 'Decision Deadline': '2026-10-01' }],
      offers: [{ 'Application Code': 'RESTORE-4', 'Offer Date': '2026-08-01', 'Decision Deadline': '2026-10-01', Compensation: '$160k' }],
    }), 'replace');
    expect(summary.ok).toBe(true);
    expect(summary.offers).toEqual({ created: 1 });
    expect(await prisma.offer.count()).toBe(1);
    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-4' }, include: { offers: true } });
    expect(app.offers?.decisionDeadline?.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(app.offers?.compensationSummary).toBe('$160k');
  });

  it('upserts the Profile singleton rather than creating a second row on a second restore', async () => {
    await commitMultiSheetImport(prisma, buildParsed({ profile: [{ Name: 'Riddhima Yadav', School: 'UT Austin' }] }), 'empty');
    const summary = await commitMultiSheetImport(prisma, buildParsed({ profile: [{ Name: 'Riddhima Yadav', School: 'UT Austin Updated' }] }), 'empty');
    expect(summary.ok).toBe(true);
    expect(summary.profile).toEqual({ created: false, updated: true });
    expect(await prisma.userProfile.count()).toBe(1);
    const profile = await prisma.userProfile.findFirstOrThrow();
    expect(profile.school).toBe('UT Austin Updated');
  });
});

describe('commitMultiSheetImport — idempotency (repeated restore)', () => {
  const workbookWithHistory = (): MultiSheetWorkbookData => ({
    ...emptySheets,
    applications: [{ 'Application Code': 'RESTORE-IDEMPOTENT', Company: 'Acme', Role: 'SWE', Status: 'Technical Interview' }],
    assessments: [
      { 'Application Code': 'RESTORE-IDEMPOTENT', Type: 'OA', Platform: 'HackerRank' },
      { 'Application Code': 'RESTORE-IDEMPOTENT', Type: 'OA', Platform: 'Coderbyte' },
    ],
    interviews: [
      { 'Application Code': 'RESTORE-IDEMPOTENT', Stage: 'Recruiter Screen' },
      { 'Application Code': 'RESTORE-IDEMPOTENT', Stage: 'Technical Interview' },
    ],
    contacts: [{ 'Application Code': 'RESTORE-IDEMPOTENT', Name: 'Taylor Recruiter' }],
    notes: [{ 'Application Code': 'RESTORE-IDEMPOTENT', Content: 'Great first call' }],
    activities: [{ 'Application Code': 'RESTORE-IDEMPOTENT', Summary: 'Advanced to technical interview' }],
  });

  it('"replace" mode: restoring the SAME workbook a second time produces IDENTICAL final row counts, not duplicates', async () => {
    const first = await commitMultiSheetImport(prisma, buildParsed(workbookWithHistory()), 'empty');
    expect(first.ok).toBe(true);

    const app = await prisma.application.findUniqueOrThrow({
      where: { applicationCode: 'RESTORE-IDEMPOTENT' },
      include: { assessments: true, interviews: true, contacts: true, notesRelation: true, activities: true },
    });
    expect(app.assessments).toHaveLength(2);
    expect(app.interviews).toHaveLength(2);
    expect(app.contacts).toHaveLength(1);
    expect(app.notesRelation).toHaveLength(1);
    expect(app.activities).toHaveLength(1);

    const second = await commitMultiSheetImport(prisma, buildParsed(workbookWithHistory()), 'replace');
    expect(second.ok).toBe(true);
    expect(second.applications).toEqual({ created: 0, updated: 1 });

    expect(await prisma.application.count()).toBe(1); // no duplicate application
    const appAfter = await prisma.application.findUniqueOrThrow({
      where: { applicationCode: 'RESTORE-IDEMPOTENT' },
      include: { assessments: true, interviews: true, contacts: true, notesRelation: true, activities: true },
    });
    expect(appAfter.assessments).toHaveLength(2); // still 2, not 4
    expect(appAfter.interviews).toHaveLength(2); // still 2, not 4
    expect(appAfter.contacts).toHaveLength(1);
    expect(appAfter.notesRelation).toHaveLength(1);
    expect(appAfter.activities).toHaveLength(1);
  });

  it('"merge" mode: restoring the SAME workbook a second time intentionally APPENDS child rows again (documented, non-idempotent)', async () => {
    await commitMultiSheetImport(prisma, buildParsed(workbookWithHistory()), 'empty');
    const second = await commitMultiSheetImport(prisma, buildParsed(workbookWithHistory()), 'merge');
    expect(second.ok).toBe(true);

    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-IDEMPOTENT' }, include: { assessments: true, interviews: true } });
    expect(app.assessments).toHaveLength(4); // merge never deletes — doubled, as documented
    expect(app.interviews).toHaveLength(4);
  });
});

describe('commitMultiSheetImport — strict preflight validation (zero writes on any error)', () => {
  it('rejects a workbook missing the Metadata sheet entirely, writing nothing', async () => {
    const parsed = buildParsed(
      { metadata: [], applications: [{ 'Application Code': 'X', Company: 'Acme', Role: 'SWE', Status: 'Not Applied' }] },
      [...REQUIRED_SHEET_NAMES], // Metadata deliberately excluded from "present" sheets
    );
    const summary = await commitMultiSheetImport(prisma, parsed, 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('Missing Metadata sheet'))).toBe(true);
    expect(await prisma.application.count()).toBe(0);
  });

  it('rejects a workbook with an unsupported Export Format Version, writing nothing', async () => {
    const parsed = buildParsed({
      metadata: [{ 'Export Format Version': 999, 'Application Version': '0.1.0', 'Export Timestamp': new Date().toISOString(), 'Required Sheets': REQUIRED_SHEET_NAMES.join(', ') }],
      applications: [{ 'Application Code': 'X', Company: 'Acme', Role: 'SWE', Status: 'Not Applied' }],
    });
    const summary = await commitMultiSheetImport(prisma, parsed, 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('Unsupported export format version'))).toBe(true);
    expect(await prisma.application.count()).toBe(0);
  });

  it('rejects a workbook that is missing a required sheet, writing nothing', async () => {
    const presentWithoutOffers = ALL_SHEET_NAMES.filter((name) => name !== 'Offers');
    const summary = await commitMultiSheetImport(prisma, buildParsed(
      { applications: [{ 'Application Code': 'X', Company: 'Acme', Role: 'SWE', Status: 'Not Applied' }] },
      presentWithoutOffers,
    ), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('"Offers" is missing'))).toBe(true);
    expect(await prisma.application.count()).toBe(0);
  });

  it('rejects "empty" mode against a non-empty database, writing nothing', async () => {
    await prisma.application.create({ data: { applicationCode: 'PRE-EXISTING', company: 'Acme', role: 'SWE', status: 'Not Applied', currentStage: 'Discovered' } });
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'NEW-ONE', Company: 'Beta', Role: 'PM', Status: 'Not Applied' }],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('already has'))).toBe(true);
    expect(await prisma.application.count()).toBe(1); // still just the pre-existing row
  });

  it('rejects an unrecognized Status value, writing nothing', async () => {
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'X', Company: 'Acme', Role: 'SWE', Status: 'Hacked Status' }],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('not a recognized status'))).toBe(true);
    expect(await prisma.application.count()).toBe(0);
  });

  it('rejects an unrecognized Priority value, writing nothing', async () => {
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'X', Company: 'Acme', Role: 'SWE', Status: 'Not Applied', Priority: 'P9' }],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('not a recognized priority'))).toBe(true);
    expect(await prisma.application.count()).toBe(0);
  });

  it('rejects a malformed Application URL, writing nothing', async () => {
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'X', Company: 'Acme', Role: 'SWE', Status: 'Not Applied', 'Application URL': 'not a url' }],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('not a valid URL'))).toBe(true);
    expect(await prisma.application.count()).toBe(0);
  });

  it('rejects a non-blank but malformed calendar date, writing nothing (never silently parsed to null)', async () => {
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'X', Company: 'Acme', Role: 'SWE', Status: 'Not Applied', 'Application Deadline': 'not-a-date' }],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('Application Deadline') && e.message.includes('not a real calendar date'))).toBe(true);
    expect(await prisma.application.count()).toBe(0);
  });

  it('rejects an impossible calendar date (Feb 31), writing nothing', async () => {
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'X', Company: 'Acme', Role: 'SWE', Status: 'Not Applied', 'Date Found': '2026-02-31' }],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('Date Found'))).toBe(true);
    expect(await prisma.application.count()).toBe(0);
  });

  it('rejects an unmatched Application Code in a child sheet by aborting the ENTIRE restore, writing nothing at all', async () => {
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'RESTORE-6', Company: 'Acme', Role: 'SWE', Status: 'Applied' }],
      notes: [{ 'Application Code': 'DOES-NOT-EXIST-ANYWHERE', Content: 'Orphaned note' }],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.unmatchedApplicationCodes).toEqual([{ sheet: 'Notes', rowNumber: 2, applicationCode: 'DOES-NOT-EXIST-ANYWHERE' }]);
    // The whole restore aborted — even the otherwise-valid Applications row never got written.
    expect(await prisma.application.count()).toBe(0);
    expect(await prisma.note.count()).toBe(0);
  });

  it('reports a missing-required-field error for a child-sheet row and aborts the ENTIRE restore, writing nothing', async () => {
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'RESTORE-5', Company: 'Acme', Role: 'SWE', Status: 'Applied' }],
      notes: [{ 'Application Code': 'RESTORE-5', Content: '' }],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors).toContainEqual({ sheet: 'Notes', rowNumber: 2, message: 'Content is required' });
    expect(await prisma.application.count()).toBe(0);
    expect(await prisma.note.count()).toBe(0);
  });

  it('resolves a child-sheet Application Code against a NEW row created in the SAME restore, not just pre-existing rows', async () => {
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'RESTORE-7', Company: 'Acme', Role: 'SWE', Status: 'Applied' }],
      notes: [{ 'Application Code': 'RESTORE-7', Content: 'Same-batch reference' }],
    }), 'empty');
    expect(summary.ok).toBe(true);
    expect(summary.unmatchedApplicationCodes).toEqual([]);
    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-7' }, include: { notesRelation: true } });
    expect(app.notesRelation).toHaveLength(1);
  });
});

describe('parseMultiSheetWorkbook', () => {
  it('reports which sheets are actually present, distinguishing a missing sheet from an empty one', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ Company: 'Acme' }]), 'Applications');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([]), 'Assessments'); // present but empty
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const parsed = parseMultiSheetWorkbook(buffer);
    expect(parsed.sheets.applications).toHaveLength(1);
    expect(parsed.sheets.assessments).toEqual([]);
    expect(parsed.sheets.profile).toEqual([]);
    expect(parsed.presentSheetNames).toContain('Assessments'); // present, just empty
    expect(parsed.presentSheetNames).not.toContain('Profile'); // genuinely missing
  });
});
