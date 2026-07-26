import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { subDays } from 'date-fns';
import {
  applyWorkflow,
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
    prisma.application.deleteMany(),
    prisma.resumeVersion.deleteMany(),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

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
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

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
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

    await oaReceivedWorkflow(prisma, application.id, { action: 'oaReceived', receivedAt: '2026-07-26T09:00:00', dueAt: '2026-07-28T09:00:00' });
    await oaCompletedWorkflow(prisma, application.id, {
      action: 'oaCompleted',
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
    const recruiter = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });
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

    const technical = await createApplicationRecord(prisma, { company: 'Beta', role: 'ML Engineer', applicationUrl: 'https://beta.com/apply', priority: 'P1' });
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
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });
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

  it('persists offer details', async () => {
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

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
    const application = await createApplicationRecord(prisma, { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' });

    await expect(interviewReceivedWorkflow(prisma, application.id, { action: 'interviewReceived', stage: 'Recruiter Screen' as never })).rejects.toThrow('scheduledStart is required');

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(updated.status).toBe('Not Applied');
    expect(updated.currentStage).toBe('Discovered');
  });
});
