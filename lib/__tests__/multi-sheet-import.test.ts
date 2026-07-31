import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';
import { commitMultiSheetImport, parseMultiSheetWorkbook, type MultiSheetWorkbookData, type ParsedMultiSheetWorkbook } from '../multi-sheet-import';
import { EXPORT_FORMAT_VERSION, METADATA_SHEET_NAME, REQUIRED_SHEET_NAMES } from '../export-format';
import { pushPrismaSchema, resetSqliteTestDatabaseFile } from '../../tests/helpers/test-database';

const projectRoot = path.resolve(__dirname, '..', '..');
const dbPath = path.resolve(projectRoot, 'data', 'multi-sheet-import-test.db');
const databaseUrl = 'file:../data/multi-sheet-import-test.db';
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

beforeAll(async () => {
  resetSqliteTestDatabaseFile(projectRoot, dbPath);
  pushPrismaSchema(projectRoot, databaseUrl);
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
  resumeVersions: [], applications: [], jobDescriptions: [], applicationLinks: [], assessments: [], interviews: [], offers: [],
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

  it('matches an existing Resume Version by name case-insensitively instead of creating a duplicate', async () => {
    await prisma.resumeVersion.create({ data: { name: 'SWE Resume 2026', targetType: 'SWE' } });
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      resumeVersions: [{ Name: 'swe resume 2026', 'Target Type': 'SWE' }],
    }), 'replace'); // 'empty' would reject this — the database already has one resume version, seeded above
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
    // The database is no longer empty (it now has the Profile row from
    // above) — 'empty' mode would reject this second call outright.
    const summary = await commitMultiSheetImport(prisma, buildParsed({ profile: [{ Name: 'Riddhima Yadav', School: 'UT Austin Updated' }] }), 'replace');
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
    applications: [{ 'Application Code': 'RESTORE-IDEMPOTENT', Company: 'Acme', Role: 'SWE', Status: 'Offer', 'Decision Deadline': '2026-09-01' }],
    jobDescriptions: [{ 'Application Code': 'RESTORE-IDEMPOTENT', 'Full Text': 'Full JD text' }],
    assessments: [
      { 'Application Code': 'RESTORE-IDEMPOTENT', Type: 'OA', Platform: 'HackerRank' },
      { 'Application Code': 'RESTORE-IDEMPOTENT', Type: 'OA', Platform: 'Coderbyte' },
    ],
    interviews: [
      { 'Application Code': 'RESTORE-IDEMPOTENT', Stage: 'Recruiter Screen' },
      { 'Application Code': 'RESTORE-IDEMPOTENT', Stage: 'Technical Interview' },
    ],
    offers: [{ 'Application Code': 'RESTORE-IDEMPOTENT', 'Decision Deadline': '2026-09-01', Compensation: '$150k' }],
    contacts: [{ 'Application Code': 'RESTORE-IDEMPOTENT', Name: 'Taylor Recruiter' }],
    notes: [{ 'Application Code': 'RESTORE-IDEMPOTENT', Content: 'Great first call' }],
    activities: [{ 'Application Code': 'RESTORE-IDEMPOTENT', Summary: 'Advanced to technical interview' }],
  });

  const fetchFullApp = () => prisma.application.findUniqueOrThrow({
    where: { applicationCode: 'RESTORE-IDEMPOTENT' },
    include: { assessments: true, interviews: true, contacts: true, notesRelation: true, activities: true, jobDescription: true, offers: true },
  });

  it('"replace" mode: restoring the SAME workbook a second time preserves EXACT counts and values for every model, not duplicates', async () => {
    const first = await commitMultiSheetImport(prisma, buildParsed(workbookWithHistory()), 'empty');
    expect(first.ok).toBe(true);

    const app = await fetchFullApp();
    expect(app.assessments).toHaveLength(2);
    expect(app.interviews).toHaveLength(2);
    expect(app.contacts).toHaveLength(1);
    expect(app.notesRelation).toHaveLength(1);
    expect(app.activities).toHaveLength(1);
    expect(app.jobDescription?.fullText).toBe('Full JD text');
    expect(app.offers?.compensationSummary).toBe('$150k');

    const second = await commitMultiSheetImport(prisma, buildParsed(workbookWithHistory()), 'replace');
    expect(second.ok).toBe(true);
    expect(second.applications).toEqual({ created: 0, updated: 1 });

    expect(await prisma.application.count()).toBe(1); // no duplicate application
    const appAfter = await fetchFullApp();
    expect(appAfter.assessments).toHaveLength(2); // still 2, not 4
    expect(appAfter.interviews).toHaveLength(2); // still 2, not 4
    expect(appAfter.contacts).toHaveLength(1);
    expect(appAfter.notesRelation).toHaveLength(1);
    expect(appAfter.activities).toHaveLength(1);
    expect(appAfter.jobDescription?.fullText).toBe('Full JD text'); // still exactly one, not duplicated
    expect(appAfter.offers?.compensationSummary).toBe('$150k'); // still exactly one, not duplicated
  });

  it('"merge" mode: restoring the SAME workbook a second time intentionally APPENDS one-to-many child rows again (documented, non-idempotent)', async () => {
    await commitMultiSheetImport(prisma, buildParsed(workbookWithHistory()), 'empty');
    const second = await commitMultiSheetImport(prisma, buildParsed(workbookWithHistory()), 'merge');
    expect(second.ok).toBe(true);

    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-IDEMPOTENT' }, include: { assessments: true, interviews: true } });
    expect(app.assessments).toHaveLength(4); // merge never deletes — doubled, as documented
    expect(app.interviews).toHaveLength(4);
  });
});

