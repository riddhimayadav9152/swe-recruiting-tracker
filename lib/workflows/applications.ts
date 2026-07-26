import { PrismaClient } from '@prisma/client';
import { subDays } from 'date-fns';
import { generateApplicationCode, generateNextAction } from '@/lib/recruiting';

export type WorkflowPayload = {
  action: string;
  [key: string]: unknown;
};

const parseDate = (value: unknown) => {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const deriveInterviewStatus = (stage: string) => {
  switch (stage) {
    case 'Recruiter Screen':
      return 'Recruiter Screen';
    case 'Technical Interview':
      return 'Technical Interview';
    case 'Final Round':
      return 'Final Round';
    default:
      return 'Technical Interview';
  }
};

export async function createApplicationRecord(prisma: PrismaClient, input: {
  company: string;
  role: string;
  applicationUrl: string;
  priority: string;
  status?: string;
  currentStage?: string | null;
  location?: string | null;
  applicationDeadline?: string | null;
  dateFound?: string | null;
  notes?: string | null;
}, existingCodes: string[] = []) {
  const applicationCode = generateApplicationCode(input.company, input.role, new Date(), existingCodes);
  const initialStatus = input.status ?? 'Not Applied';
  const initialStage = input.currentStage ?? 'Discovered';
  const dateFound = input.dateFound ? new Date(input.dateFound) : new Date();
  const nextActionDue = input.applicationDeadline ? new Date(input.applicationDeadline) : new Date(Date.now() + 2 * 86400000);

  return prisma.$transaction(async (tx) => {
    const application = await tx.application.create({
      data: {
        applicationCode,
        company: input.company,
        role: input.role,
        applicationUrl: input.applicationUrl,
        priority: input.priority,
        status: initialStatus,
        currentStage: initialStage,
        location: input.location ?? null,
        applicationDeadline: input.applicationDeadline ? new Date(input.applicationDeadline) : null,
        dateFound,
        notes: input.notes ?? '',
        nextAction: generateNextAction(initialStatus as 'Not Applied' | 'Preparing' | 'Applied' | 'OA' | 'Recruiter Screen' | 'Technical Interview' | 'Final Round' | 'Offer' | 'Accepted' | 'Rejected' | 'Withdrawn' | 'Closed', initialStage),
        nextActionDue,
      },
    });

    await tx.activity.create({
      data: {
        applicationId: application.id,
        eventType: 'Opportunity created',
        previousStatus: null,
        newStatus: initialStatus,
        previousStage: null,
        newStage: initialStage,
        summary: `Added new opportunity for ${application.company}`,
        metadataJson: JSON.stringify({ priority: input.priority }),
      },
    });

    return application;
  });
}

export async function applyWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: WorkflowPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  const resumeVersionId = typeof payload.resumeVersionId === 'string' ? payload.resumeVersionId : null;
  const resumeVersion = resumeVersionId ? await prisma.resumeVersion.findUnique({ where: { id: resumeVersionId } }) : null;
  if (!resumeVersion) throw new Error('A valid resume version is required');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'Applied',
        currentStage: 'Application Submitted',
        dateApplied: payload.dateApplied ? new Date(String(payload.dateApplied)) : new Date(),
        resumeVersionId,
        emailUsed: typeof payload.emailUsed === 'string' ? payload.emailUsed : existing.emailUsed,
        coverLetterStatus: typeof payload.coverLetterStatus === 'string' ? payload.coverLetterStatus : existing.coverLetterStatus,
        nextAction: 'Monitor application and email',
        nextActionDue: payload.nextActionDue ? new Date(String(payload.nextActionDue)) : new Date(Date.now() + 10 * 86400000),
      },
    });

    await tx.activity.create({
      data: {
        applicationId,
        eventType: 'Application submitted',
        previousStatus: existing.status,
        newStatus: 'Applied',
        previousStage: existing.currentStage,
        newStage: 'Application Submitted',
        summary: 'Marked application as submitted',
        metadataJson: JSON.stringify(payload),
      },
    });

    return updated;
  });
}

export async function oaReceivedWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: WorkflowPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'OA',
        currentStage: 'Online Assessment',
        nextAction: 'Prepare for and complete OA',
        nextActionDue: payload.nextActionDue ? new Date(String(payload.nextActionDue)) : parseDate(payload.dueAt) ?? new Date(Date.now() + 3 * 86400000),
      },
    });

    const existingAssessment = await tx.assessment.findFirst({ where: { applicationId, type: 'OA' } });
    const assessmentPayload = {
      applicationId,
      type: 'OA',
      receivedAt: payload.receivedAt ? new Date(String(payload.receivedAt)) : null,
      dueAt: payload.dueAt ? new Date(String(payload.dueAt)) : null,
      platform: typeof payload.platform === 'string' ? payload.platform : null,
      durationMinutes: typeof payload.durationMinutes === 'number' ? payload.durationMinutes : null,
      questionCount: typeof payload.questionCount === 'number' ? payload.questionCount : null,
      topics: typeof payload.topics === 'string' ? payload.topics : null,
      notes: typeof payload.notes === 'string' ? payload.notes : '',
    };

    if (existingAssessment) {
      await tx.assessment.update({ where: { id: existingAssessment.id }, data: assessmentPayload });
    } else {
      await tx.assessment.create({ data: assessmentPayload });
    }

    await tx.activity.create({
      data: {
        applicationId,
        eventType: 'OA received',
        previousStatus: existing.status,
        newStatus: 'OA',
        previousStage: existing.currentStage,
        newStage: 'Online Assessment',
        summary: 'Recorded OA milestone',
        metadataJson: JSON.stringify(payload),
      },
    });

    return updated;
  });
}

