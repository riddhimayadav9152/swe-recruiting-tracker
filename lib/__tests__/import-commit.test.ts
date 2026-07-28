import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  autoDetectColumnMap,
  buildImportPreview,
  commitImportRow,
  commitImportRowInTransaction,
  normalizeImportRow,
  validateNormalizedImportRow,
  type FieldPresenceMap,
  type NormalizedImportRow,
} from '../import';

const projectRoot = path.resolve(__dirname, '..', '..');
const dbPath = path.resolve(projectRoot, 'data', 'import-commit-test.db');
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
    prisma.assessment.deleteMany(),
    prisma.interview.deleteMany(),
    prisma.offer.deleteMany(),
    prisma.application.deleteMany(),
    prisma.resumeVersion.deleteMany(),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const BASE_MAP = autoDetectColumnMap([
  'Company', 'Role', 'URL', 'Priority', 'Status', 'Application Deadline', 'Date Found', 'Notes', 'Date Applied',
  'Resume Version', 'OA Due At', 'OA Timezone', 'OA Platform',
  'Interview Scheduled Start', 'Interview Timezone', 'Decision Deadline', 'Compensation', 'Outcome',
]);

const normalize = (row: Record<string, unknown>, map: typeof BASE_MAP = BASE_MAP): { data: NormalizedImportRow; fieldPresence: FieldPresenceMap } => {
  const outcome = normalizeImportRow(row, map);
  if (outcome.ok !== true) throw new Error(`expected a valid row, got: ${JSON.stringify(outcome)}`);
  return { data: outcome.data, fieldPresence: outcome.fieldPresence };
};

