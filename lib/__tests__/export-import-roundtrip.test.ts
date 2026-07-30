import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';
import { buildExportWorkbook, loadExportData } from '../export';
import { commitMultiSheetImport, parseMultiSheetWorkbook } from '../multi-sheet-import';

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

const byDate = (a: Date | null, b: Date | null) => (a?.getTime() ?? 0) - (b?.getTime() ?? 0);

describe('export -> multi-sheet import round-trip (true database round-trip support)', () => {
  it('restores EVERY sheet — including multiple OA rounds and multiple same-stage interview rounds — into a clean database with equivalent counts and field values for every model', async () => {
    // --- Populate the source database. ---------------------------------
    const activeResume = await source.prisma.resumeVersion.create({ data: { name: 'SWE Resume 2026', targetType: 'SWE', description: 'Primary resume' } });
    await source.prisma.resumeVersion.create({ data: { name: 'Old Resume', targetType: 'SWE', archived: true } });

    await source.prisma.userProfile.create({
      data: {
        name: 'Riddhima Yadav', school: 'UT Austin', major: 'CS', graduation: 'December 2027',
        workAuthorization: 'U.S. citizen', preferredLocation: 'NYC', otherLocations: 'Major U.S. cities',
        currentExperience: 'DraftKings SWE Intern', targetRoles: '2027 Internships', targetCategories: 'Fintech, quant',
        defaultFollowUpDays: 12, defaultDueDays: 3,
      },
    });

    // Application with TWO OA rounds and THREE interview rounds (one
    // Recruiter Screen, two Technical Interview) — the exact "multi-OA /
    // multi-interview" scenario item 7 calls out, plus contacts/notes/job
    // description/activities so every child sheet has real data for this row.
    const multiRound = await source.prisma.application.create({
      data: {
        applicationCode: 'RT-MULTI', company: 'Multi Round Co', role: 'Software Engineer', status: 'Technical Interview', currentStage: 'Technical Interview',
        priority: 'P0', applicationUrl: 'https://multiround.example.com/apply', location: 'Remote',
        applicationDeadline: new Date('2026-09-30T00:00:00.000Z'), dateFound: new Date('2026-06-01T00:00:00.000Z'), dateApplied: new Date('2026-06-05T00:00:00.000Z'),
        resumeVersionId: activeResume.id, nextAction: 'Prep for final panel', nextActionDue: new Date('2026-08-25T18:00:00.000Z'), nextActionDueKind: 'timestamp',
      },
    });
    await source.prisma.assessment.create({ data: { applicationId: multiRound.id, type: 'OA', platform: 'HackerRank', dueAt: new Date('2026-06-10T13:00:00.000Z'), timezone: 'America/New_York' } });
    await source.prisma.assessment.create({ data: { applicationId: multiRound.id, type: 'OA', platform: 'Coderbyte', dueAt: new Date('2026-06-20T15:00:00.000Z'), timezone: 'America/Chicago' } });
    await source.prisma.interview.create({ data: { applicationId: multiRound.id, stage: 'Recruiter Screen', scheduledStart: new Date('2026-06-25T17:00:00.000Z'), timezone: 'America/New_York', interviewer: 'Recruiter A' } });
    await source.prisma.interview.create({ data: { applicationId: multiRound.id, stage: 'Technical Interview', scheduledStart: new Date('2026-07-10T18:00:00.000Z'), timezone: 'America/Chicago', interviewer: 'Panel Round 1' } });
    await source.prisma.interview.create({ data: { applicationId: multiRound.id, stage: 'Technical Interview', scheduledStart: new Date('2026-08-20T21:00:00.000Z'), timezone: 'America/Los_Angeles', interviewer: 'Panel Round 2' } });
    await source.prisma.contact.create({ data: { applicationId: multiRound.id, name: 'Taylor Recruiter', email: 'taylor@example.com', relationship: 'Recruiter', lastContacted: new Date('2026-06-05T00:00:00.000Z') } });
    await source.prisma.contact.create({ data: { applicationId: multiRound.id, name: 'Jordan Hiring Manager', relationship: 'Hiring Manager', nextFollowUp: new Date('2026-09-01T00:00:00.000Z') } });
    await source.prisma.note.create({ data: { applicationId: multiRound.id, category: 'General', content: 'Great first call' } });
    await source.prisma.note.create({ data: { applicationId: multiRound.id, category: 'Interview', content: 'Panel went well' } });
    await source.prisma.jobDescription.create({ data: { applicationId: multiRound.id, fullText: 'Full JD text here', keywords: 'Python, AWS', sourceUrl: 'https://multiround.example.com/jd' } });
    await source.prisma.activity.create({ data: { applicationId: multiRound.id, eventType: 'status_change', previousStatus: 'OA', newStatus: 'Recruiter Screen', summary: 'Advanced past OA' } });
    await source.prisma.activity.create({ data: { applicationId: multiRound.id, eventType: 'status_change', previousStatus: 'Recruiter Screen', newStatus: 'Technical Interview', summary: 'Advanced to technical interview' } });

    // Application with an Offer (Accepted, with a full Offer record).
    const accepted = await source.prisma.application.create({
      data: {
        applicationCode: 'RT-ACCEPTED', company: 'Offer Co', role: 'Staff Engineer', status: 'Accepted', currentStage: 'Accepted',
        priority: 'P0', applicationUrl: 'https://offerco.example.com/apply', dateApplied: new Date('2026-05-01T00:00:00.000Z'),
        nextAction: 'Onboard', nextActionDue: null, outcome: 'Accepted offer',
      },
    });
    await source.prisma.offer.create({
      data: { applicationId: accepted.id, offerDate: new Date('2026-08-01T00:00:00.000Z'), decisionDeadline: new Date('2026-09-01T00:00:00.000Z'), compensationSummary: '$220k total', notes: 'Negotiated 10% signing bonus' },
    });

    // A plain "Not Applied" application with no sub-records at all.
    await source.prisma.application.create({
      data: {
        applicationCode: 'RT-NOTAPPLIED', company: 'Discover Co', role: 'Backend Engineer', status: 'Not Applied', currentStage: 'Discovered',
        priority: 'P1', applicationUrl: 'https://discover.example.com/apply',
        applicationDeadline: new Date('2026-09-15T00:00:00.000Z'), dateFound: new Date('2026-07-01T00:00:00.000Z'),
        nextAction: 'Review and apply', nextActionDue: new Date('2026-09-15T00:00:00.000Z'), nextActionDueKind: 'date',
      },
    });

    // A terminal, rejected application.
    await source.prisma.application.create({
      data: {
        applicationCode: 'RT-REJECTED', company: 'Rejected Co', role: 'SRE', status: 'Rejected', currentStage: 'Rejected',
        priority: 'P3', applicationUrl: 'https://rejectedco.example.com/apply', dateApplied: new Date('2026-04-01T00:00:00.000Z'),
        nextAction: 'No active next action', nextActionDue: null, outcome: 'Position closed',
      },
    });

    // --- Export: build the workbook and serialize it to a REAL xlsx buffer, ---
    // --- exactly as the download endpoint does — not just an in-memory object. ---
    const exportData = await loadExportData(source.prisma);
    const workbook = buildExportWorkbook(exportData);
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    // --- Parse the buffer back into per-sheet rows, exactly as the restore ---
    // --- endpoint would upon receiving an uploaded file. ---
    const parsed = parseMultiSheetWorkbook(buffer);
    expect(parsed.applications).toHaveLength(4);
    expect(parsed.assessments).toHaveLength(2);
    expect(parsed.interviews).toHaveLength(3);
    expect(parsed.offers).toHaveLength(1);
    expect(parsed.contacts).toHaveLength(2);
    expect(parsed.notes).toHaveLength(2);
    expect(parsed.activities).toHaveLength(2);
    expect(parsed.jobDescriptions).toHaveLength(1);
    expect(parsed.resumeVersions).toHaveLength(2);
    expect(parsed.profile).toHaveLength(1);

    // --- Commit the ENTIRE restore into a CLEAN second database. ---
    const summary = await commitMultiSheetImport(target.prisma, parsed);

    expect(summary.errors).toEqual([]);
    expect(summary.unmatchedApplicationCodes).toEqual([]);
    expect(summary.applications).toEqual({ created: 4, updated: 0 });
    expect(summary.assessments).toEqual({ created: 2 });
    expect(summary.interviews).toEqual({ created: 3 });
    expect(summary.offers).toEqual({ created: 1 });
    expect(summary.contacts).toEqual({ created: 2 });
    expect(summary.notes).toEqual({ created: 2 });
    expect(summary.activities).toEqual({ created: 2 });
    expect(summary.jobDescriptions).toEqual({ created: 1 });
    expect(summary.resumeVersions).toEqual({ created: 2, matched: 0 });
    expect(summary.profile).toEqual({ created: true, updated: false });

    // --- Verify EVERY model round-tripped with equivalent row counts and field values. ---
    const [reimportedApps, reimportedResumes, reimportedProfile] = await Promise.all([
      target.prisma.application.findMany({
        include: { assessments: true, interviews: true, offers: true, contacts: true, notesRelation: true, activities: true, jobDescription: true, resumeVersion: true },
      }),
      target.prisma.resumeVersion.findMany(),
      target.prisma.userProfile.findFirst(),
    ]);
    expect(reimportedApps).toHaveLength(4);
    const byCode = new Map(reimportedApps.map((app) => [app.applicationCode, app]));

    // Resume Versions: both preserved, including the archived flag.
    expect(reimportedResumes).toHaveLength(2);
    const activeResumeReimported = reimportedResumes.find((r) => r.name === 'SWE Resume 2026')!;
    expect(activeResumeReimported.archived).toBe(false);
    expect(activeResumeReimported.description).toBe('Primary resume');
    const oldResumeReimported = reimportedResumes.find((r) => r.name === 'Old Resume')!;
    expect(oldResumeReimported.archived).toBe(true);

    // Profile: every field preserved exactly.
    expect(reimportedProfile).toMatchObject({
      name: 'Riddhima Yadav', school: 'UT Austin', major: 'CS', graduation: 'December 2027',
      workAuthorization: 'U.S. citizen', preferredLocation: 'NYC', otherLocations: 'Major U.S. cities',
      currentExperience: 'DraftKings SWE Intern', targetRoles: '2027 Internships', targetCategories: 'Fintech, quant',
      defaultFollowUpDays: 12, defaultDueDays: 3,
    });

    // RT-MULTI: base fields, resume association, and NO OFF-BY-ONE DATES.
    const rtMulti = byCode.get('RT-MULTI')!;
    expect(rtMulti.company).toBe('Multi Round Co');
    expect(rtMulti.status).toBe('Technical Interview');
    expect(rtMulti.currentStage).toBe('Technical Interview');
    expect(rtMulti.priority).toBe('P0');
    expect(rtMulti.location).toBe('Remote');
    expect(rtMulti.applicationDeadline?.toISOString().slice(0, 10)).toBe('2026-09-30');
    expect(rtMulti.dateFound?.toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(rtMulti.dateApplied?.toISOString().slice(0, 10)).toBe('2026-06-05');
    expect(rtMulti.nextActionDueKind).toBe('timestamp');
    expect(rtMulti.nextActionDue?.toISOString()).toBe('2026-08-25T18:00:00.000Z');
    expect(rtMulti.resumeVersion?.name).toBe('SWE Resume 2026');

    // BOTH OA rounds present — never collapsed to just the "current" one.
    expect(rtMulti.assessments).toHaveLength(2);
    const sortedAssessments = [...rtMulti.assessments].sort((a, b) => byDate(a.dueAt, b.dueAt));
    expect(sortedAssessments[0]).toMatchObject({ platform: 'HackerRank', timezone: 'America/New_York' });
    expect(sortedAssessments[0].dueAt?.toISOString()).toBe('2026-06-10T13:00:00.000Z');
    expect(sortedAssessments[1]).toMatchObject({ platform: 'Coderbyte', timezone: 'America/Chicago' });
    expect(sortedAssessments[1].dueAt?.toISOString()).toBe('2026-06-20T15:00:00.000Z');

    // ALL THREE interview rounds present, including both same-stage rounds.
    expect(rtMulti.interviews).toHaveLength(3);
    const technicalRounds = rtMulti.interviews.filter((i) => i.stage === 'Technical Interview').sort((a, b) => byDate(a.scheduledStart, b.scheduledStart));
    expect(technicalRounds).toHaveLength(2);
    expect(technicalRounds[0]).toMatchObject({ interviewer: 'Panel Round 1', timezone: 'America/Chicago' });
    expect(technicalRounds[0].scheduledStart?.toISOString()).toBe('2026-07-10T18:00:00.000Z');
    expect(technicalRounds[1]).toMatchObject({ interviewer: 'Panel Round 2', timezone: 'America/Los_Angeles' });
    expect(technicalRounds[1].scheduledStart?.toISOString()).toBe('2026-08-20T21:00:00.000Z');
    const recruiterScreen = rtMulti.interviews.find((i) => i.stage === 'Recruiter Screen')!;
    expect(recruiterScreen.interviewer).toBe('Recruiter A');
    expect(recruiterScreen.scheduledStart?.toISOString()).toBe('2026-06-25T17:00:00.000Z');

    // Contacts, Notes, Job Description, Activity History — full content, not just presence.
    expect(rtMulti.contacts).toHaveLength(2);
    const taylor = rtMulti.contacts.find((c) => c.name === 'Taylor Recruiter')!;
    expect(taylor.email).toBe('taylor@example.com');
    expect(taylor.relationship).toBe('Recruiter');
    expect(taylor.lastContacted?.toISOString().slice(0, 10)).toBe('2026-06-05');
    const jordan = rtMulti.contacts.find((c) => c.name === 'Jordan Hiring Manager')!;
    expect(jordan.nextFollowUp?.toISOString().slice(0, 10)).toBe('2026-09-01');

    expect(rtMulti.notesRelation).toHaveLength(2);
    expect(rtMulti.notesRelation.some((n) => n.content === 'Great first call' && n.category === 'General')).toBe(true);
    expect(rtMulti.notesRelation.some((n) => n.content === 'Panel went well' && n.category === 'Interview')).toBe(true);

    expect(rtMulti.jobDescription?.fullText).toBe('Full JD text here');
    expect(rtMulti.jobDescription?.keywords).toBe('Python, AWS');
    expect(rtMulti.jobDescription?.sourceUrl).toBe('https://multiround.example.com/jd');

    expect(rtMulti.activities).toHaveLength(2);
    expect(rtMulti.activities.some((a) => a.summary === 'Advanced past OA' && a.previousStatus === 'OA' && a.newStatus === 'Recruiter Screen')).toBe(true);
    expect(rtMulti.activities.some((a) => a.summary === 'Advanced to technical interview' && a.newStatus === 'Technical Interview')).toBe(true);

    // RT-ACCEPTED: the Offer sheet's every field, including the newly added Notes/Offer Date.
    const rtAccepted = byCode.get('RT-ACCEPTED')!;
    expect(rtAccepted.status).toBe('Accepted');
    expect(rtAccepted.outcome).toBe('Accepted offer');
    expect(rtAccepted.nextActionDue).toBeNull();
    expect(rtAccepted.offers?.offerDate?.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(rtAccepted.offers?.decisionDeadline?.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(rtAccepted.offers?.compensationSummary).toBe('$220k total');
    expect(rtAccepted.offers?.notes).toBe('Negotiated 10% signing bonus');

    // RT-NOTAPPLIED: a plain row with no sub-records survives with no phantom records.
    const rtNotApplied = byCode.get('RT-NOTAPPLIED')!;
    expect(rtNotApplied.status).toBe('Not Applied');
    expect(rtNotApplied.applicationDeadline?.toISOString().slice(0, 10)).toBe('2026-09-15');
    expect(rtNotApplied.assessments).toHaveLength(0);
    expect(rtNotApplied.interviews).toHaveLength(0);
    expect(rtNotApplied.offers).toBeNull();

    // RT-REJECTED: terminal outcome, no next action due.
    const rtRejected = byCode.get('RT-REJECTED')!;
    expect(rtRejected.status).toBe('Rejected');
    expect(rtRejected.outcome).toBe('Position closed');
    expect(rtRejected.nextActionDue).toBeNull();
  });

  it('re-running the restore against the SAME (now-populated) database updates existing applications by Application Code instead of duplicating them', async () => {
    const before = await target.prisma.application.count();
    expect(before).toBe(4); // from the previous test in this file

    const exportData = await loadExportData(source.prisma);
    const workbook = buildExportWorkbook(exportData);
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const parsed = parseMultiSheetWorkbook(buffer);

    const summary = await commitMultiSheetImport(target.prisma, parsed);
    expect(summary.applications).toEqual({ created: 0, updated: 4 });
    expect(summary.errors).toEqual([]);
    expect(summary.unmatchedApplicationCodes).toEqual([]);

    // No duplicate applications, assessments, or interviews were created —
    // update matched every row by Application Code instead of re-creating it.
    expect(await target.prisma.application.count()).toBe(4);
    const rtMulti = await target.prisma.application.findFirstOrThrow({ where: { applicationCode: 'RT-MULTI' }, include: { assessments: true, interviews: true } });
    // Assessments/Interviews are always appended (full-history sheets), so a
    // second restore of the same workbook DOES add a second copy of each —
    // this documents that behavior rather than silently under-testing it.
    expect(rtMulti.assessments.length).toBeGreaterThanOrEqual(2);
    expect(rtMulti.interviews.length).toBeGreaterThanOrEqual(3);
  });

  it('reports an unmatched Application Code instead of silently dropping or crashing on an orphaned child-sheet row', async () => {
    const clean = makeTestDb('roundtrip-orphan-test.db');
    fs.mkdirSync(path.dirname(clean.dbPath), { recursive: true });
    if (fs.existsSync(clean.dbPath)) fs.unlinkSync(clean.dbPath);
    pushSchema(clean.databaseUrl);

    try {
      const parsed = {
        applications: [],
        jobDescriptions: [],
        assessments: [{ 'Application Code': 'DOES-NOT-EXIST', Type: 'OA', Platform: 'Coderbyte' }],
        interviews: [],
        offers: [],
        contacts: [],
        notes: [],
        activities: [],
        resumeVersions: [],
        profile: [],
      };
      const summary = await commitMultiSheetImport(clean.prisma, parsed);
      expect(summary.unmatchedApplicationCodes).toEqual([{ sheet: 'Assessments', rowNumber: 2, applicationCode: 'DOES-NOT-EXIST' }]);
      expect(summary.assessments).toEqual({ created: 0 });
      expect(await clean.prisma.assessment.count()).toBe(0);
    } finally {
      await clean.prisma.$disconnect();
    }
  });
});