describe('commitMultiSheetImport — replace mode is exact for one-to-one records (Job Description / Offer)', () => {
  it('removes a stale JobDescription when the workbook no longer has a Job Descriptions row for that Application Code', async () => {
    await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'RESTORE-JD', Company: 'Acme', Role: 'SWE', Status: 'Applied' }],
      jobDescriptions: [{ 'Application Code': 'RESTORE-JD', 'Full Text': 'Original JD text' }],
    }), 'empty');
    expect((await prisma.jobDescription.findMany()).length).toBe(1);

    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'RESTORE-JD', Company: 'Acme', Role: 'SWE', Status: 'Applied' }],
      // No Job Descriptions row this time — the workbook no longer has one for RESTORE-JD.
    }), 'replace');
    expect(summary.ok).toBe(true);
    expect(summary.jobDescriptions).toEqual({ created: 0 });

    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-JD' }, include: { jobDescription: true } });
    expect(app.jobDescription).toBeNull();
    expect(await prisma.jobDescription.count()).toBe(0);
  });

  it('removes a stale Offer when the workbook no longer has an Offers row for that Application Code', async () => {
    await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'RESTORE-OFFER-GONE', Company: 'Acme', Role: 'SWE', Status: 'Offer', 'Decision Deadline': '2026-09-01' }],
      offers: [{ 'Application Code': 'RESTORE-OFFER-GONE', 'Decision Deadline': '2026-09-01', Compensation: '$150k' }],
    }), 'empty');
    expect(await prisma.offer.count()).toBe(1);

    const summary = await commitMultiSheetImport(prisma, buildParsed({
      // Status downgraded and no Offers row — this workbook no longer has an offer for this application.
      applications: [{ 'Application Code': 'RESTORE-OFFER-GONE', Company: 'Acme', Role: 'SWE', Status: 'Rejected' }],
    }), 'replace');
    expect(summary.ok).toBe(true);
    expect(summary.offers).toEqual({ created: 0 });

    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-OFFER-GONE' }, include: { offers: true } });
    expect(app.offers).toBeNull();
    expect(await prisma.offer.count()).toBe(0);
  });

  it('continues upserting JobDescription and Offer normally when the workbook DOES have a corresponding row', async () => {
    await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'RESTORE-JD-OFFER-KEPT', Company: 'Acme', Role: 'SWE', Status: 'Offer', 'Decision Deadline': '2026-09-01' }],
      jobDescriptions: [{ 'Application Code': 'RESTORE-JD-OFFER-KEPT', 'Full Text': 'Version 1' }],
      offers: [{ 'Application Code': 'RESTORE-JD-OFFER-KEPT', 'Decision Deadline': '2026-09-01', Compensation: '$150k' }],
    }), 'empty');

    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'RESTORE-JD-OFFER-KEPT', Company: 'Acme', Role: 'SWE', Status: 'Offer', 'Decision Deadline': '2026-09-01' }],
      jobDescriptions: [{ 'Application Code': 'RESTORE-JD-OFFER-KEPT', 'Full Text': 'Version 2' }],
      offers: [{ 'Application Code': 'RESTORE-JD-OFFER-KEPT', 'Decision Deadline': '2026-09-01', Compensation: '$170k' }],
    }), 'replace');
    expect(summary.ok).toBe(true);

    const app = await prisma.application.findUniqueOrThrow({ where: { applicationCode: 'RESTORE-JD-OFFER-KEPT' }, include: { jobDescription: true, offers: true } });
    expect(app.jobDescription?.fullText).toBe('Version 2');
    expect(app.offers?.compensationSummary).toBe('$170k');
    expect(await prisma.jobDescription.count()).toBe(1);
    expect(await prisma.offer.count()).toBe(1);
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

  it('rejects "empty" mode against a database with an existing Application, writing nothing', async () => {
    await prisma.application.create({ data: { applicationCode: 'PRE-EXISTING', company: 'Acme', role: 'SWE', status: 'Not Applied', currentStage: 'Discovered' } });
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'NEW-ONE', Company: 'Beta', Role: 'PM', Status: 'Not Applied' }],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('already has'))).toBe(true);
    expect(await prisma.application.count()).toBe(1); // still just the pre-existing row
  });

  it('rejects "empty" mode against a database with ZERO applications but an existing Resume Version — "empty" means the whole database, not just Applications', async () => {
    await prisma.resumeVersion.create({ data: { name: 'Leftover Resume', targetType: 'SWE' } });
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'NEW-ONE', Company: 'Beta', Role: 'PM', Status: 'Not Applied' }],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('resume version'))).toBe(true);
    expect(await prisma.application.count()).toBe(0);
  });

  it('rejects "empty" mode against a database with ZERO applications but an existing Profile record', async () => {
    await prisma.userProfile.create({ data: { name: 'Leftover Profile' } });
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'NEW-ONE', Company: 'Beta', Role: 'PM', Status: 'Not Applied' }],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('profile record'))).toBe(true);
    expect(await prisma.application.count()).toBe(0);
  });

  it('accepts "empty" mode when the database is TRULY empty across every model', async () => {
    expect(await prisma.application.count()).toBe(0);
    expect(await prisma.resumeVersion.count()).toBe(0);
    expect(await prisma.userProfile.count()).toBe(0);
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'TRULY-EMPTY', Company: 'Beta', Role: 'PM', Status: 'Not Applied' }],
    }), 'empty');
    expect(summary.ok).toBe(true);
  });

  it('rejects an Applications row with no Application Code, writing nothing (full-restore never generates a replacement code)', async () => {
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ Company: 'Acme', Role: 'SWE', Status: 'Not Applied' }],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors).toContainEqual({ sheet: 'Applications', rowNumber: 2, message: 'Application Code is required' });
    expect(await prisma.application.count()).toBe(0);
  });

  it('rejects duplicate Application Codes within the Applications sheet, reporting every affected row number, writing nothing', async () => {
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [
        { 'Application Code': 'DUPE-CODE', Company: 'Acme', Role: 'SWE', Status: 'Not Applied' },
        { 'Application Code': 'SOMETHING-ELSE', Company: 'Beta', Role: 'PM', Status: 'Applied' },
        { 'Application Code': 'DUPE-CODE', Company: 'Gamma', Role: 'Data Scientist', Status: 'Applied' },
      ],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('DUPE-CODE') && e.message.includes('rows 2, 4'))).toBe(true);
    // Never allowed to update the same Application sequentially — nothing was written at all.
    expect(await prisma.application.count()).toBe(0);
  });

  it('under "empty" mode, a child code that exists only in the current database is unreachable as its OWN failure — the empty-database gate rejects it first, since a pre-existing code implies a non-empty database', async () => {
    // 'empty' mode's codeExists rule is identical to 'replace' (workbook-only
    // — see the "replace" mode version of this test below, and
    // commitMultiSheetImport's own docstring) — but there is no way to
    // exercise it as a DISTINCT observable failure under 'empty' mode: any
    // database state with an existing Application Code to reference is, by
    // definition, a non-empty database, so the emptiness preflight check
    // always fires first and aborts before the child-reference check is
    // ever reached. This test documents that ordering rather than asserting
    // an unreachable combination.
    const existing = await prisma.application.create({ data: { applicationCode: 'DB-ONLY-EMPTY', company: 'Acme', role: 'SWE', status: 'Applied', currentStage: 'Application Submitted' } });
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'A-NEW-ONE', Company: 'Beta', Role: 'PM', Status: 'Not Applied' }],
      notes: [{ 'Application Code': 'DB-ONLY-EMPTY', Content: 'References a code only in the DB, not this workbook' }],
    }), 'empty');
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.message.includes('already has'))).toBe(true);
    expect(await prisma.note.count()).toBe(0);
    const stillExisting = await prisma.application.findUniqueOrThrow({ where: { id: existing.id } });
    expect(stillExisting.applicationCode).toBe('DB-ONLY-EMPTY'); // untouched
  });

  it('rejects a child-sheet Application Code that exists only in the current database (not restated in this workbook) under "replace" mode', async () => {
    await prisma.application.create({ data: { applicationCode: 'DB-ONLY-REPLACE', company: 'Acme', role: 'SWE', status: 'Applied', currentStage: 'Application Submitted' } });
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      applications: [{ 'Application Code': 'A-NEW-ONE-2', Company: 'Beta', Role: 'PM', Status: 'Not Applied' }],
      notes: [{ 'Application Code': 'DB-ONLY-REPLACE', Content: 'References a code only in the DB, not this workbook' }],
    }), 'replace');
    expect(summary.ok).toBe(false);
    expect(summary.unmatchedApplicationCodes).toEqual([{ sheet: 'Notes', rowNumber: 2, applicationCode: 'DB-ONLY-REPLACE' }]);
    expect(await prisma.note.count()).toBe(0);
    expect(await prisma.application.count()).toBe(1); // no new application created either — the whole restore aborted
  });

  it('EXPLICITLY supports a child-sheet Application Code that exists only in the current database under "merge" mode — the one mode where this is allowed', async () => {
    const existing = await prisma.application.create({ data: { applicationCode: 'DB-ONLY-MERGE', company: 'Acme', role: 'SWE', status: 'Applied', currentStage: 'Application Submitted' } });
    const summary = await commitMultiSheetImport(prisma, buildParsed({
      // No Applications row restating DB-ONLY-MERGE at all — merge mode
      // supports adding supplementary history for an application that
      // already exists, without requiring the whole Applications sheet.
      notes: [{ 'Application Code': 'DB-ONLY-MERGE', Content: 'Supplementary note merged in from another source' }],
    }), 'merge');
    expect(summary.ok).toBe(true);
    expect(summary.unmatchedApplicationCodes).toEqual([]);
    const app = await prisma.application.findUniqueOrThrow({ where: { id: existing.id }, include: { notesRelation: true } });
    expect(app.notesRelation).toHaveLength(1);
    expect(app.notesRelation[0].content).toBe('Supplementary note merged in from another source');
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