describe('commitImportRow — create', () => {
  it('creates a Not Applied row with the standard fields and no sub-records', async () => {
    const { data, fieldPresence } = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', 'Application Deadline': '2026-08-15' });
    const outcome = await commitImportRow(prisma, 'create', data, [], null, fieldPresence);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');

    const application = await prisma.application.findUniqueOrThrow({ where: { id: outcome.applicationId } });
    expect(application.status).toBe('Not Applied');
    expect(application.currentStage).toBe('Discovered');
    expect(application.applicationDeadline?.toISOString().slice(0, 10)).toBe('2026-08-15');
    expect(application.nextActionDue?.toISOString().slice(0, 10)).toBe('2026-08-15');
    expect(application.nextActionDueKind).toBe('date');
  });

  it('creates an OA-status row with a required Assessment record and a schedule-derived next-action-due, never the application deadline', async () => {
    const { data, fieldPresence } = normalize({
      Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'OA',
      'Application Deadline': '2026-01-01', // deliberately unrelated — must NOT be reused as nextActionDue
      'OA Due At': '2026-08-15T09:00', 'OA Timezone': 'America/New_York', 'OA Platform': 'Coderbyte',
    });
    const outcome = await commitImportRow(prisma, 'create', data, [], null, fieldPresence);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');

    const application = await prisma.application.findUniqueOrThrow({ where: { id: outcome.applicationId } });
    expect(application.status).toBe('OA');
    expect(application.currentStage).toBe('Online Assessment');
    // 9:00 AM EDT -> 13:00 UTC, not the Jan 1 application deadline.
    expect(application.nextActionDue?.toISOString()).toBe('2026-08-15T13:00:00.000Z');
    expect(application.nextActionDueKind).toBe('timestamp');

    const assessment = await prisma.assessment.findFirstOrThrow({ where: { applicationId: application.id } });
    expect(assessment.type).toBe('OA');
    expect(assessment.platform).toBe('Coderbyte');
    expect(assessment.timezone).toBe('America/New_York');
    expect(assessment.dueAt?.toISOString()).toBe('2026-08-15T13:00:00.000Z');
  });

  it('downgrades an OA row missing its schedule to Applied and creates NO Assessment record — never hollow', async () => {
    const { data, fieldPresence } = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'OA' });
    expect(data.status).toBe('Applied'); // downgraded already by normalizeImportRow
    const outcome = await commitImportRow(prisma, 'create', data, [], null, fieldPresence);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');

    const application = await prisma.application.findUniqueOrThrow({ where: { id: outcome.applicationId } });
    expect(application.status).toBe('Applied');
    const assessments = await prisma.assessment.findMany({ where: { applicationId: application.id } });
    expect(assessments).toHaveLength(0);
  });

  it('creates an interview-stage row with a required Interview record', async () => {
    const { data, fieldPresence } = normalize({
      Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'Technical Interview',
      'Interview Scheduled Start': '2026-08-20T14:00', 'Interview Timezone': 'America/Los_Angeles',
    });
    const outcome = await commitImportRow(prisma, 'create', data, [], null, fieldPresence);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');

    const application = await prisma.application.findUniqueOrThrow({ where: { id: outcome.applicationId } });
    expect(application.status).toBe('Technical Interview');
    expect(application.currentStage).toBe('Technical Interview');

    const interview = await prisma.interview.findFirstOrThrow({ where: { applicationId: application.id } });
    expect(interview.stage).toBe('Technical Interview');
    expect(interview.timezone).toBe('America/Los_Angeles');
    // 2:00 PM PDT -> 21:00 UTC.
    expect(interview.scheduledStart?.toISOString()).toBe('2026-08-20T21:00:00.000Z');
    expect(application.nextActionDue?.toISOString()).toBe('2026-08-20T21:00:00.000Z');
  });

  it('downgrades an interview row missing its schedule to Applied and creates NO Interview record', async () => {
    const { data, fieldPresence } = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'Recruiter Screen' });
    expect(data.status).toBe('Applied');
    const outcome = await commitImportRow(prisma, 'create', data, [], null, fieldPresence);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');
    const interviews = await prisma.interview.findMany({ where: { applicationId: outcome.applicationId } });
    expect(interviews).toHaveLength(0);
  });

  it('creates an Offer-status row with a required Offer record and the decision deadline as the next-action-due', async () => {
    const { data, fieldPresence } = normalize({
      Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'Offer',
      'Decision Deadline': '2026-09-01', Compensation: '$180k base',
    });
    const outcome = await commitImportRow(prisma, 'create', data, [], null, fieldPresence);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');

    const application = await prisma.application.findUniqueOrThrow({ where: { id: outcome.applicationId } });
    expect(application.nextActionDue?.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(application.nextActionDueKind).toBe('date');

    const offer = await prisma.offer.findUniqueOrThrow({ where: { applicationId: application.id } });
    expect(offer.decisionDeadline?.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(offer.compensationSummary).toBe('$180k base');
  });

  it('clears the next-action-due for a terminal status regardless of any supplied Application Deadline', async () => {
    const { data, fieldPresence } = normalize({
      Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'Rejected',
      'Application Deadline': '2026-08-15', Outcome: 'Position closed',
    });
    const outcome = await commitImportRow(prisma, 'create', data, [], null, fieldPresence);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');

    const application = await prisma.application.findUniqueOrThrow({ where: { id: outcome.applicationId } });
    expect(application.nextActionDue).toBeNull();
    expect(application.outcome).toBe('Position closed');
  });

  it('sets dateApplied for an Applied-status row that supplies Date Applied, and records both activity entries', async () => {
    const { data, fieldPresence } = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'Applied', 'Date Applied': '2026-07-01' });
    const outcome = await commitImportRow(prisma, 'create', data, [], null, fieldPresence);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');

    const application = await prisma.application.findUniqueOrThrow({ where: { id: outcome.applicationId } });
    expect(application.dateApplied?.toISOString().slice(0, 10)).toBe('2026-07-01');

    const activities = await prisma.activity.findMany({ where: { applicationId: application.id } });
    expect(activities.map((a) => a.eventType).sort()).toEqual(['Application submitted', 'Imported from workbook']);
  });

  it('leaves dateApplied null for an Applied-status row with no Date Applied column supplied (repairable later)', async () => {
    const { data, fieldPresence } = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'Applied' });
    const outcome = await commitImportRow(prisma, 'create', data, [], null, fieldPresence);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: outcome.applicationId } });
    expect(application.dateApplied).toBeNull();
    const activity = await prisma.activity.findFirstOrThrow({ where: { applicationId: application.id, eventType: 'Application submitted' } });
    expect(activity).toBeTruthy();
  });

  it('looks up an existing resume version by name', async () => {
    const resume = await prisma.resumeVersion.create({ data: { name: 'SWE Resume 2026', targetType: 'SWE' } });
    const { data, fieldPresence } = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'Applied', 'Resume Version': 'SWE Resume 2026' });
    const outcome = await commitImportRow(prisma, 'create', data, [], null, fieldPresence);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: outcome.applicationId } });
    expect(application.resumeVersionId).toBe(resume.id);
  });

  it('leaves resumeVersionId null for an unmatched resume name rather than guessing', async () => {
    const { data, fieldPresence } = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', 'Resume Version': 'Nonexistent Resume' });
    const outcome = await commitImportRow(prisma, 'create', data, [], null, fieldPresence);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: outcome.applicationId } });
    expect(application.resumeVersionId).toBeNull();
  });

  it('creates a new resume version when the row explicitly decides to', async () => {
    const { data, fieldPresence } = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', 'Resume Version': 'Brand New Resume' });
    const outcome = await commitImportRow(prisma, 'create', data, [], null, fieldPresence, {
      resumeVersionDecision: { action: 'create', name: 'Brand New Resume', targetType: 'SWE' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: outcome.applicationId }, include: { resumeVersion: true } });
    expect(application.resumeVersion?.name).toBe('Brand New Resume');
  });

  it('fails an update with no matched application id rather than silently creating one', async () => {
    const { data, fieldPresence } = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply' });
    const outcome = await commitImportRow(prisma, 'update', data, [], null, fieldPresence);
    expect(outcome.ok).toBe(false);
  });
});

