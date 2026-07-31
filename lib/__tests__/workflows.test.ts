import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { subDays } from 'date-fns';
import { parseZonedDateTime } from '../dates';
import { pushPrismaSchema, resetSqliteTestDatabaseFile } from '../../tests/helpers/test-database';
import {
  applyWorkflow,
  contactWorkflow,
  createApplicationRecord,
  createLinkWorkflow,
  deleteLinkWorkflow,
  deleteNoteWorkflow,
  editApplicationWorkflow,
  interviewCompletedWorkflow,
  interviewReceivedWorkflow,
  oaCompletedWorkflow,
  oaReceivedWorkflow,
  offerWorkflow,
  rejectWorkflow,
  setApplicationDateWorkflow,
  updateLinkWorkflow,
  updateNoteWorkflow,
} from '../workflows/applications';

const projectRoot = path.resolve(__dirname, '..', '..');
const dbPath = path.resolve(projectRoot, 'data', 'workflow-test.db');
const databaseUrl = 'file:../data/workflow-test.db';

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

const createAppliedApplication = async (overrides: { company?: string; role?: string; applicationUrl?: string } = {}) => {
  const resume = await prisma.resumeVersion.create({ data: { name: `Resume ${Math.random()}`, targetType: 'SWE' } });
  const application = await createApplicationRecord(prisma, {
    company: overrides.company ?? 'Acme',
    role: overrides.role ?? 'Software Engineer',
    applicationUrl: overrides.applicationUrl ?? 'https://acme.com/apply',
    priority: 'P1',
  });
  await applyWorkflow(prisma, application.id, { action: 'apply', resumeVersionId: resume.id });
  return application;
};

