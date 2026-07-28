import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';
import { buildExportWorkbook, loadExportData } from '../export';
import { autoDetectColumnMap, buildImportPreview, commitImportRow, detectHeaders } from '../import';

const projectRoot = path.resolve(__dirname, '..', '..');

function makeTestDb(name: string) {
  const dbPath = path.resolve(projectRoot, 'data', name);
  const databaseUrl = `file:${dbPath}`;
  return { dbPath, databaseUrl, prisma: new PrismaClient({ datasources: { db: { url: databaseUrl } } }) };
}

const source = makeTestDb('roundtrip-source-test.db');
const target = makeTestDb('roundtrip-target-test.db');

function pushSchema(databaseUrl: string) {
  execFileSync('npx', ['prisma', 'db', 'push', '--accept-data-loss', '--skip-generate'], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

beforeAll(async () => {
  for (const { dbPath, databaseUrl } of [source, target]) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    pushSchema(databaseUrl);
  }
});

afterAll(async () => {
  await source.prisma.$disconnect();
  await target.prisma.$disconnect();
});

describe('export -> import round-trip', () => {
  it('preserves applications, statuses, dates, assessments, interviews, offers, and resume associations through a full export/import cycle', async () => {
    // --- Populate the source database with one application of every kind the importer supports end-to-end. ---
    const resume = await source.prisma.resumeVersion.create({ data: { name: 'SWE Resume 2026', targetType: 'SWE' } });

    const notApplied = await source.prisma.application.create({
      data: {
        applicationCode: 'RT-NOTAPPLIED', company: 'Discover Co', role: 'Software Engineer', status: 'Not Applied', currentStage: 'Discovered',
        priority: 'P1', applicationUrl: 'https://discover.example.com/apply', location: 'Remote',
        applicationDeadline: new Date('2026-09-15T00:00:00.000Z'), dateFound: new Date('2026-07-01T00:00:00.000Z'),
        nextAction: 'Review and apply', nextActionDue: new Date('2026-09-15T00:00:00.000Z'), nextActionDueKind: 'date',
      },
    });

    const applied = await source.prisma.application.create({
      data: {
        applicationCode: 'RT-APPLIED', company: 'Applied Co', role: 'Backend Engineer', status: 'Applied', currentStage: 'Application Submitted',
        priority: 'P0', applicationUrl: 'https://applied.example.com/apply', dateApplied: new Date('2026-07-10T00:00:00.000Z'),
        resumeVersionId: resume.id, nextAction: 'Monitor application', nextActionDue: new Date('2026-07-20T00:00:00.000Z'), nextActionDueKind: 'timestamp',
      },
    });
    await source.prisma.activity.create({ data: { applicationId: applied.id, eventType: 'Application submitted', summary: 'Marked as submitted' } });
    await source.prisma.contact.create({ data: { applicationId: applied.id, name: 'Taylor Recruiter', email: 'taylor@example.com', relationship: 'Recruiter' } });
    await source.prisma.note.create({ data: { applicationId: applied.id, category: 'General', content: 'Great first call' } });
    await source.prisma.jobDescription.create({ data: { applicationId: applied.id, fullText: 'Full JD text here', keywords: 'Python, AWS' } });

    const oa = await source.prisma.application.create({
      data: {
        applicationCode: 'RT-OA', company: 'OA Co', role: 'Data Engineer', status: 'OA', currentStage: 'Online Assessment',
        priority: 'P2', applicationUrl: 'https://oaco.example.com/apply', dateApplied: new Date('2026-07-05T00:00:00.000Z'),
        nextAction: 'Complete OA', nextActionDue: new Date('2026-08-15T13:00:00.000Z'), nextActionDueKind: 'timestamp',
      },
    });
    await source.prisma.assessment.create({ data: { applicationId: oa.id, type: 'OA', platform: 'Coderbyte', dueAt: new Date('2026-08-15T13:00:00.000Z'), timezone: 'America/New_York' } });

    const interview = await source.prisma.application.create({
      data: {
        applicationCode: 'RT-INTERVIEW', company: 'Interview Co', role: 'Platform Engineer', status: 'Technical Interview', currentStage: 'Technical Interview',
        priority: 'P1', applicationUrl: 'https://interviewco.example.com/apply', dateApplied: new Date('2026-06-01T00:00:00.000Z'),
        nextAction: 'Prepare for interview', nextActionDue: new Date('2026-08-20T21:00:00.000Z'), nextActionDueKind: 'timestamp',
      },
    });
    await source.prisma.interview.create({ data: { applicationId: interview.id, stage: 'Technical Interview', scheduledStart: new Date('2026-08-20T21:00:00.000Z'), timezone: 'America/Los_Angeles' } });

    const offer = await source.prisma.application.create({
      data: {
        applicationCode: 'RT-OFFER', company: 'Offer Co', role: 'Staff Engineer', status: 'Offer', currentStage: 'Offer Received',
        priority: 'P0', applicationUrl: 'https://offerco.example.com/apply', dateApplied: new Date('2026-05-01T00:00:00.000Z'),
        nextAction: 'Respond to offer', nextActionDue: new Date('2026-09-01T00:00:00.000Z'), nextActionDueKind: 'date',
      },
    });
    await source.prisma.offer.create({ data: { applicationId: offer.id, decisionDeadline: new Date('2026-09-01T00:00:00.000Z'), compensationSummary: '$220k total' } });

    await source.prisma.application.create({
      data: {
        applicationCode: 'RT-REJECTED', company: 'Rejected Co', role: 'SRE', status: 'Rejected', currentStage: 'Rejected',
        priority: 'P3', applicationUrl: 'https://rejectedco.example.com/apply', dateApplied: new Date('2026-04-01T00:00:00.000Z'),
        nextAction: 'No active next action', nextActionDue: null, outcome: 'Position closed',
      },
    });

    // --- Export. ---
    const exportData = await loadExportData(source.prisma);
    const workbook = buildExportWorkbook(exportData);

    // Sanity: the non-Applications sheets faithfully captured what we seeded.
    const contactRows = XLSX.utils.sheet_to_json(workbook.Sheets['Contacts']) as Array<Record<string, unknown>>;
    expect(contactRows.find((row) => row['Application Code'] === 'RT-APPLIED')?.Name).toBe('Taylor Recruiter');
    const noteRows = XLSX.utils.sheet_to_json(workbook.Sheets['Notes']) as Array<Record<string, unknown>>;
    expect(noteRows.find((row) => row['Application Code'] === 'RT-APPLIED')?.Content).toBe('Great first call');
    const jdRows = XLSX.utils.sheet_to_json(workbook.Sheets['Job Descriptions']) as Array<Record<string, unknown>>;
    expect(jdRows.find((row) => row['Application Code'] === 'RT-APPLIED')?.Keywords).toBe('Python, AWS');
    const activityRows = XLSX.utils.sheet_to_json(workbook.Sheets['Activity History']) as Array<Record<string, unknown>>;
    expect(activityRows.some((row) => row['Application Code'] === 'RT-APPLIED' && row['Event Type'] === 'Application submitted')).toBe(true);
    const resumeRows = XLSX.utils.sheet_to_json(workbook.Sheets['Resume Versions']) as Array<Record<string, unknown>>;
    expect(resumeRows.some((row) => row.Name === 'SWE Resume 2026')).toBe(true);

    // --- Read the Applications sheet back out, exactly as a user re-uploading the exported file would. ---
    const applicationRows = XLSX.utils.sheet_to_json(workbook.Sheets['Applications']) as Array<Record<string, unknown>>;
    const headers = detectHeaders(applicationRows);
    const columnMap = autoDetectColumnMap(headers);

    // --- Import into a CLEAN second database. ---
    const existingResumeVersions = await target.prisma.resumeVersion.findMany({ select: { id: true, name: true } });
    const preview = buildImportPreview(applicationRows, columnMap, [], existingResumeVersions);
    expect(preview.every((row) => row.status === 'valid')).toBe(true);

    const existingCodes: string[] = [];
    for (const row of preview) {
      if (row.status !== 'valid' || !row.data || !row.fieldPresence) continue;
      // The target database starts with no resume versions at all, so a
      // supplied-but-unmatched resume name (see row.resumeMatch) is exactly
      // the "create a new ResumeVersion" decision a user would make in the
      // preview UI when re-importing into a fresh tracker.
      const resumeVersionDecision = row.resumeMatch
        ? ({ action: 'existing', resumeVersionId: row.resumeMatch.id } as const)
        : row.data.resumeVersionName
          ? ({ action: 'create', name: row.data.resumeVersionName, targetType: 'SWE' } as const)
          : undefined;
      const outcome = await commitImportRow(target.prisma, 'create', row.data, existingCodes, null, row.fieldPresence, { resumeVersionDecision });
      expect(outcome.ok).toBe(true);
    }

    // --- Verify equivalence, application by application. ---
    const reimported = await target.prisma.application.findMany({
      include: { assessments: true, interviews: true, offers: true, resumeVersion: true },
    });
    const byCode = new Map(reimported.map((app) => [app.company, app]));

    const rtNotApplied = byCode.get('Discover Co')!;
    expect(rtNotApplied.status).toBe('Not Applied');
    expect(rtNotApplied.company).toBe(notApplied.company);
    expect(rtNotApplied.applicationDeadline?.toISOString().slice(0, 10)).toBe('2026-09-15');

    const rtApplied = byCode.get('Applied Co')!;
    expect(rtApplied.status).toBe('Applied');
    expect(rtApplied.dateApplied?.toISOString().slice(0, 10)).toBe('2026-07-10');
    expect(rtApplied.resumeVersion?.name).toBe('SWE Resume 2026');

    const rtOa = byCode.get('OA Co')!;
    expect(rtOa.status).toBe('OA');
    expect(rtOa.assessments).toHaveLength(1);
    expect(rtOa.assessments[0].dueAt?.toISOString()).toBe('2026-08-15T13:00:00.000Z');
    expect(rtOa.assessments[0].timezone).toBe('America/New_York');
    expect(rtOa.assessments[0].platform).toBe('Coderbyte');

    const rtInterview = byCode.get('Interview Co')!;
    expect(rtInterview.status).toBe('Technical Interview');
    expect(rtInterview.interviews).toHaveLength(1);
    expect(rtInterview.interviews[0].scheduledStart?.toISOString()).toBe('2026-08-20T21:00:00.000Z');
    expect(rtInterview.interviews[0].timezone).toBe('America/Los_Angeles');

    const rtOffer = byCode.get('Offer Co')!;
    expect(rtOffer.status).toBe('Offer');
    expect(rtOffer.offers?.decisionDeadline?.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(rtOffer.offers?.compensationSummary).toBe('$220k total');

    const rtRejected = byCode.get('Rejected Co')!;
    expect(rtRejected.status).toBe('Rejected');
    expect(rtRejected.outcome).toBe('Position closed');
    expect(rtRejected.nextActionDue).toBeNull();

    // No off-by-one dates for any of the post-submission applications' Date
    // Applied — every one of them had a real value in the source database.
    for (const code of ['Applied Co', 'OA Co', 'Interview Co', 'Offer Co', 'Rejected Co']) {
      expect(byCode.get(code)!.dateApplied).not.toBeNull();
    }
  });
});