describe('commitImportRow — update (field-presence-aware)', () => {
  const seedExisting = () => prisma.application.create({
    data: {
      applicationCode: 'EXIST-1', company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply',
      status: 'Not Applied', currentStage: 'Discovered', priority: 'P1', location: 'NYC',
      applicationDeadline: new Date('2026-08-01T00:00:00.000Z'), notes: 'Original note',
    },
  });

  it('a sparse update (most columns unmapped) preserves every field the row did not map', async () => {
    const existing = await seedExisting();
    const sparseMap = autoDetectColumnMap(['Company', 'Role', 'URL', 'Notes']);
    const { data, fieldPresence } = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Notes: 'Updated note' }, sparseMap);

    const outcome = await commitImportRow(prisma, 'update', data, [], existing.id, fieldPresence);
    expect(outcome.ok).toBe(true);

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.notes).toBe('Updated note'); // mapped + supplied -> changed
    expect(updated.priority).toBe('P1'); // never mapped -> preserved
    expect(updated.location).toBe('NYC'); // never mapped -> preserved
    expect(updated.applicationDeadline?.toISOString().slice(0, 10)).toBe('2026-08-01'); // never mapped -> preserved
    expect(updated.status).toBe('Not Applied'); // never mapped -> preserved
  });

  it('does NOT reset priority to P2 merely because the Priority column was unmapped', async () => {
    const existing = await seedExisting();
    const map = autoDetectColumnMap(['Company', 'Role', 'URL']);
    const { data, fieldPresence } = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply' }, map);
    expect(data.priority).toBe('P2'); // normalizeImportRow's own create-oriented default

    await commitImportRow(prisma, 'update', data, [], existing.id, fieldPresence);
    const updated = await prisma.application.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.priority).toBe('P1'); // untouched, NOT overwritten with the P2 default
  });

  it('a mapped-but-blank field is preserved UNLESS explicitly confirmed as a clear', async () => {
    const existing = await seedExisting();
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Location']);
    const { data, fieldPresence } = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Location: '' }, map);

    await commitImportRow(prisma, 'update', data, [], existing.id, fieldPresence);
    let updated = await prisma.application.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.location).toBe('NYC'); // blank, NOT confirmed -> preserved

    await commitImportRow(prisma, 'update', data, [], existing.id, fieldPresence, { confirmedClears: ['location'] });
    updated = await prisma.application.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.location).toBeNull(); // blank, confirmed -> cleared
  });

  it('a status-changing update derives a compatible stage, next action, and upserts the matching sub-record', async () => {
    const existing = await seedExisting();
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Status', 'OA Due At', 'OA Timezone', 'OA Platform']);
    const { data, fieldPresence } = normalize({
      Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'OA',
      'OA Due At': '2026-08-20T09:00', 'OA Timezone': 'America/New_York', 'OA Platform': 'HackerRank',
    }, map);

    const outcome = await commitImportRow(prisma, 'update', data, [], existing.id, fieldPresence);
    expect(outcome.ok).toBe(true);

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.status).toBe('OA');
    expect(updated.currentStage).toBe('Online Assessment');
    expect(updated.nextActionDue?.toISOString()).toBe('2026-08-20T13:00:00.000Z');
    expect(updated.nextActionDueKind).toBe('timestamp');

    const assessment = await prisma.assessment.findFirstOrThrow({ where: { applicationId: existing.id } });
    expect(assessment.platform).toBe('HackerRank');

    const activity = await prisma.activity.findFirstOrThrow({ where: { applicationId: existing.id, eventType: 'Updated from workbook' } });
    expect(activity.summary).toContain('Not Applied → OA');
  });

  it('re-running the same OA update updates the existing Assessment rather than creating a second one', async () => {
    const existing = await seedExisting();
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Status', 'OA Due At', 'OA Timezone']);
    const first = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'OA', 'OA Due At': '2026-08-20T09:00', 'OA Timezone': 'America/New_York' }, map);
    await commitImportRow(prisma, 'update', first.data, [], existing.id, first.fieldPresence);

    const second = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'OA', 'OA Due At': '2026-08-25T09:00', 'OA Timezone': 'America/New_York' }, map);
    await commitImportRow(prisma, 'update', second.data, [], existing.id, second.fieldPresence);

    const assessments = await prisma.assessment.findMany({ where: { applicationId: existing.id } });
    expect(assessments).toHaveLength(1);
    expect(assessments[0].dueAt?.toISOString()).toBe('2026-08-25T13:00:00.000Z');
  });

  it('clears the next-action-due when an update changes status to a terminal one', async () => {
    const existing = await prisma.application.create({
      data: { applicationCode: 'EXIST-2', company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', status: 'Applied', currentStage: 'Application Submitted', nextActionDue: new Date(), nextActionDueKind: 'timestamp' },
    });
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Status', 'Outcome']);
    const { data, fieldPresence } = normalize({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'Rejected', Outcome: 'Position closed' }, map);

    await commitImportRow(prisma, 'update', data, [], existing.id, fieldPresence);
    const updated = await prisma.application.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.status).toBe('Rejected');
    expect(updated.nextActionDue).toBeNull();
    expect(updated.outcome).toBe('Position closed');
  });
});

