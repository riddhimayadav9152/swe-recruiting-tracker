import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { subDays } from 'date-fns';
import {
  applyWorkflow,
  contactWorkflow,
  createApplicationRecord,
  interviewCompletedWorkflow,
  interviewReceivedWorkflow,
  oaCompletedWorkflow,
  oaReceivedWorkflow,
  offerWorkflow,
  rejectWorkflow,
} from '../workflows/applications';

const projectRoot = path.resolve(__dirname, '..', '..');
const dbPath = path.resolve(projectRoot, 'data', 'workflow-test.db');
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
    prisma.contact.deleteMany(),
    prisma.note.deleteMany(),
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

  it('rejects an invalid resume for mark applied', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

    await expect(applyWorkflow(prisma, application.id, { action: 'apply', resumeVersionId: 'missing-resume' })).rejects.toThrow('A valid resume version is required');
  });

  it('persists oa received details', async () => {
    const application = await createAppliedApplication();

    await oaReceivedWorkflow(prisma, application.id, {
      action: 'oaReceived',
      receivedAt: '2026-07-26T09:00:00',
      dueAt: '2026-07-28T09:00:00',
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

    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', receivedAt: '2026-07-26T09:00:00', dueAt: '2026-07-28T09:00:00' });
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
    const scheduledStart = new Date('2026-07-26T14:00:00');

    await interviewReceivedWorkflow(prisma, application.id, {
      action: 'interviewReceived',
      stage: 'Recruiter Screen',
      scheduledStart: scheduledStart.toISOString(),
      timezone: 'America/New_York',
      format: 'Video',
      location: 'Zoom',
      recruiter: 'Mina',
      interviewer: 'Sam',
      notes: 'Intro call',
    });

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(updated.nextActionDue?.getTime()).toBe(subDays(scheduledStart, 1).getTime());
  });

  it('persists oa completed details without dropping encountered questions', async () => {
    const application = await createAppliedApplication();

    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', receivedAt: '2026-07-26T09:00:00', dueAt: '2026-07-28T09:00:00' });
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

    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', dueAt: '2026-07-28T09:00:00' });
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

    await expect(interviewReceivedWorkflow(prisma, application.id, { action: 'interviewReceived', stage: 'Recruiter Screen' as never })).rejects.toThrow('scheduledStart is required');

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
      oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', dueAt: '2026-07-28T09:00:00' }),
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

    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', dueAt: '2026-07-28T09:00:00', override: true });

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

    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', dueAt: '2026-07-28T09:00:00' });

    updated = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(updated.status).toBe('OA');
    const interviews = await prisma.interview.findMany({ where: { applicationId: application.id } });
    const assessments = await prisma.assessment.findMany({ where: { applicationId: application.id } });
    expect(interviews).toHaveLength(1);
    expect(assessments).toHaveLength(1);
  });

  it('supports multiple OAs and multiple interview rounds for the same application', async () => {
    const application = await createAppliedApplication();

    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', dueAt: '2026-07-20T09:00:00' });
    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', dueAt: '2026-07-27T09:00:00', platform: 'Second round' });

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
});
