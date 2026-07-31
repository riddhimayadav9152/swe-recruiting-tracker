import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  JSON_IMPORT_FORMAT_VERSION,
  applicationImportSchema,
  commitJsonImportBatch,
  previewJsonImport,
  type JsonImportRowDecision,
} from '../json-import';
import type { DuplicateMatchCandidate } from '../import';
import { pushPrismaSchema, resetSqliteTestDatabaseFile } from '../../tests/helpers/test-database';

const projectRoot = path.resolve(__dirname, '..', '..');
const dbPath = path.resolve(projectRoot, 'data', 'json-import-test.db');
const databaseUrl = 'file:../data/json-import-test.db';

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

beforeAll(async () => {
  resetSqliteTestDatabaseFile(projectRoot, dbPath);
  pushPrismaSchema(projectRoot, databaseUrl);
});

beforeEach(async () => {
  await prisma.$transaction([
    prisma.activity.deleteMany(),
    prisma.assessment.deleteMany(),
    prisma.interview.deleteMany(),
    prisma.contact.deleteMany(),
    prisma.note.deleteMany(),
    prisma.applicationLink.deleteMany(),
    prisma.jobDescription.deleteMany(),
    prisma.offer.deleteMany(),
    prisma.application.deleteMany(),
    prisma.resumeVersion.deleteMany(),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const baseApplication = (overrides: Record<string, unknown> = {}) => ({
  company: 'Acme',
  role: 'Software Engineer',
  applicationUrl: 'https://acme.com/apply',
  priority: 'P1',
  status: 'Not Applied',
  ...overrides,
});

const wrap = (applications: unknown[], format: string | undefined = JSON_IMPORT_FORMAT_VERSION) => ({
  format,
  applications,
});

describe('applicationImportSchema — field validation', () => {
  it('accepts a minimal valid row, defaulting every optional field to null/empty', () => {
    const result = applicationImportSchema.safeParse(baseApplication());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.jobId).toBeNull();
    expect(result.data.links).toEqual([]);
    expect(result.data.nextActionDueKind).toBeNull();
  });

  it('rejects a missing company', () => {
    const result = applicationImportSchema.safeParse(baseApplication({ company: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects a missing role', () => {
    const result = applicationImportSchema.safeParse(baseApplication({ role: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects an invalid applicationUrl', () => {
    const result = applicationImportSchema.safeParse(baseApplication({ applicationUrl: 'not-a-url' }));
    expect(result.success).toBe(false);
  });

  it('rejects an invalid candidatePortalUrl when supplied', () => {
    const result = applicationImportSchema.safeParse(baseApplication({ candidatePortalUrl: 'not-a-url' }));
    expect(result.success).toBe(false);
  });

  it('rejects an invalid priority', () => {
    const result = applicationImportSchema.safeParse(baseApplication({ priority: 'P99' }));
    expect(result.success).toBe(false);
  });

  it('rejects an invalid status', () => {
    const result = applicationImportSchema.safeParse(baseApplication({ status: 'Hacked Status' }));
    expect(result.success).toBe(false);
  });

  it('rejects an invalid postingStatus', () => {
    const result = applicationImportSchema.safeParse(baseApplication({ postingStatus: 'Definitely Not Real' }));
    expect(result.success).toBe(false);
  });

  it('rejects a malformed postingDate/applicationDeadline/dateFound', () => {
    expect(applicationImportSchema.safeParse(baseApplication({ postingDate: '2026-02-31' })).success).toBe(false);
    expect(applicationImportSchema.safeParse(baseApplication({ applicationDeadline: 'not-a-date' })).success).toBe(false);
    expect(applicationImportSchema.safeParse(baseApplication({ dateFound: '2026-13-01' })).success).toBe(false);
  });

  it('rejects a nextActionDue that does not match its declared kind', () => {
    const result = applicationImportSchema.safeParse(baseApplication({ nextActionDue: 'not-a-date', nextActionDueKind: 'date' }));
    expect(result.success).toBe(false);
  });

  it('accepts a nextActionDue/nextActionDueKind pair that matches (date and timestamp forms)', () => {
    expect(applicationImportSchema.safeParse(baseApplication({ nextActionDue: '2026-08-15', nextActionDueKind: 'date' })).success).toBe(true);
    expect(applicationImportSchema.safeParse(baseApplication({ nextActionDue: '2026-08-15T09:00', nextActionDueKind: 'timestamp' })).success).toBe(true);
  });

  it('rejects a link with an invalid url or unsupported category', () => {
    expect(applicationImportSchema.safeParse(baseApplication({ links: [{ label: 'Careers page', url: 'not-a-url' }] })).success).toBe(false);
    expect(applicationImportSchema.safeParse(baseApplication({ links: [{ label: 'Careers page', url: 'https://acme.com', category: 'Not A Real Category' }] })).success).toBe(false);
  });

  it('rejects a link with a missing label', () => {
    const result = applicationImportSchema.safeParse(baseApplication({ links: [{ label: '', url: 'https://acme.com' }] }));
    expect(result.success).toBe(false);
  });

  it('accepts a fully populated row including links', () => {
    const result = applicationImportSchema.safeParse(baseApplication({
      jobId: 'REQ-123',
      candidatePortalUrl: 'https://portal.acme.com',
      postingStatus: 'Open',
      location: 'Remote',
      workModel: 'Remote',
      postingDate: '2026-07-01',
      applicationDeadline: '2026-08-15',
      dateFound: '2026-07-02',
      nextAction: 'Apply',
      nextActionDue: '2026-07-10',
      nextActionDueKind: 'date',
      loginEmail: 'me@example.com',
      portalUsername: 'me123',
      passwordManagerReference: '1Password: Acme',
      confirmationNumber: 'CONF-1',
      compensationSummary: '$180k base',
      eligibility: 'US citizen',
      sponsorship: 'Not required',
      whyFit: 'Great match',
      notes: 'Some notes',
      links: [{ label: 'Careers', url: 'https://acme.com/careers', category: 'Company', notes: 'General info' }],
    }));
    expect(result.success).toBe(true);
  });
});

describe('previewJsonImport — document shape', () => {
  it('rejects a missing format field', () => {
    const result = previewJsonImport({ applications: [baseApplication()] }, []);
    expect(result.ok).toBe(false);
  });

  it('rejects an unsupported format version', () => {
    const result = previewJsonImport(wrap([baseApplication()], 'some-other-format.v2'), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Unsupported or missing format version/);
  });

  it('rejects a non-object document', () => {
    expect(previewJsonImport('just a string', []).ok).toBe(false);
    expect(previewJsonImport([baseApplication()], []).ok).toBe(false);
    expect(previewJsonImport(null, []).ok).toBe(false);
  });

  it('rejects an empty applications array', () => {
    const result = previewJsonImport(wrap([]), []);
    expect(result.ok).toBe(false);
  });

  it('rejects a document whose applications field is not an array', () => {
    const result = previewJsonImport({ format: JSON_IMPORT_FORMAT_VERSION, applications: 'nope' }, []);
    expect(result.ok).toBe(false);
  });
});

describe('previewJsonImport — per-row validation and structured errors', () => {
  it('surfaces field-level errors with {field, message} shape for an invalid row', () => {
    const result = previewJsonImport(wrap([baseApplication({ company: '', priority: 'P99' })]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe('invalid');
    expect(result.rows[0].suggestedAction).toBe('error');
    const fields = result.rows[0].errors.map((e) => e.field);
    expect(fields).toContain('company');
    expect(fields).toContain('priority');
  });

  it('keeps validating remaining rows after one row fails, preserving each row\'s own index', () => {
    const result = previewJsonImport(wrap([
      baseApplication({ company: '' }),
      baseApplication({ company: 'Good Co', applicationUrl: 'https://good.example.com/apply' }),
    ]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].index).toBe(0);
    expect(result.rows[0].status).toBe('invalid');
    expect(result.rows[1].index).toBe(1);
    expect(result.rows[1].status).toBe('valid');
  });
});

describe('previewJsonImport — duplicate detection', () => {
  it('detects a database duplicate by applicationUrl', () => {
    const existing: DuplicateMatchCandidate[] = [{ id: 'existing-1', company: 'Other Name', role: 'Other Role', applicationUrl: 'https://acme.com/apply' }];
    const result = previewJsonImport(wrap([baseApplication()]), existing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].duplicate).toEqual({ source: 'database', applicationId: 'existing-1', matchedOn: 'applicationUrl' });
    expect(result.rows[0].suggestedAction).toBe('skip');
  });

  it('detects a database duplicate by normalized company+role when the URL differs', () => {
    const existing: DuplicateMatchCandidate[] = [{ id: 'existing-2', company: '  acme  ', role: 'SOFTWARE engineer', applicationUrl: 'https://different-url.example.com' }];
    const result = previewJsonImport(wrap([baseApplication({ applicationUrl: 'https://another-url.example.com/apply' })]), existing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].duplicate).toEqual({ source: 'database', applicationId: 'existing-2', matchedOn: 'company+role' });
  });

  it('detects a batch-internal duplicate (two rows in the same paste matching each other)', () => {
    const result = previewJsonImport(wrap([
      baseApplication(),
      baseApplication({ applicationUrl: 'https://acme.com/apply' }),
    ]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].duplicate).toBeNull();
    expect(result.rows[1].duplicate).toEqual({ source: 'batch', index: 0, matchedOn: 'applicationUrl' });
    expect(result.rows[1].suggestedAction).toBe('skip');
  });

  it('suggests "create" for a row with no duplicate at all', () => {
    const result = previewJsonImport(wrap([baseApplication()]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].duplicate).toBeNull();
    expect(result.rows[0].suggestedAction).toBe('create');
  });
});

describe('previewJsonImport — generated next-action-due hint', () => {
  it('generates a hint for a Not Applied row with no supplied nextActionDue', () => {
    const result = previewJsonImport(wrap([baseApplication({ status: 'Not Applied', priority: 'P0', dateFound: '2026-07-01' })]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].generatedNextActionDue).toEqual({ value: '2026-07-03', kind: 'date' });
  });

  it('generates a hint for a Preparing row with no supplied nextActionDue', () => {
    const result = previewJsonImport(wrap([baseApplication({ status: 'Preparing', priority: 'P3', dateFound: '2026-07-01' })]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].generatedNextActionDue).toEqual({ value: '2026-07-15', kind: 'date' });
  });

  it('does NOT generate a hint when nextActionDue is already supplied', () => {
    const result = previewJsonImport(wrap([baseApplication({ status: 'Not Applied', nextActionDue: '2026-09-01', nextActionDueKind: 'date' })]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].generatedNextActionDue).toBeNull();
  });

  it('does NOT generate a hint for a status past Not Applied/Preparing (e.g. Applied)', () => {
    const result = previewJsonImport(wrap([baseApplication({ status: 'Applied' })]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].generatedNextActionDue).toBeNull();
  });
});

describe('commitJsonImportBatch — create', () => {
  it('creates a new application, its links, and an activity record in one transaction', async () => {
    const decisions: JsonImportRowDecision[] = [{
      index: 0,
      action: 'create',
      data: baseApplication({
        links: [{ label: 'Careers', url: 'https://acme.com/careers', category: 'Company' }],
      }),
    }];

    const summary = await commitJsonImportBatch(prisma, decisions);
    expect(summary.created).toBe(1);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.outcomes[0]).toMatchObject({ ok: true, action: 'create' });
    if (!summary.outcomes[0].ok) throw new Error('expected success');

    const applicationId = (summary.outcomes[0] as { applicationId: string }).applicationId;
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    expect(application.company).toBe('Acme');
    expect(application.status).toBe('Not Applied');

    const links = await prisma.applicationLink.findMany({ where: { applicationId } });
    expect(links).toHaveLength(1);
    expect(links[0].label).toBe('Careers');

    const activities = await prisma.activity.findMany({ where: { applicationId } });
    expect(activities.map((a) => a.eventType)).toContain('JSON import created');
  });

  it('computes nextActionDue using the personal-deadline rules when not supplied, for a Not Applied/Preparing row', async () => {
    const decisions: JsonImportRowDecision[] = [{
      index: 0,
      action: 'create',
      data: baseApplication({ priority: 'P0', dateFound: '2026-07-01' }),
    }];
    const summary = await commitJsonImportBatch(prisma, decisions);
    expect(summary.created).toBe(1);
    if (!summary.outcomes[0].ok) throw new Error('expected success');
    const applicationId = (summary.outcomes[0] as { applicationId: string }).applicationId;
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    expect(application.nextActionDue?.toISOString().slice(0, 10)).toBe('2026-07-03');
    expect(application.nextActionDueKind).toBe('date');
  });

  it('supports many applications in one batch', async () => {
    const decisions: JsonImportRowDecision[] = [
      { index: 0, action: 'create', data: baseApplication({ company: 'Co A', applicationUrl: 'https://a.example.com/apply' }) },
      { index: 1, action: 'create', data: baseApplication({ company: 'Co B', applicationUrl: 'https://b.example.com/apply' }) },
    ];
    const summary = await commitJsonImportBatch(prisma, decisions);
    expect(summary.created).toBe(2);
    expect(await prisma.application.count()).toBe(2);
  });
});

describe('commitJsonImportBatch — update', () => {
  const seedExisting = () => prisma.application.create({
    data: {
      applicationCode: 'EXIST-1', company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply',
      status: 'Not Applied', currentStage: 'Discovered', priority: 'P2',
    },
  });

  it('updates the matched application, preserves existing links, merges incoming links, and records an activity', async () => {
    const existing = await seedExisting();
    await prisma.applicationLink.create({ data: { applicationId: existing.id, label: 'Old link', url: 'https://old.example.com' } });

    const decisions: JsonImportRowDecision[] = [{
      index: 0,
      action: 'update',
      matchedApplicationId: existing.id,
      data: baseApplication({
        priority: 'P0',
        compensationSummary: '$200k',
        links: [{ label: 'New link', url: 'https://new.example.com', category: 'Application' }],
      }),
    }];

    const summary = await commitJsonImportBatch(prisma, decisions);
    expect(summary.updated).toBe(1);

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.priority).toBe('P0');
    expect(updated.compensationSummary).toBe('$200k');

    const links = await prisma.applicationLink.findMany({ where: { applicationId: existing.id } });
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.label).sort()).toEqual(['New link', 'Old link']);

    const activities = await prisma.activity.findMany({ where: { applicationId: existing.id } });
    expect(activities.map((a) => a.eventType)).toContain('JSON import updated');
  });

  it('preserves advanced workflow status and workflow-derived next action during a recommendation update', async () => {
    const existing = await seedExisting();
    await prisma.application.update({
      where: { id: existing.id },
      data: {
        status: 'OA',
        currentStage: 'Online Assessment',
        nextAction: 'Prepare for and complete OA',
        nextActionDue: new Date('2026-08-10T12:00:00.000Z'),
        nextActionDueKind: 'timestamp',
      },
    });

    const decisions: JsonImportRowDecision[] = [{
      index: 0,
      action: 'update',
      matchedApplicationId: existing.id,
      data: baseApplication({
        status: 'Not Applied',
        priority: 'P0',
        nextAction: 'Apply now',
        nextActionDue: '2026-07-31',
        nextActionDueKind: 'date',
        eligibility: 'Metadata enrichment',
      }),
    }];

    const summary = await commitJsonImportBatch(prisma, decisions);
    expect(summary.updated).toBe(1);

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.status).toBe('OA');
    expect(updated.currentStage).toBe('Online Assessment');
    expect(updated.nextAction).toBe('Prepare for and complete OA');
    expect(updated.nextActionDue?.toISOString()).toBe('2026-08-10T12:00:00.000Z');
    expect(updated.nextActionDueKind).toBe('timestamp');
    expect(updated.priority).toBe('P0');
    expect(updated.eligibility).toBe('Metadata enrichment');
  });

  it('fails when matchedApplicationId is missing', async () => {
    const decisions: JsonImportRowDecision[] = [{ index: 0, action: 'update', data: baseApplication() }];
    await expect(commitJsonImportBatch(prisma, decisions)).rejects.toThrow(/no matching existing application/);
  });

  it('fails when the matched application no longer exists', async () => {
    const decisions: JsonImportRowDecision[] = [{ index: 0, action: 'update', matchedApplicationId: 'does-not-exist', data: baseApplication() }];
    await expect(commitJsonImportBatch(prisma, decisions)).rejects.toThrow(/no longer exists/);
  });

  it('fails when the matched application no longer matches this row by company+role or URL (stale match)', async () => {
    const existing = await seedExisting();
    const decisions: JsonImportRowDecision[] = [{
      index: 0,
      action: 'update',
      matchedApplicationId: existing.id,
      data: baseApplication({ company: 'Totally Different Co', role: 'Totally Different Role', applicationUrl: 'https://different.example.com/apply' }),
    }];
    await expect(commitJsonImportBatch(prisma, decisions)).rejects.toThrow(/no longer matches/);
  });
});

describe('commitJsonImportBatch — skip', () => {
  it('never writes anything for a skip decision', async () => {
    const decisions: JsonImportRowDecision[] = [{ index: 0, action: 'skip', data: baseApplication() }];
    const summary = await commitJsonImportBatch(prisma, decisions);
    expect(summary.skipped).toBe(1);
    expect(summary.outcomes[0]).toEqual({ index: 0, ok: true, action: 'skip' });
    expect(await prisma.application.count()).toBe(0);
  });
});

describe('commitJsonImportBatch — transaction rollback', () => {
  it('rolls back the entire batch when a later create row fails re-validation', async () => {
    const decisions: JsonImportRowDecision[] = [
      { index: 0, action: 'create', data: baseApplication({ company: 'Rollback Co A', applicationUrl: 'https://rollback-a.example.com/apply' }) },
      { index: 1, action: 'create', data: baseApplication({ company: '', applicationUrl: 'https://rollback-b.example.com/apply' }) },
    ];
    await expect(commitJsonImportBatch(prisma, decisions)).rejects.toThrow();
    expect(await prisma.application.count()).toBe(0);
  });

  it('rolls back the entire batch when a create row is a duplicate re-created earlier in the same batch', async () => {
    const decisions: JsonImportRowDecision[] = [
      { index: 0, action: 'create', data: baseApplication({ company: 'Batch Dup Co', applicationUrl: 'https://batch-dup.example.com/apply' }) },
      { index: 1, action: 'create', data: baseApplication({ company: 'Batch Dup Co', applicationUrl: 'https://batch-dup.example.com/apply' }) },
    ];
    await expect(commitJsonImportBatch(prisma, decisions)).rejects.toThrow(/matching application now exists/);
    expect(await prisma.application.count()).toBe(0);
  });

  it('rolls back the entire batch when a stale update row no longer matches, including any earlier successful create in the same batch', async () => {
    const existing = await prisma.application.create({
      data: { applicationCode: 'STALE-1', company: 'Stale Co', role: 'Role', applicationUrl: 'https://stale.example.com/apply', status: 'Not Applied', currentStage: 'Discovered' },
    });
    const decisions: JsonImportRowDecision[] = [
      { index: 0, action: 'create', data: baseApplication({ company: 'Should Roll Back Co', applicationUrl: 'https://should-roll-back.example.com/apply' }) },
      { index: 1, action: 'update', matchedApplicationId: existing.id, data: baseApplication({ company: 'Mismatched Co', role: 'Mismatched Role', applicationUrl: 'https://mismatched.example.com/apply' }) },
    ];
    await expect(commitJsonImportBatch(prisma, decisions)).rejects.toThrow(/no longer matches/);

    // Neither the earlier create in this batch, nor any change to the
    // pre-existing application, survived the rollback.
    expect(await prisma.application.count()).toBe(1);
    const unchanged = await prisma.application.findUniqueOrThrow({ where: { id: existing.id } });
    expect(unchanged.company).toBe('Stale Co');
  });

  it('re-validates row data at commit time regardless of what preview said (defense against a tampered payload)', async () => {
    const decisions: JsonImportRowDecision[] = [{ index: 0, action: 'create', data: { company: 'Acme', role: 'SWE' } }];
    await expect(commitJsonImportBatch(prisma, decisions)).rejects.toThrow();
    expect(await prisma.application.count()).toBe(0);
  });
});