describe('validateNormalizedImportRow (commit-time re-validation)', () => {
  it('re-rejects a tampered payload with an invalid status', () => {
    const result = validateNormalizedImportRow({ company: 'Acme', role: 'SWE', applicationUrl: 'https://acme.com/apply', priority: 'P1', status: 'Hacked Status' });
    expect(result.ok).toBe(false);
  });

  it('re-enforces the Offer decision-deadline requirement even if the client omitted it', () => {
    const result = validateNormalizedImportRow({
      company: 'Acme', role: 'SWE', applicationUrl: 'https://acme.com/apply', priority: 'P1', status: 'Offer',
      applicationDeadline: null, dateFound: null, dateApplied: null, assessmentDueAt: null, assessmentTimezone: null,
      interviewScheduledStart: null, interviewTimezone: null, offerDecisionDeadline: null, nextActionDue: null, nextActionDueKind: null,
    });
    expect(result.ok).toBe(false);
  });

  it('re-rejects a nextActionDue with no matching nextActionDueKind', () => {
    const result = validateNormalizedImportRow({
      company: 'Acme', role: 'SWE', applicationUrl: 'https://acme.com/apply', priority: 'P1', status: 'Not Applied',
      applicationDeadline: null, dateFound: null, dateApplied: null, assessmentDueAt: null, assessmentTimezone: null,
      interviewScheduledStart: null, interviewTimezone: null, offerDecisionDeadline: null, nextActionDue: '2026-08-15', nextActionDueKind: null,
    });
    expect(result.ok).toBe(false);
  });
});