describe('workflow services', () => {
  it('marks applied with a valid resume', async () => {
    const resume = await prisma.resumeVersion.create({ data: { name: '2026 Resume', targetType: 'SWE', fileName: 'resume.pdf' } });
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

    await applyWorkflow(prisma, application.id, { action: 'apply', resumeVersionId: resume.id, dateApplied: '2026-07-26', emailUsed: 'candidate@example.com' });

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(updated.status).toBe('Applied');
    expect(updated.currentStage).toBe('Application Submitted');
    expect(updated.resumeVersionId).toBe(resume.id);
  });

  it('marks applied with NO resume version at all — resume tracking is no longer part of this workflow', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

    const updated = await applyWorkflow(prisma, application.id, { action: 'apply' });
    expect(updated.status).toBe('Applied');
    expect(updated.resumeVersionId).toBeNull();
  });

  it('silently ignores a resumeVersionId that does not resolve to a real resume, rather than rejecting Mark Applied', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

    const updated = await applyWorkflow(prisma, application.id, { action: 'apply', resumeVersionId: 'missing-resume' });
    expect(updated.status).toBe('Applied');
    expect(updated.resumeVersionId).toBeNull();
  });

  it('persists oa received details', async () => {
    const application = await createAppliedApplication();

    await oaReceivedWorkflow(prisma, application.id, {
      action: 'oaReceived',
      receivedAt: '2026-07-26T09:00:00',
      dueAt: '2026-07-28T09:00:00',
      timezone: 'America/New_York',
      platform: 'Coderbyte',
      durationMinutes: 90,
      questionCount: 4,
      topics: 'Arrays, DP',
      notes: 'Please complete before Friday',
    });

    const assessment = await prisma.assessment.findFirst({ where: { applicationId: application.id } });
    expect(assessment?.type).toBe('OA');
    expect(assessment?.platform).toBe('Coderbyte');
    expect(assessment?.durationMinutes).toBe(90);
    expect(assessment?.questionCount).toBe(4);
    expect(assessment?.topics).toBe('Arrays, DP');
    expect(assessment?.notes).toContain('Please complete before Friday');
  });

  it('persists oa completed details', async () => {
    const application = await createAppliedApplication();

    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', timezone: 'America/New_York', receivedAt: '2026-07-26T09:00:00', dueAt: '2026-07-28T09:00:00' });
    const received = await prisma.assessment.findFirstOrThrow({ where: { applicationId: application.id } });
    await oaCompletedWorkflow(prisma, application.id, {
      action: 'oaCompleted',
      assessmentId: received.id,
      completedAt: '2026-07-27T09:00:00',
      difficulty: 'Hard',
      confidence: 'Medium',
      result: 'Passed',
      encounteredQuestions: 'Two algorithms',
      topics: 'Graphs',
      notes: 'Need follow-up',
    });

    const assessment = await prisma.assessment.findFirst({ where: { applicationId: application.id } });
    expect(assessment?.completedAt).toBeTruthy();
    expect(assessment?.difficulty).toBe('Hard');
    expect(assessment?.confidence).toBe('Medium');
    expect(assessment?.result).toBe('Passed');
    expect(assessment?.notes).toContain('Need follow-up');
  });

  it('maps recruiter screen and technical interview stages', async () => {
    const recruiter = await createAppliedApplication();
    await interviewReceivedWorkflow(prisma, recruiter.id, {
      action: 'interviewReceived',
      stage: 'Recruiter Screen',
      scheduledStart: '2026-07-26T14:00:00',
      timezone: 'America/New_York',
      format: 'Video',
      location: 'Zoom',
      recruiter: 'Mina',
      interviewer: 'Sam',
      notes: 'Intro call',
    });

    const recruiterUpdated = await prisma.application.findUniqueOrThrow({ where: { id: recruiter.id } });
    expect(recruiterUpdated.status).toBe('Recruiter Screen');
    expect(recruiterUpdated.currentStage).toBe('Recruiter Screen');

    const technical = await createAppliedApplication({ company: 'Beta', role: 'ML Engineer', applicationUrl: 'https://beta.com/apply' });
    await interviewReceivedWorkflow(prisma, technical.id, {
      action: 'interviewReceived',
      stage: 'Technical Interview',
      scheduledStart: '2026-07-27T16:00:00',
      timezone: 'America/Los_Angeles',
      format: 'Onsite',
      location: 'Office',
      recruiter: 'Nina',
      interviewer: 'Alex',
      notes: 'Coding round',
    });

    const technicalUpdated = await prisma.application.findUniqueOrThrow({ where: { id: technical.id } });
    expect(technicalUpdated.status).toBe('Technical Interview');
    expect(technicalUpdated.currentStage).toBe('Technical Interview');
  });

  it('uses the scheduled interview time for the next-action deadline', async () => {
    const application = await createAppliedApplication();
    // scheduledStart is a naive wall-clock string ("2026-07-26T14:00:00",
    // exactly what an <input type="datetime-local"> sends) to be interpreted
    // in the given timezone — NOT a pre-resolved ISO instant. Feeding it an
    // already-UTC value (e.g. `someDate.toISOString()`) would double-convert
    // it, since parseZonedDateTime treats the digits as wall-clock time in
    // the target zone regardless of any "Z"/offset already present.
    const timezone = 'America/New_York';
    const scheduledStartLocal = '2099-07-26T14:00:00';
    const expectedUtcStart = parseZonedDateTime(scheduledStartLocal, timezone)!;

    await interviewReceivedWorkflow(prisma, application.id, {
      action: 'interviewReceived',
      stage: 'Recruiter Screen',
      scheduledStart: scheduledStartLocal,
      timezone,
      format: 'Video',
      location: 'Zoom',
      recruiter: 'Mina',
      interviewer: 'Sam',
      notes: 'Intro call',
    });

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(updated.nextActionDue?.getTime()).toBe(subDays(expectedUtcStart, 1).getTime());
  });

  it('persists oa completed details without dropping encountered questions', async () => {
    const application = await createAppliedApplication();

    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', timezone: 'America/New_York', receivedAt: '2026-07-26T09:00:00', dueAt: '2026-07-28T09:00:00' });
    const received = await prisma.assessment.findFirstOrThrow({ where: { applicationId: application.id } });
    await oaCompletedWorkflow(prisma, application.id, {
      action: 'oaCompleted',
      assessmentId: received.id,
      completedAt: '2026-07-27T09:00:00',
      difficulty: 'Hard',
      confidence: 'Medium',
      result: 'Passed',
      encounteredQuestions: 'Two algorithms',
      topics: 'Graphs',
      notes: 'Need follow-up',
    });

    const assessment = await prisma.assessment.findFirst({ where: { applicationId: application.id } });
    expect(assessment?.encounteredQuestions).toBe('Two algorithms');
    expect(assessment?.topics).toBe('Graphs');
    expect(assessment?.notes).toContain('Need follow-up');
  });

  it('completes one interview without updating every matching stage', async () => {
    const application = await createAppliedApplication();
    await prisma.application.update({ where: { id: application.id }, data: { status: 'Recruiter Screen' } });
    const firstInterview = await prisma.interview.create({ data: { applicationId: application.id, stage: 'Recruiter Screen', scheduledStart: new Date('2026-07-26T14:00:00') } });
    const secondInterview = await prisma.interview.create({ data: { applicationId: application.id, stage: 'Recruiter Screen', scheduledStart: new Date('2026-07-27T14:00:00') } });

    await interviewCompletedWorkflow(prisma, application.id, {
      action: 'interviewCompleted',
      interviewId: firstInterview.id,
      completedAt: '2026-07-26T15:00:00',
      result: 'Passed',
      questions: 'Two behavioral questions',
      whatWentWell: 'Calm and structured',
      improvements: 'Share more examples',
      notes: 'Great conversation',
      followUpDate: '2026-07-29',
    });

    const updatedFirst = await prisma.interview.findUniqueOrThrow({ where: { id: firstInterview.id } });
    const updatedSecond = await prisma.interview.findUniqueOrThrow({ where: { id: secondInterview.id } });
    expect(updatedFirst.completedAt).toBeTruthy();
    expect(updatedFirst.result).toBe('Passed');
    expect(updatedSecond.completedAt).toBeNull();
  });

  it('stores a generated interview-completion follow-up as a date deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T12:00:00.000Z'));
    try {
      const application = await createAppliedApplication();
      await prisma.application.update({ where: { id: application.id }, data: { status: 'Recruiter Screen' } });
      const interview = await prisma.interview.create({ data: { applicationId: application.id, stage: 'Recruiter Screen', scheduledStart: new Date('2026-07-31T14:00:00.000Z') } });

      const updated = await interviewCompletedWorkflow(prisma, application.id, {
        action: 'interviewCompleted',
        interviewId: interview.id,
        completedAt: '2026-07-31T15:00:00',
      });

      expect(updated.nextActionDue?.toISOString().slice(0, 10)).toBe('2026-08-03');
      expect(updated.nextActionDueKind).toBe('date');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects completing an interview that is already completed', async () => {
    const application = await createAppliedApplication();
    await prisma.application.update({ where: { id: application.id }, data: { status: 'Recruiter Screen' } });
    const interview = await prisma.interview.create({ data: { applicationId: application.id, stage: 'Recruiter Screen', scheduledStart: new Date('2026-07-26T14:00:00') } });

    await interviewCompletedWorkflow(prisma, application.id, {
      action: 'interviewCompleted',
      interviewId: interview.id,
      completedAt: '2026-07-26T15:00:00',
      result: 'Passed',
    });

    await expect(
      interviewCompletedWorkflow(prisma, application.id, {
        action: 'interviewCompleted',
        interviewId: interview.id,
        completedAt: '2026-07-27T15:00:00',
        result: 'Passed again',
      }),
    ).rejects.toThrow('Interview already completed');
  });

  it('rejects completing an OA assessment that is already completed', async () => {
    const application = await createAppliedApplication();

    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', timezone: 'America/New_York', dueAt: '2026-07-28T09:00:00' });
    const assessment = await prisma.assessment.findFirstOrThrow({ where: { applicationId: application.id } });

    await oaCompletedWorkflow(prisma, application.id, {
      action: 'oaCompleted',
      assessmentId: assessment.id,
      result: 'Passed',
    });

    await expect(
      oaCompletedWorkflow(prisma, application.id, {
        action: 'oaCompleted',
        assessmentId: assessment.id,
        result: 'Passed again',
      }),
    ).rejects.toThrow('Assessment already completed');
  });

  it('persists offer details', async () => {
    const application = await createAppliedApplication();

    await offerWorkflow(prisma, application.id, {
      action: 'offer',
      offerDate: '2026-07-30',
      decisionDeadline: '2026-08-03',
      compensationSummary: '$180k base, $20k bonus',
      notes: 'Great fit',
    });

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(updated.status).toBe('Offer');
    expect(updated.currentStage).toBe('Offer Received');
    expect(updated.compensationSummary).toContain('$180k base');
    expect(updated.notes).toContain('Great fit');
  });

  it('persists rejection details', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

    await rejectWorkflow(prisma, application.id, { action: 'reject', rejectionReason: 'No longer hiring', notes: 'Follow up later' });

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(updated.status).toBe('Rejected');
    expect(updated.currentStage).toBe('Rejected');
    expect(updated.outcome).toContain('No longer hiring');
    expect(updated.notes).toContain('Follow up later');
  });

  it('does not mutate application state when the workflow fails', async () => {
    const application = await createAppliedApplication();

    await expect(
      interviewReceivedWorkflow(prisma, application.id, { action: 'interviewReceived', stage: 'Recruiter Screen' } as Parameters<typeof interviewReceivedWorkflow>[2]),
    ).rejects.toThrow('scheduledStart is required');

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(updated.status).toBe('Applied');
    expect(updated.currentStage).toBe('Application Submitted');
  });

  it('persists all contact fields', async () => {
    const application = await createAppliedApplication();

    await contactWorkflow(prisma, application.id, {
      action: 'contact',
      name: 'Jordan Recruiter',
      title: 'Technical Recruiter',
      email: 'jordan@acme.com',
      relationship: 'Recruiter',
      referralStatus: 'Referred by alum',
      notes: 'Met at career fair',
      nextFollowUp: '2026-08-20',
    });

    const contact = await prisma.contact.findFirstOrThrow({ where: { applicationId: application.id } });
    expect(contact.name).toBe('Jordan Recruiter');
    expect(contact.title).toBe('Technical Recruiter');
    expect(contact.email).toBe('jordan@acme.com');
    expect(contact.relationship).toBe('Recruiter');
    expect(contact.referralStatus).toBe('Referred by alum');
    expect(contact.notes).toBe('Met at career fair');
    expect(contact.nextFollowUp?.toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });

  it('rejects reusing OA/interview actions on a rejected application without an override', async () => {
    const application = await createAppliedApplication();
    await rejectWorkflow(prisma, application.id, { action: 'reject', rejectionReason: 'Position closed' });

    await expect(
      oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', timezone: 'America/New_York', dueAt: '2026-07-28T09:00:00' }),
    ).rejects.toThrow(/override/);
    await expect(
      interviewReceivedWorkflow(prisma, application.id, { action: 'interviewReceived', stage: 'Recruiter Screen', scheduledStart: '2026-07-28T09:00:00', timezone: 'America/New_York' }),
    ).rejects.toThrow(/override/);

    const stillRejected = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(stillRejected.status).toBe('Rejected');
  });

  it('allows reusing OA/interview actions on a rejected application with an explicit override', async () => {
    const application = await createAppliedApplication();
    await rejectWorkflow(prisma, application.id, { action: 'reject', rejectionReason: 'Reconsidered' });

    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', timezone: 'America/New_York', dueAt: '2026-07-28T09:00:00', override: true });

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(updated.status).toBe('OA');
  });

  it('rejects override:true for an invalid transition from a non-terminal status (Not Applied -> Offer)', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

    await expect(
      offerWorkflow(prisma, application.id, { action: 'offer', decisionDeadline: '2026-08-01', override: true }),
    ).rejects.toThrow(/not a valid transition/);

    const stillNotApplied = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(stillNotApplied.status).toBe('Not Applied');
  });

  it('permits OA Received after a recruiter screen', async () => {
    const application = await createAppliedApplication();
    await interviewReceivedWorkflow(prisma, application.id, {
      action: 'interviewReceived',
      stage: 'Recruiter Screen',
      scheduledStart: '2026-07-26T14:00:00',
      timezone: 'America/New_York',
    });

    let updated = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(updated.status).toBe('Recruiter Screen');

    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', timezone: 'America/New_York', dueAt: '2026-07-28T09:00:00' });

    updated = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(updated.status).toBe('OA');
    const interviews = await prisma.interview.findMany({ where: { applicationId: application.id } });
    const assessments = await prisma.assessment.findMany({ where: { applicationId: application.id } });
    expect(interviews).toHaveLength(1);
    expect(assessments).toHaveLength(1);
  });

  it('supports multiple OAs and multiple interview rounds for the same application', async () => {
    const application = await createAppliedApplication();

    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', timezone: 'America/New_York', dueAt: '2026-07-20T09:00:00' });
    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', timezone: 'America/New_York', dueAt: '2026-07-27T09:00:00', platform: 'Second round' });

    await interviewReceivedWorkflow(prisma, application.id, {
      action: 'interviewReceived',
      stage: 'Recruiter Screen',
      scheduledStart: '2026-08-01T14:00:00',
      timezone: 'America/New_York',
    });
    await interviewReceivedWorkflow(prisma, application.id, {
      action: 'interviewReceived',
      stage: 'Technical Interview',
      scheduledStart: '2026-08-05T14:00:00',
      timezone: 'America/New_York',
    });

    const assessments = await prisma.assessment.findMany({ where: { applicationId: application.id } });
    const interviews = await prisma.interview.findMany({ where: { applicationId: application.id } });
    expect(assessments).toHaveLength(2);
    expect(interviews).toHaveLength(2);
    expect(interviews.map((i) => i.stage)).toEqual(['Recruiter Screen', 'Technical Interview']);
  });

  it('interprets an interview scheduled in Pacific time correctly, even though this test process runs in Eastern time', async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const application = await createAppliedApplication();
      await interviewReceivedWorkflow(prisma, application.id, {
        action: 'interviewReceived',
        stage: 'Recruiter Screen',
        scheduledStart: '2026-08-15T14:00', // 2:00 PM, meant as Pacific time
        timezone: 'America/Los_Angeles',
      });

      const interview = await prisma.interview.findFirstOrThrow({ where: { applicationId: application.id } });
      // 2:00 PM PDT (UTC-7) -> 21:00 UTC, NOT 18:00 UTC (which is what naively
      // parsing "14:00" as the server's own Eastern time would produce).
      expect(interview.scheduledStart?.toISOString()).toBe('2026-08-15T21:00:00.000Z');
      expect(interview.timezone).toBe('America/Los_Angeles');
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('creates an application with a status beyond Not Applied/Preparing and a derived, consistent stage — the standard endpoint restricts this further, but createApplicationRecord itself supports it for the import pathway', async () => {
    const application = await createApplicationRecord(prisma, {
      company: 'Imported Co',
      role: 'Software Engineer',
      applicationUrl: 'https://imported.example.com/apply',
      priority: 'P1',
      status: 'Applied',
      applicationDeadline: '2026-08-15',
    });

    expect(application.status).toBe('Applied');
    expect(application.currentStage).toBe('Application Submitted');
    expect(application.dateApplied).toBeNull();
    expect(application.applicationDeadline?.toISOString().slice(0, 10)).toBe('2026-08-15');
    expect(application.nextActionDueKind).toBe('date');
  });

  it('repairs a missing application date and records the repair in activity history', async () => {
    const application = await createApplicationRecord(prisma, {
      company: 'Imported Co',
      role: 'Software Engineer',
      applicationUrl: 'https://imported.example.com/apply',
      priority: 'P1',
      status: 'Applied',
    });
    expect(application.dateApplied).toBeNull();

    const updated = await setApplicationDateWorkflow(prisma, application.id, { action: 'setApplicationDate', dateApplied: '2026-07-20' });
    expect(updated.dateApplied?.toISOString().slice(0, 10)).toBe('2026-07-20');

    const activity = await prisma.activity.findFirstOrThrow({ where: { applicationId: application.id, eventType: 'Application date repaired' } });
    expect(activity.summary).toContain('2026-07-20');
  });

  it('rejects repairing an application date that is already set', async () => {
    const application = await createAppliedApplication();
    await expect(
      setApplicationDateWorkflow(prisma, application.id, { action: 'setApplicationDate', dateApplied: '2026-07-20' }),
    ).rejects.toThrow('already has a date applied');
  });

  it('rejects setting an application date on an ordinary Not Applied record with no submission evidence', async () => {
    const application = await createApplicationRecord(prisma, {
      company: 'Fresh Co',
      role: 'Software Engineer',
      applicationUrl: 'https://fresh.example.com/apply',
      priority: 'P1',
    });
    expect(application.status).toBe('Not Applied');

    await expect(
      setApplicationDateWorkflow(prisma, application.id, { action: 'setApplicationDate', dateApplied: '2026-07-20' }),
    ).rejects.toThrow('requires submission evidence');
  });

  it('rejects setting an application date on a Preparing record with no submission evidence', async () => {
    const application = await createApplicationRecord(prisma, {
      company: 'Prep Co',
      role: 'Software Engineer',
      applicationUrl: 'https://prep.example.com/apply',
      priority: 'P1',
      status: 'Preparing',
    });

    await expect(
      setApplicationDateWorkflow(prisma, application.id, { action: 'setApplicationDate', dateApplied: '2026-07-20' }),
    ).rejects.toThrow('requires submission evidence');
  });

  it('permits setting an application date on a Not Applied record when an "Application submitted" activity exists', async () => {
    const application = await createApplicationRecord(prisma, {
      company: 'Activity Evidence Co',
      role: 'Software Engineer',
      applicationUrl: 'https://activity-evidence.example.com/apply',
      priority: 'P1',
    });
    await prisma.activity.create({
      data: { applicationId: application.id, eventType: 'Application submitted', summary: 'Imported as already submitted' },
    });

    const updated = await setApplicationDateWorkflow(prisma, application.id, { action: 'setApplicationDate', dateApplied: '2026-07-20' });
    expect(updated.dateApplied?.toISOString().slice(0, 10)).toBe('2026-07-20');
  });

  it('permits setting an application date on a Not Applied record only with the explicit confirmImportRepair flag', async () => {
    const application = await createApplicationRecord(prisma, {
      company: 'Explicit Flag Co',
      role: 'Software Engineer',
      applicationUrl: 'https://explicit-flag.example.com/apply',
      priority: 'P1',
    });

    const updated = await setApplicationDateWorkflow(prisma, application.id, {
      action: 'setApplicationDate',
      dateApplied: '2026-07-20',
      confirmImportRepair: true,
    });
    expect(updated.dateApplied?.toISOString().slice(0, 10)).toBe('2026-07-20');
  });

  it.each([
    { timezone: 'America/New_York', expectedUtc: '2026-08-15T13:00:00.000Z' }, // 9:00 AM EDT (UTC-4)
    { timezone: 'America/Los_Angeles', expectedUtc: '2026-08-15T16:00:00.000Z' }, // 9:00 AM PDT (UTC-7)
    { timezone: 'UTC', expectedUtc: '2026-08-15T09:00:00.000Z' },
  ])('stores an OA due date entered in $timezone as the correct UTC instant', async ({ timezone, expectedUtc }) => {
    const application = await createAppliedApplication();

    await oaReceivedWorkflow(prisma, application.id, {
      action: 'oaReceived',
      dueAt: '2026-08-15T09:00:00',
      timezone,
    });

    const assessment = await prisma.assessment.findFirstOrThrow({ where: { applicationId: application.id } });
    expect(assessment.dueAt?.toISOString()).toBe(expectedUtc);
    expect(assessment.timezone).toBe(timezone);

    // The application's own personal completion target defaults to 24
    // hours BEFORE the OA's due instant (a buffer, not the deadline itself).
    const updated = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    const expectedNextActionDue = new Date(new Date(expectedUtc).getTime() - 24 * 60 * 60 * 1000).toISOString();
    expect(updated.nextActionDue?.toISOString()).toBe(expectedNextActionDue);
  });

  it('clamps a short-notice OA personal deadline to now', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T18:00:00.000Z'));
    try {
      const application = await createAppliedApplication();

      const updated = await oaReceivedWorkflow(prisma, application.id, {
        action: 'oaReceived',
        dueAt: '2026-08-15T09:00:00',
        timezone: 'America/New_York',
      });

      expect(updated.nextActionDue?.toISOString()).toBe('2026-08-14T18:00:00.000Z');
      expect(updated.nextActionDueKind).toBe('timestamp');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps a short-notice interview preparation deadline to now', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T18:00:00.000Z'));
    try {
      const application = await createAppliedApplication();

      const updated = await interviewReceivedWorkflow(prisma, application.id, {
        action: 'interviewReceived',
        stage: 'Technical Interview',
        scheduledStart: '2026-08-15T09:00:00',
        timezone: 'America/New_York',
      });

      expect(updated.nextActionDue?.toISOString()).toBe('2026-08-14T18:00:00.000Z');
      expect(updated.nextActionDueKind).toBe('timestamp');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps a short-notice offer response deadline to today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T18:00:00.000Z'));
    try {
      const application = await createAppliedApplication();

      const updated = await offerWorkflow(prisma, application.id, {
        action: 'offer',
        decisionDeadline: '2026-08-15',
      });

      expect(updated.nextActionDue?.toISOString().slice(0, 10)).toBe('2026-08-14');
      expect(updated.nextActionDueKind).toBe('date');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('editApplicationWorkflow', () => {
  it('updates only the supplied fields and records an Activity summarizing what changed', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1', location: 'NYC' });

    const updated = await editApplicationWorkflow(prisma, application.id, {
      action: 'editApplication',
      company: 'Acme Corp',
      compensationSummary: '$180k base',
    });

    expect(updated.company).toBe('Acme Corp');
    expect(updated.compensationSummary).toBe('$180k base');
    expect(updated.location).toBe('NYC'); // untouched — field not in payload

    const activity = await prisma.activity.findFirstOrThrow({ where: { applicationId: application.id, eventType: 'Application edited' } });
    expect(activity.summary).toContain('Company');
    expect(activity.summary).toContain('Compensation summary');
  });

  it('a no-op edit (nothing actually changed) writes nothing and creates no "Application edited" Activity', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

    const result = await editApplicationWorkflow(prisma, application.id, { action: 'editApplication', company: 'Acme' });
    expect(result.company).toBe('Acme');

    const editActivities = await prisma.activity.findMany({ where: { applicationId: application.id, eventType: 'Application edited' } });
    expect(editActivities).toHaveLength(0);
  });

  it('an explicit null clears a nullable field, while omitting it entirely leaves it alone', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1', location: 'NYC' });
    await prisma.application.update({ where: { id: application.id }, data: { jobId: 'REQ-1' } });

    const updated = await editApplicationWorkflow(prisma, application.id, { action: 'editApplication', location: null });
    expect(updated.location).toBeNull();
    expect(updated.jobId).toBe('REQ-1'); // omitted -> left alone
  });

  it('never touches status/currentStage even if present in a raw payload object (Zod strips unknown keys)', async () => {
    const application = await createAppliedApplication();
    const payload = { action: 'editApplication', company: 'Acme Renamed', status: 'Offer', currentStage: 'Offer Received' } as unknown as Parameters<typeof editApplicationWorkflow>[2];

    const updated = await editApplicationWorkflow(prisma, application.id, payload);
    expect(updated.company).toBe('Acme Renamed');
    expect(updated.status).toBe('Applied');
    expect(updated.currentStage).toBe('Application Submitted');
  });

  it('rejects a nextActionDue that does not match its declared kind', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

    await expect(
      editApplicationWorkflow(prisma, application.id, { action: 'editApplication', nextActionDue: 'not-a-date', nextActionDueKind: 'date' }),
    ).rejects.toThrow(/does not match its declared kind/);
  });

  it('persists a valid nextActionDue/nextActionDueKind pair', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

    const updated = await editApplicationWorkflow(prisma, application.id, { action: 'editApplication', nextActionDue: '2026-09-01', nextActionDueKind: 'date' });
    expect(updated.nextActionDue?.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(updated.nextActionDueKind).toBe('date');
  });

  it('throws when the application does not exist', async () => {
    await expect(
      editApplicationWorkflow(prisma, 'does-not-exist', { action: 'editApplication', company: 'Whoever' }),
    ).rejects.toThrow('Application not found');
  });
});