export async function oaCompletedWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: WorkflowPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'OA',
        currentStage: 'Online Assessment',
        nextAction: 'Await OA result',
        nextActionDue: null,
      },
    });

    const existingAssessment = await tx.assessment.findFirst({ where: { applicationId, type: 'OA' } });
    const assessmentPayload = {
      completedAt: payload.completedAt ? new Date(String(payload.completedAt)) : null,
      difficulty: typeof payload.difficulty === 'string' ? payload.difficulty : null,
      confidence: typeof payload.confidence === 'string' ? payload.confidence : null,
      result: typeof payload.result === 'string' ? payload.result : null,
      notes: typeof payload.notes === 'string' ? payload.notes : null,
    };

    if (existingAssessment) {
      await tx.assessment.update({ where: { id: existingAssessment.id }, data: assessmentPayload });
    } else {
      await tx.assessment.create({ data: { applicationId, type: 'OA', ...assessmentPayload } });
    }

    await tx.activity.create({
      data: {
        applicationId,
        eventType: 'OA completed',
        previousStatus: existing.status,
        newStatus: 'OA',
        previousStage: existing.currentStage,
        newStage: 'Online Assessment',
        summary: 'Recorded OA completion',
        metadataJson: JSON.stringify(payload),
      },
    });

    return updated;
  });
}

export async function interviewReceivedWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: WorkflowPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  const scheduledStart = parseDate(payload.scheduledStart);
  if (!scheduledStart) throw new Error('scheduledStart is required');

  const stage = typeof payload.stage === 'string' ? payload.stage : 'Recruiter Screen';
  const status = deriveInterviewStatus(stage);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status,
        currentStage: stage,
        nextAction: `Prepare for ${stage}`,
        nextActionDue: subDays(scheduledStart, 1),
      },
    });

    await tx.interview.create({
      data: {
        applicationId,
        stage,
        scheduledStart,
        scheduledEnd: payload.scheduledEnd ? new Date(String(payload.scheduledEnd)) : null,
        timezone: typeof payload.timezone === 'string' ? payload.timezone : null,
        format: typeof payload.format === 'string' ? payload.format : null,
        location: typeof payload.location === 'string' ? payload.location : '',
        meetingUrl: typeof payload.meetingUrl === 'string' ? payload.meetingUrl : '',
        recruiter: typeof payload.recruiter === 'string' ? payload.recruiter : '',
        interviewer: typeof payload.interviewer === 'string' ? payload.interviewer : '',
        notes: typeof payload.notes === 'string' ? payload.notes : '',
      },
    });

    await tx.activity.create({
      data: {
        applicationId,
        eventType: 'Interview scheduled',
        previousStatus: existing.status,
        newStatus: status,
        previousStage: existing.currentStage,
        newStage: stage,
        summary: 'Scheduled interview',
        metadataJson: JSON.stringify(payload),
      },
    });

    return updated;
  });
}

export async function interviewCompletedWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: WorkflowPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  const stage = typeof payload.stage === 'string' ? payload.stage : existing.currentStage ?? 'Recruiter Screen';
  const status = deriveInterviewStatus(stage);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status,
        currentStage: stage,
        nextAction: 'Follow up after interview',
        nextActionDue: null,
      },
    });

    await tx.interview.updateMany({
      where: { applicationId, stage },
      data: {
        completedAt: payload.completedAt ? new Date(String(payload.completedAt)) : null,
        result: typeof payload.result === 'string' ? payload.result : null,
        notes: typeof payload.notes === 'string' ? payload.notes : null,
      },
    });

    await tx.activity.create({
      data: {
        applicationId,
        eventType: 'Interview completed',
        previousStatus: existing.status,
        newStatus: status,
        previousStage: existing.currentStage,
        newStage: stage,
        summary: 'Completed interview',
        metadataJson: JSON.stringify(payload),
      },
    });

    return updated;
  });
}

export async function rejectWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: WorkflowPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'Rejected',
        currentStage: 'Rejected',
        nextAction: 'No active next action',
        nextActionDue: null,
        outcome: typeof payload.rejectionReason === 'string' ? payload.rejectionReason : existing.outcome,
        notes: typeof payload.notes === 'string' ? `${existing.notes ?? ''}\n${payload.notes}`.trim() : existing.notes,
      },
    });

    await tx.activity.create({
      data: {
        applicationId,
        eventType: 'Rejected',
        previousStatus: existing.status,
        newStatus: 'Rejected',
        previousStage: existing.currentStage,
        newStage: 'Rejected',
        summary: 'Marked application as rejected',
        metadataJson: JSON.stringify(payload),
      },
    });

    return updated;
  });
}

export async function offerWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: WorkflowPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'Offer',
        currentStage: 'Offer Received',
        nextAction: 'Review, compare, and respond to offer',
        nextActionDue: payload.decisionDeadline ? new Date(String(payload.decisionDeadline)) : new Date(Date.now() + 7 * 86400000),
        compensationSummary: typeof payload.compensationSummary === 'string' ? payload.compensationSummary : existing.compensationSummary,
        notes: typeof payload.notes === 'string' ? `${existing.notes ?? ''}\n${payload.notes}`.trim() : existing.notes,
        applicationDeadline: payload.decisionDeadline ? new Date(String(payload.decisionDeadline)) : existing.applicationDeadline,
      },
    });

    await tx.activity.create({
      data: {
        applicationId,
        eventType: 'Offer received',
        previousStatus: existing.status,
        newStatus: 'Offer',
        previousStage: existing.currentStage,
        newStage: 'Offer Received',
        summary: 'Recorded offer',
        metadataJson: JSON.stringify(payload),
      },
    });

    return updated;
  });
}
