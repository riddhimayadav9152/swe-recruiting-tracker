import { Prisma, PrismaClient } from '@prisma/client';
import { generateApplicationCode, generateNextAction } from '@/lib/recruiting';

export type WorkflowPayload = {
  action: 'apply' | 'oa' | 'interview' | 'reject' | 'offer' | 'description' | 'note' | 'contact';
  [key: string]: unknown;
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

  return prisma.application.create({
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
}

export async function applyWorkflow(prisma: PrismaClient, applicationId: string, payload: WorkflowPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  const resumeVersionId = typeof payload.resumeVersionId === 'string' ? payload.resumeVersionId : null;
  const resumeVersion = resumeVersionId ? await prisma.resumeVersion.findUnique({ where: { id: resumeVersionId } }) : null;
  if (payload.action === 'apply' && !resumeVersion) throw new Error('A valid resume version is required');

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

    await tx.assessment.create({
      data: {
        applicationId,
        type: 'Application',
        notes: typeof payload.notes === 'string' ? payload.notes : '',
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

export async function oaWorkflow(prisma: PrismaClient, applicationId: string, payload: WorkflowPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'OA',
        currentStage: 'Online Assessment',
        nextAction: 'Prepare for and complete OA',
        nextActionDue: payload.nextActionDue ? new Date(String(payload.nextActionDue)) : new Date(Date.now() + 3 * 86400000),
      },
    });

    await tx.assessment.create({
      data: {
        applicationId,
        type: 'OA',
        platform: typeof payload.platform === 'string' ? payload.platform : null,
        dueAt: payload.nextActionDue ? new Date(String(payload.nextActionDue)) : null,
        notes: typeof payload.notes === 'string' ? payload.notes : '',
      },
    });

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

export async function interviewWorkflow(prisma: PrismaClient, applicationId: string, payload: WorkflowPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  return prisma.$transaction(async (tx) => {
    const stage = typeof payload.currentStage === 'string' ? payload.currentStage : 'Recruiter Screen';
    const status = typeof payload.status === 'string' ? payload.status : 'Technical Interview';
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status,
        currentStage: stage,
        nextAction: `Prepare for ${stage}`,
        nextActionDue: payload.nextActionDue ? new Date(String(payload.nextActionDue)) : new Date(Date.now() + 86400000),
      },
    });

    await tx.interview.create({
      data: {
        applicationId,
        stage,
        scheduledStart: payload.scheduledStart ? new Date(String(payload.scheduledStart)) : null,
        scheduledEnd: payload.scheduledEnd ? new Date(String(payload.scheduledEnd)) : null,
        timezone: 'UTC',
        format: 'Virtual',
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

export async function rejectWorkflow(prisma: PrismaClient, applicationId: string, payload: WorkflowPayload) {
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
        outcome: typeof payload.notes === 'string' ? payload.notes : existing.outcome,
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

export async function offerWorkflow(prisma: PrismaClient, applicationId: string, payload: WorkflowPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'Offer',
        currentStage: 'Offer Received',
        nextAction: 'Review, compare, and respond to offer',
        nextActionDue: payload.nextActionDue ? new Date(String(payload.nextActionDue)) : new Date(Date.now() + 7 * 86400000),
        compensationSummary: typeof payload.compensationSummary === 'string' ? payload.compensationSummary : existing.compensationSummary,
        notes: typeof payload.notes === 'string' ? `${existing.notes}\n${payload.notes}` : existing.notes,
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