describe('note CRUD workflows', () => {
  const createNote = (applicationId: string, content = 'Original note') =>
    prisma.note.create({ data: { applicationId, category: 'General', content } });

  it('updates a note\'s content/category and records an Activity', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });
    const note = await createNote(application.id);

    const updated = await updateNoteWorkflow(prisma, note.id, { category: 'Interview', content: 'Updated note content' });
    expect(updated.content).toBe('Updated note content');
    expect(updated.category).toBe('Interview');

    const activity = await prisma.activity.findFirstOrThrow({ where: { applicationId: application.id, eventType: 'Note edited' } });
    expect(activity).toBeTruthy();
  });

  it('deletes a note and records an Activity', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });
    const note = await createNote(application.id);

    await deleteNoteWorkflow(prisma, note.id);
    const stillThere = await prisma.note.findUnique({ where: { id: note.id } });
    expect(stillThere).toBeNull();

    const activity = await prisma.activity.findFirstOrThrow({ where: { applicationId: application.id, eventType: 'Note deleted' } });
    expect(activity).toBeTruthy();
  });

  it('throws when updating a note that does not exist', async () => {
    await expect(updateNoteWorkflow(prisma, 'does-not-exist', { content: 'x' })).rejects.toThrow('Note not found');
  });

  it('throws when deleting a note that does not exist', async () => {
    await expect(deleteNoteWorkflow(prisma, 'does-not-exist')).rejects.toThrow('Note not found');
  });
});