describe('full import batch behavior', () => {
  it('per-row mode: partial failure in one row does not affect other rows already committed in the same batch', async () => {
    const goodRowA = normalize({ Company: 'Good Co A', Role: 'Software Engineer', URL: 'https://good-a.example.com/apply' });
    const goodRowB = normalize({ Company: 'Good Co B', Role: 'Software Engineer', URL: 'https://good-b.example.com/apply' });
    const existingCodes: string[] = [];

    const first = await commitImportRow(prisma, 'create', goodRowA.data, existingCodes, null, goodRowA.fieldPresence);
    expect(first.ok).toBe(true);

    // Simulate a row that fails at the database layer: an update pointed at
    // an application id that doesn't exist.
    const failing = await commitImportRow(prisma, 'update', goodRowB.data, existingCodes, 'does-not-exist', goodRowB.fieldPresence);
    expect(failing.ok).toBe(false);

    const third = await commitImportRow(prisma, 'create', goodRowB.data, existingCodes, null, goodRowB.fieldPresence);
    expect(third.ok).toBe(true);

    // Row A's commit is untouched by row 2's failure, and row 3 still went
    // through — a mid-batch failure never rolls back earlier successes.
    const applications = await prisma.application.findMany();
    expect(applications).toHaveLength(2);
  });

  it('entire-batch mode: a failure partway through rolls back every row in the same transaction, including earlier successes', async () => {
    const goodRowA = normalize({ Company: 'Batch Co A', Role: 'Software Engineer', URL: 'https://batch-a.example.com/apply' });
    const goodRowB = normalize({ Company: 'Batch Co B', Role: 'Software Engineer', URL: 'https://batch-b.example.com/apply' });
    const existingCodes: string[] = [];

    await expect(
      prisma.$transaction(async (tx) => {
        await commitImportRowInTransaction(tx, 'create', goodRowA.data, existingCodes, null, goodRowA.fieldPresence);
        // This row fails (no matched application) — throwing here must
        // abort the WHOLE transaction, undoing row A's create too.
        await commitImportRowInTransaction(tx, 'update', goodRowB.data, existingCodes, null, goodRowB.fieldPresence);
      }),
    ).rejects.toThrow();

    const applications = await prisma.application.findMany();
    expect(applications).toHaveLength(0);
  });

  it('importing the same workbook twice: second pass detects every row as a database duplicate', async () => {
    const rows = [
      { Company: 'Repeat Co', Role: 'Software Engineer', URL: 'https://repeat.example.com/apply' },
      { Company: 'Second Co', Role: 'Data Scientist', URL: 'https://second.example.com/apply' },
    ];

    const existingCodes: string[] = [];
    for (const row of rows) {
      const { data, fieldPresence } = normalize(row);
      await commitImportRow(prisma, 'create', data, existingCodes, null, fieldPresence);
    }
    expect(await prisma.application.count()).toBe(2);

    const existingApplications = await prisma.application.findMany({
      select: { id: true, company: true, role: true, applicationUrl: true, priority: true, status: true, location: true, applicationDeadline: true, dateFound: true, dateApplied: true, notes: true, resumeVersion: { select: { name: true } } },
    });
    const withResumeName = existingApplications.map((app) => ({ ...app, resumeVersionName: app.resumeVersion?.name ?? null }));
    const preview = buildImportPreview(rows, BASE_MAP, withResumeName, []);
    expect(preview.every((row) => row.duplicate?.source === 'database')).toBe(true);
    expect(preview.every((row) => row.suggestedAction === 'skip')).toBe(true);

    // Honoring the suggested "skip" action means never calling
    // commitImportRow at all for these rows (mirroring exactly what
    // app/api/import/commit/route.ts does) — so re-importing the identical
    // workbook a second time creates nothing further.
    for (const row of preview) {
      if (row.suggestedAction === 'skip') continue;
      if (row.status !== 'valid' || !row.data || !row.fieldPresence) continue;
      await commitImportRow(prisma, 'create', row.data, existingCodes, null, row.fieldPresence);
    }
    expect(await prisma.application.count()).toBe(2);
  });
});
