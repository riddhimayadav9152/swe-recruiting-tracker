import type { PrismaClient } from '@prisma/client';
import { addMinutes, subDays } from 'date-fns';
import { generateApplicationCode, generateNextAction } from '@/lib/recruiting';
import type {
  ApplyPayload,
  InterviewCompletedPayload,
  InterviewReceivedPayload,
  OaCompletedPayload,
  OaReceivedPayload,
  OfferPayload,
  RejectPayload,
} from '@/lib/schemas/workflows';

// Every workflow function opens its own `$transaction`, so it always needs the
// top-level PrismaClient rather than a Prisma.TransactionClient (which lacks
// `$transaction`). This alias exists so the client type used by workflow
// services has one name to import instead of `@prisma/client`'s PrismaClient
// directly in every file.
export type WorkflowPrisma = PrismaClient;

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

export async function applyWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: ApplyPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  const resumeVersionId = payload.resumeVersionId;
  const resumeVersion = await prisma.resumeVersion.findUnique({ where: { id: resumeVersionId } });
  if (!resumeVersion) throw new Error('A valid resume version is required');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'Applied',
        currentStage: 'Application Submitted',
        dateApplied: payload.dateApplied ? new Date(payload.dateApplied) : new Date(),
        resumeVersionId,
        emailUsed: payload.emailUsed ?? existing.emailUsed,
        coverLetterStatus: payload.coverLetterStatus ?? existing.coverLetterStatus,
        nextAction: 'Monitor application and email',
        nextActionDue: payload.nextActionDue ? new Date(payload.nextActionDue) : new Date(Date.now() + 10 * 86400000),
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

export async function oaReceivedWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: OaReceivedPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'OA',
        currentStage: 'Online Assessment',
        nextAction: 'Prepare for and complete OA',
        nextActionDue: payload.nextActionDue ? new Date(payload.nextActionDue) : new Date(payload.dueAt),
      },
    });

    const assessment = await tx.assessment.create({
      data: {
        applicationId,
        type: 'OA',
        receivedAt: payload.receivedAt ? new Date(payload.receivedAt) : null,
        dueAt: new Date(payload.dueAt),
        platform: payload.platform ?? null,
        durationMinutes: payload.durationMinutes ?? null,
        questionCount: payload.questionCount ?? null,
        topics: payload.topics ?? null,
        notes: payload.notes ?? '',
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
        metadataJson: JSON.stringify({ ...payload, assessmentId: assessment.id }),
      },
    });

    return updated;
  });
}

export async function oaCompletedWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: OaCompletedPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  return prisma.$transaction(async (tx) => {
    const assessment = await tx.assessment.findUnique({ where: { id: payload.assessmentId } });
    if (!assessment || assessment.applicationId !== applicationId) throw new Error('Assessment not found');
    if (assessment.completedAt) throw new Error('Assessment already completed');

    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'OA',
        currentStage: 'Online Assessment',
        nextAction: 'Await OA result',
        nextActionDue: new Date(Date.now() + 4 * 86400000),
      },
    });

    await tx.assessment.update({
      where: { id: assessment.id },
      data: {
        completedAt: payload.completedAt ? new Date(payload.completedAt) : new Date(),
        difficulty: payload.difficulty ?? null,
        confidence: payload.confidence ?? null,
        result: payload.result ?? null,
        encounteredQuestions: payload.encounteredQuestions ?? null,
        topics: payload.topics ?? null,
        notes: payload.notes ?? null,
      },
    });

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

export async function interviewReceivedWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: InterviewReceivedPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  const scheduledStart = parseDate(payload.scheduledStart);
  if (!scheduledStart) throw new Error('scheduledStart is required');

  const stage = payload.stage;
  const status = deriveInterviewStatus(stage);
  const scheduledEnd = payload.scheduledEnd
    ? new Date(payload.scheduledEnd)
    : payload.durationMinutes
      ? addMinutes(scheduledStart, payload.durationMinutes)
      : null;

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

    const interview = await tx.interview.create({
      data: {
        applicationId,
        stage,
        scheduledStart,
        scheduledEnd,
        timezone: payload.timezone ?? null,
        format: payload.format ?? null,
        location: payload.location ?? '',
        meetingUrl: payload.meetingUrl ?? '',
        recruiter: payload.recruiter ?? '',
        interviewer: payload.interviewer ?? '',
        notes: payload.notes ?? '',
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
        metadataJson: JSON.stringify({ ...payload, interviewId: interview.id }),
      },
    });

    return updated;
  });
}

export async function interviewCompletedWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: InterviewCompletedPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  const interviewId = payload.interviewId;

  return prisma.$transaction(async (tx) => {
    const interview = await tx.interview.findUnique({ where: { id: interviewId } });
    if (!interview || interview.applicationId !== applicationId) throw new Error('Interview not found');
    if (interview.completedAt) throw new Error('Interview already completed');

    const stage = payload.stage ?? interview.stage;
    const status = deriveInterviewStatus(stage);
    const followUpDate = payload.followUpDate ? new Date(payload.followUpDate) : new Date(Date.now() + 5 * 86400000);

    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status,
        currentStage: stage,
        nextAction: 'Follow up after interview',
        nextActionDue: followUpDate,
      },
    });

    await tx.interview.update({
      where: { id: interviewId },
      data: {
        completedAt: payload.completedAt ? new Date(payload.completedAt) : new Date(),
        result: payload.result ?? null,
        questions: payload.questions ?? null,
        whatWentWell: payload.whatWentWell ?? null,
        improvements: payload.improvements ?? null,
        notes: payload.notes ?? null,
        followUpDate,
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

export async function rejectWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: RejectPayload) {
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
        outcome: payload.rejectionReason ?? existing.outcome,
        notes: payload.notes ? `${existing.notes ?? ''}\n${payload.notes}`.trim() : existing.notes,
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

export async function offerWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: OfferPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'Offer',
        currentStage: 'Offer Received',
        nextAction: 'Review, compare, and respond to offer',
        nextActionDue: new Date(payload.decisionDeadline),
        compensationSummary: payload.compensationSummary ?? existing.compensationSummary,
        notes: payload.notes ? `${existing.notes ?? ''}\n${payload.notes}`.trim() : existing.notes,
      },
    });

    await tx.offer.upsert({
      where: { applicationId },
      create: {
        applicationId,
        offerDate: payload.offerDate ? new Date(payload.offerDate) : null,
        decisionDeadline: new Date(payload.decisionDeadline),
        compensationSummary: payload.compensationSummary ?? null,
        notes: payload.notes ?? null,
      },
      update: {
        offerDate: payload.offerDate ? new Date(payload.offerDate) : undefined,
        decisionDeadline: new Date(payload.decisionDeadline),
        compensationSummary: payload.compensationSummary ?? undefined,
        notes: payload.notes ?? undefined,
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
