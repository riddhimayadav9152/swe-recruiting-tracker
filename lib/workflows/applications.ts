import type { PrismaClient } from '@prisma/client';
import { addMinutes, subDays } from 'date-fns';
import { deriveInitialStage, generateApplicationCode, generateNextAction } from '@/lib/recruiting';
import { parseDateOnly, parseDateTimeLocal, parseZonedDateTime } from '@/lib/dates';
import { assertActionAllowed } from '@/lib/workflow-policy';
import type {
  ApplyPayload,
  ContactPayload,
  InterviewCompletedPayload,
  InterviewReceivedPayload,
  OaCompletedPayload,
  OaReceivedPayload,
  OfferPayload,
  RejectPayload,
  SetApplicationDatePayload,
} from '@/lib/schemas/workflows';

// Every workflow function opens its own `$transaction`, so it always needs the
// top-level PrismaClient rather than a Prisma.TransactionClient (which lacks
// `$transaction`). This alias exists so the client type used by workflow
// services has one name to import instead of `@prisma/client`'s PrismaClient
// directly in every file.
export type WorkflowPrisma = PrismaClient;

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
  // Any valid status is accepted here — it's the caller's job to restrict
  // this further if needed. The standard "New Opportunity" endpoint only
  // ever passes 'Not Applied'/'Preparing' (enforced by
  // applicationCreateSchema); the separately-validated import pathway is
  // allowed to pass any status, since it's re-creating already-advanced
  // historical records. There is deliberately no `currentStage` input —
  // it's always derived from `status` via `deriveInitialStage` so status and
  // stage can never drift out of sync, regardless of caller.
  status?: string;
  location?: string | null;
  applicationDeadline?: string | null;
  dateFound?: string | null;
  notes?: string | null;
}, existingCodes: string[] = []) {
  const applicationCode = generateApplicationCode(input.company, input.role, new Date(), existingCodes);
  const initialStatus = input.status ?? 'Not Applied';
  const initialStage = deriveInitialStage(initialStatus as Parameters<typeof deriveInitialStage>[0]);
  const dateFound = input.dateFound ? parseDateOnly(input.dateFound) ?? new Date() : new Date();
  const nextActionDue = input.applicationDeadline ? parseDateOnly(input.applicationDeadline) ?? new Date(Date.now() + 2 * 86400000) : new Date(Date.now() + 2 * 86400000);
  const nextActionDueKind: 'date' | 'timestamp' = input.applicationDeadline ? 'date' : 'timestamp';

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
        applicationDeadline: input.applicationDeadline ? parseDateOnly(input.applicationDeadline) : null,
        dateFound,
        notes: input.notes ?? '',
        nextAction: generateNextAction(initialStatus as 'Not Applied' | 'Preparing' | 'Applied' | 'OA' | 'Recruiter Screen' | 'Technical Interview' | 'Final Round' | 'Offer' | 'Accepted' | 'Rejected' | 'Withdrawn' | 'Closed', initialStage),
        nextActionDue,
        nextActionDueKind,
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
  assertActionAllowed(existing.status, 'apply', payload.override === true);

  const resumeVersionId = payload.resumeVersionId;
  const resumeVersion = await prisma.resumeVersion.findUnique({ where: { id: resumeVersionId } });
  if (!resumeVersion) throw new Error('A valid resume version is required');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'Applied',
        currentStage: 'Application Submitted',
        dateApplied: payload.dateApplied ? parseDateOnly(payload.dateApplied) ?? new Date() : new Date(),
        resumeVersionId,
        emailUsed: payload.emailUsed ?? existing.emailUsed,
        coverLetterStatus: payload.coverLetterStatus ?? existing.coverLetterStatus,
        nextAction: 'Monitor application and email',
        nextActionDue: payload.nextActionDue ? parseDateTimeLocal(payload.nextActionDue) ?? new Date(Date.now() + 10 * 86400000) : new Date(Date.now() + 10 * 86400000),
        nextActionDueKind: 'timestamp',
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
  assertActionAllowed(existing.status, 'oaReceived', payload.override === true);

  // dueAt/receivedAt are wall-clock times with no timezone of their own —
  // interpret them in the assessment's own selected IANA timezone, never the
  // server process's timezone (see parseZonedDateTime in lib/dates.ts).
  const dueAt = parseZonedDateTime(payload.dueAt, payload.timezone);
  if (!dueAt) throw new Error('dueAt is required');
  const receivedAt = payload.receivedAt ? parseZonedDateTime(payload.receivedAt, payload.timezone) : null;
  const nextActionDue = payload.nextActionDue ? parseZonedDateTime(payload.nextActionDue, payload.timezone) ?? dueAt : dueAt;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'OA',
        currentStage: 'Online Assessment',
        nextAction: 'Prepare for and complete OA',
        nextActionDue,
        nextActionDueKind: 'timestamp',
      },
    });

    const assessment = await tx.assessment.create({
      data: {
        applicationId,
        type: 'OA',
        receivedAt,
        dueAt,
        timezone: payload.timezone,
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
  assertActionAllowed(existing.status, 'oaCompleted', payload.override === true);

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
        nextActionDueKind: 'timestamp',
      },
    });

    await tx.assessment.update({
      where: { id: assessment.id },
      data: {
        completedAt: payload.completedAt ? parseDateTimeLocal(payload.completedAt) ?? new Date() : new Date(),
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
  assertActionAllowed(existing.status, 'interviewReceived', payload.override === true);

  // scheduledStart/scheduledEnd are wall-clock times with no timezone of
  // their own ("2026-08-15T14:00") — they must be interpreted in the
  // interview's own selected IANA timezone, never the server process's
  // timezone, or the stored UTC instant would silently depend on wherever
  // this code happens to run.
  const scheduledStart = parseZonedDateTime(payload.scheduledStart, payload.timezone);
  if (!scheduledStart) throw new Error('scheduledStart is required');

  const stage = payload.stage;
  const status = deriveInterviewStatus(stage);
  const scheduledEnd = payload.scheduledEnd
    ? parseZonedDateTime(payload.scheduledEnd, payload.timezone)
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
        nextActionDueKind: 'timestamp',
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
  assertActionAllowed(existing.status, 'interviewCompleted', payload.override === true);

  const interviewId = payload.interviewId;

  return prisma.$transaction(async (tx) => {
    const interview = await tx.interview.findUnique({ where: { id: interviewId } });
    if (!interview || interview.applicationId !== applicationId) throw new Error('Interview not found');
    if (interview.completedAt) throw new Error('Interview already completed');

    const stage = payload.stage ?? interview.stage;
    const status = deriveInterviewStatus(stage);
    const followUpDate = payload.followUpDate ? parseDateOnly(payload.followUpDate) ?? new Date(Date.now() + 5 * 86400000) : new Date(Date.now() + 5 * 86400000);

    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status,
        currentStage: stage,
        nextAction: 'Follow up after interview',
        nextActionDue: followUpDate,
        nextActionDueKind: payload.followUpDate ? 'date' : 'timestamp',
      },
    });

    await tx.interview.update({
      where: { id: interviewId },
      data: {
        completedAt: payload.completedAt ? parseDateTimeLocal(payload.completedAt) ?? new Date() : new Date(),
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
  assertActionAllowed(existing.status, 'reject', payload.override === true);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'Rejected',
        currentStage: 'Rejected',
        nextAction: 'No active next action',
        nextActionDue: null,
        nextActionDueKind: 'timestamp',
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
  assertActionAllowed(existing.status, 'offer', payload.override === true);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'Offer',
        currentStage: 'Offer Received',
        nextAction: 'Review, compare, and respond to offer',
        nextActionDue: parseDateOnly(payload.decisionDeadline),
        nextActionDueKind: 'date',
        compensationSummary: payload.compensationSummary ?? existing.compensationSummary,
        notes: payload.notes ? `${existing.notes ?? ''}\n${payload.notes}`.trim() : existing.notes,
      },
    });

    await tx.offer.upsert({
      where: { applicationId },
      create: {
        applicationId,
        offerDate: payload.offerDate ? parseDateOnly(payload.offerDate) : null,
        decisionDeadline: parseDateOnly(payload.decisionDeadline),
        compensationSummary: payload.compensationSummary ?? null,
        notes: payload.notes ?? null,
      },
      update: {
        offerDate: payload.offerDate ? parseDateOnly(payload.offerDate) ?? undefined : undefined,
        decisionDeadline: parseDateOnly(payload.decisionDeadline) ?? undefined,
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

// Repairs a record that is missing its application date — the only way this
// can legitimately happen today is an imported historical row (the standard
// "Mark Applied" workflow always sets dateApplied, defaulting to "now" if
// the caller didn't supply one; see applyWorkflow above). This never changes
// status/stage, so like contacts/notes it isn't gated by
// lib/workflow-policy.ts — but it only ever fills in a genuinely missing
// date, never overwrites one that's already set, to avoid quietly
// corrupting a real (if unusual) application date.
export async function setApplicationDateWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: SetApplicationDatePayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');
  if (existing.dateApplied) throw new Error('This application already has a date applied on record');

  const dateApplied = parseDateOnly(payload.dateApplied);
  if (!dateApplied) throw new Error('A valid application date is required');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: { dateApplied },
    });

    await tx.activity.create({
      data: {
        applicationId,
        eventType: 'Application date repaired',
        previousStatus: existing.status,
        newStatus: existing.status,
        previousStage: existing.currentStage,
        newStage: existing.currentStage,
        summary: `Set missing application date to ${payload.dateApplied}`,
        metadataJson: JSON.stringify(payload),
      },
    });

    return updated;
  });
}

// Contacts are informational — adding one never changes an application's
// status/stage, so unlike the workflows above this isn't gated by
// lib/workflow-policy.ts.
export async function contactWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: ContactPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  return prisma.$transaction(async (tx) => {
    const contact = await tx.contact.create({
      data: {
        applicationId,
        name: payload.name,
        title: payload.title ?? '',
        email: payload.email ?? '',
        relationship: payload.relationship ?? '',
        referralStatus: payload.referralStatus ?? '',
        notes: payload.notes ?? '',
        nextFollowUp: payload.nextFollowUp ? parseDateOnly(payload.nextFollowUp) : null,
      },
    });

    await tx.activity.create({
      data: {
        applicationId,
        eventType: 'Contact added',
        summary: 'Added contact',
        metadataJson: JSON.stringify(payload),
      },
    });

    return contact;
  });
}