describe('ApplicationLink CRUD workflows', () => {
  it('creates a link scoped to an application', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

    const link = await createLinkWorkflow(prisma, { applicationId: application.id, label: 'Company careers page', url: 'https://acme.com/careers', category: 'Company', notes: null });
    expect(link.label).toBe('Company careers page');
    expect(link.category).toBe('Company');

    const links = await prisma.applicationLink.findMany({ where: { applicationId: application.id } });
    expect(links).toHaveLength(1);

    const activity = await prisma.activity.findFirstOrThrow({ where: { applicationId: application.id, eventType: 'Link added' } });
    expect(activity).toBeTruthy();
  });

  it('throws creating a link for an application that does not exist', async () => {
    await expect(
      createLinkWorkflow(prisma, { applicationId: 'does-not-exist', label: 'x', url: 'https://example.com' }),
    ).rejects.toThrow('Application not found');
  });

  it('updates a link\'s fields', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });
    const link = await createLinkWorkflow(prisma, { applicationId: application.id, label: 'Original', url: 'https://acme.com' });

    const updated = await updateLinkWorkflow(prisma, link.id, { label: 'Renamed', category: 'Interview Preparation' });
    expect(updated.label).toBe('Renamed');
    expect(updated.category).toBe('Interview Preparation');
    expect(updated.url).toBe('https://acme.com'); // untouched

    const activity = await prisma.activity.findFirstOrThrow({ where: { applicationId: application.id, eventType: 'Link edited' } });
    expect(activity).toBeTruthy();
  });

  it('deletes a link and records an Activity', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });
    const link = await createLinkWorkflow(prisma, { applicationId: application.id, label: 'To delete', url: 'https://acme.com' });

    await deleteLinkWorkflow(prisma, link.id);
    const stillThere = await prisma.applicationLink.findUnique({ where: { id: link.id } });
    expect(stillThere).toBeNull();

    const activity = await prisma.activity.findFirstOrThrow({ where: { applicationId: application.id, eventType: 'Link deleted' } });
    expect(activity).toBeTruthy();
  });

  it('throws when updating or deleting a link that does not exist', async () => {
    await expect(updateLinkWorkflow(prisma, 'does-not-exist', { label: 'x' })).rejects.toThrow('Link not found');
    await expect(deleteLinkWorkflow(prisma, 'does-not-exist')).rejects.toThrow('Link not found');
  });
});
