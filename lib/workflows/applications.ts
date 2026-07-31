import type { PrismaClient } from '@prisma/client';
import { addMinutes } from 'date-fns';
import {
  computePersonalApplyByDate,
  deriveInitialStage,
  generateApplicationCode,
  generateNextAction,
  nextBusinessDay,
  personalDateBeforeOfficialDate,
  personalDeadlineBeforeInstant,
  TERMINAL_STATUSES,
  type Priority,
} from '@/lib/recruiting';
import { addUtcDays, parseDateOnly, parseDateTimeLocal, parseZonedDateTime, utcToday } from '@/lib/dates';
import { assertActionAllowed, hasSubmittedApplication } from '@/lib/workflow-policy';
import { validateEditApplicationNextActionDue } from '@/lib/schemas/workflows';
import { isUniqueConstraintError } from '@/lib/import';
import type {
  ApplyPayload,
  ContactPayload,
  EditApplicationPayload,
  InterviewCompletedPayload,
  InterviewReceivedPayload,
  LinkCreatePayload,
  LinkUpdatePayload,
  NoteUpdatePayload,
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
  postingStatus?: string | null;
  postingDate?: string | null;
  applicationDeadline?: string | null;
  dateFound?: string | null;
  notes?: string | null;
}, existingCodes: string[] = []) {
  const applicationCode = generateApplicationCode(input.company, input.role, new Date(), existingCodes);
  const initialStatus = input.status ?? 'Not Applied';
  const initialStage = deriveInitialStage(initialStatus as Parameters<typeof deriveInitialStage>[0]);
  const dateFound = input.dateFound ? parseDateOnly(input.dateFound) ?? utcToday() : utcToday();
  const applicationDeadline = input.applicationDeadline ? parseDateOnly(input.applicationDeadline) : null;
  const postingDate = input.postingDate ? parseDateOnly(input.postingDate) : null;
  // A personal apply-by deadline, generated from the priority-scaled rules
  // (see computePersonalApplyByDate) — distinct from applicationDeadline,
  // the employer's own official deadline, which is stored separately and
  // never overwritten by this.
  const nextActionDue = initialStatus === 'Not Applied' || initialStatus === 'Preparing'
    ? computePersonalApplyByDate({
      priority: input.priority as Priority,
      dateFound,
      applicationDeadline,
      postingStatus: input.postingStatus,
      postingDate,
    })
    : initialStatus === 'Applied'
      ? addUtcDays(utcToday(), 7)
      : (TERMINAL_STATUSES as readonly string[]).includes(initialStatus)
        ? null
        : null;
  const nextActionDueKind: 'date' | 'timestamp' = 'date';

  return prisma.$transaction(async (tx) => {
    const applicationData = {
      company: input.company,
      role: input.role,
      applicationUrl: input.applicationUrl,
      priority: input.priority,
      status: initialStatus,
      currentStage: initialStage,
      location: input.location ?? null,
      postingStatus: input.postingStatus ?? null,
      postingDate,
      applicationDeadline,
      dateFound,
      notes: input.notes ?? '',
      nextAction: generateNextAction(initialStatus as 'Not Applied' | 'Preparing' | 'Applied' | 'OA' | 'Recruiter Screen' | 'Technical Interview' | 'Final Round' | 'Offer' | 'Accepted' | 'Rejected' | 'Withdrawn' | 'Closed', initialStage),
      nextActionDue,
      nextActionDueKind,
    };

    let application;
    try {
      application = await tx.application.create({ data: { applicationCode, ...applicationData } });
    } catch (error) {
      // `existingCodes` is only a snapshot taken before this transaction —
      // a concurrent request can create the same code in between, so a
      // collision here isn't necessarily a bug in the caller. Retry once
      // with a freshly disambiguated code, same as the import pathways
      // (lib/import.ts, lib/json-import.ts) already do for exactly this race.
      if (!isUniqueConstraintError(error)) throw error;
      const fallbackCode = generateApplicationCode(input.company, input.role, new Date(), [...existingCodes, applicationCode]);
      application = await tx.application.create({ data: { applicationCode: fallbackCode, ...applicationData } });
    }

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

  // Resume tracking is no longer part of this workflow — the user manages
  // resumes elsewhere. resumeVersionId is accepted only for backward
  // compatibility with any caller still sending one (silently ignored if
  // it doesn't resolve to a real row); Mark Applied itself never requires it.
  const resumeVersionId = payload.resumeVersionId
    ? (await prisma.resumeVersion.findUnique({ where: { id: payload.resumeVersionId } }))?.id ?? undefined
    : undefined;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'Applied',
        currentStage: 'Application Submitted',
        dateApplied: payload.dateApplied ? parseDateOnly(payload.dateApplied) ?? new Date() : new Date(),
        resumeVersionId,
        emailUsed: payload.emailUsed ?? existing.emailUsed,
        nextAction: 'Check email and candidate portal',
        // Default personal follow-up target: check email/portal in 7 days
        // (see the deadline-generation rules in lib/recruiting.ts) — an
        // explicit nextActionDue from the caller always overrides this.
        nextActionDue: payload.nextActionDue ? parseDateTimeLocal(payload.nextActionDue) ?? addUtcDays(utcToday(), 7) : addUtcDays(utcToday(), 7),
        nextActionDueKind: payload.nextActionDue ? 'timestamp' : 'date',
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
  // Default personal completion target: 24 hours before the OA's own due
  // time (never the due instant itself) — gives a buffer instead of cutting
  // it exactly at the deadline. An explicit nextActionDue always overrides this.
  const defaultNextActionDue = personalDeadlineBeforeInstant(dueAt, 24 * 60 * 60 * 1000);
  const nextActionDue = payload.nextActionDue ? parseZonedDateTime(payload.nextActionDue, payload.timezone) ?? defaultNextActionDue : defaultNextActionDue;

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
        nextActionDue: personalDeadlineBeforeInstant(scheduledStart, 24 * 60 * 60 * 1000),
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
    // Default personal follow-up target: the next business day (skips
    // Saturday/Sunday) — an explicit followUpDate always overrides this.
    const defaultFollowUp = nextBusinessDay(utcToday());
    const followUpDate = payload.followUpDate ? parseDateOnly(payload.followUpDate) ?? defaultFollowUp : defaultFollowUp;

    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status,
        currentStage: stage,
        nextAction: 'Follow up after interview',
        nextActionDue: followUpDate,
        nextActionDueKind: 'date',
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

  const officialDecisionDeadline = parseDateOnly(payload.decisionDeadline);
  if (!officialDecisionDeadline) throw new Error('A valid decision deadline is required');
  // Default personal decision target: two days before the OFFICIAL decision
  // deadline (never the official deadline itself) — an explicit
  // nextActionDue always overrides this.
  const defaultNextActionDue = personalDateBeforeOfficialDate(officialDecisionDeadline, 2);
  const nextActionDue = payload.nextActionDue ? parseDateOnly(payload.nextActionDue) ?? defaultNextActionDue : defaultNextActionDue;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        status: 'Offer',
        currentStage: 'Offer Received',
        nextAction: 'Review, compare and respond to offer',
        nextActionDue,
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
// lib/workflow-policy.ts's status transition matrix — but it only ever
// fills in a genuinely missing date, never overwrites one that's already
// set, AND it requires actual submission evidence first: without that
// check, this would be a back door for silently turning an ordinary Not
// Applied/Preparing record into an "Applied" one without ever going through
// applyWorkflow (no resume version, no real submission). See
// hasSubmittedApplication in lib/workflow-policy.ts for what counts as
// evidence; `payload.confirmImportRepair` is the one narrow, explicit
// exception (see lib/schemas/workflows.ts).
export async function setApplicationDateWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: SetApplicationDatePayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId }, include: { activities: true } });
  if (!existing) throw new Error('Application not found');
  if (existing.dateApplied) throw new Error('This application already has a date applied on record');

  const hasEvidence = hasSubmittedApplication({ status: existing.status, dateApplied: existing.dateApplied, activities: existing.activities });
  if (!hasEvidence && payload.confirmImportRepair !== true) {
    throw new Error('Setting an application date requires submission evidence (a post-submission status or an "Application submitted" activity) — an ordinary Not Applied/Preparing record cannot be backdated this way');
  }

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

// Every editable base field EXCEPT status/currentStage, which must only
// ever change through one of the workflow actions above — this keeps
// activity history trustworthy (see lib/workflow-policy.ts). Only fields
// the client actually supplied AND that differ from the current value are
// applied and listed in the Activity summary; a no-op edit (nothing
// actually changed) writes nothing and creates no Activity noise.
export async function editApplicationWorkflow(prisma: WorkflowPrisma, applicationId: string, payload: EditApplicationPayload) {
  const existing = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!existing) throw new Error('Application not found');

  const nextActionDueError = validateEditApplicationNextActionDue(payload);
  if (nextActionDueError) throw new Error(nextActionDueError);

  const data: Record<string, unknown> = {};
  const changes: string[] = [];

  const record = (dbKey: keyof typeof existing, label: string, newValue: unknown) => {
    const existingValue = existing[dbKey];
    const existingComparable = existingValue instanceof Date ? existingValue.toISOString() : existingValue;
    const newComparable = newValue instanceof Date ? newValue.toISOString() : newValue;
    if (existingComparable === newComparable) return;
    data[dbKey as string] = newValue;
    changes.push(label);
  };

  if (payload.company !== undefined) record('company', 'Company', payload.company);
  if (payload.role !== undefined) record('role', 'Role', payload.role);
  if ('jobId' in payload && payload.jobId !== undefined) record('jobId', 'Job ID', payload.jobId);
  if ('location' in payload && payload.location !== undefined) record('location', 'Location', payload.location);
  if ('workModel' in payload && payload.workModel !== undefined) record('workModel', 'Work model', payload.workModel);
  if (payload.priority !== undefined) record('priority', 'Priority', payload.priority);
  if ('postingStatus' in payload && payload.postingStatus !== undefined) record('postingStatus', 'Posting status', payload.postingStatus);
  if (payload.postingDate !== undefined) record('postingDate', 'Posting date', payload.postingDate ? parseDateOnly(payload.postingDate) : null);
  if (payload.applicationDeadline !== undefined) record('applicationDeadline', 'Official application deadline', payload.applicationDeadline ? parseDateOnly(payload.applicationDeadline) : null);
  if (payload.dateFound !== undefined) record('dateFound', 'Date found', payload.dateFound ? parseDateOnly(payload.dateFound) : null);
  if (payload.applicationUrl !== undefined) record('applicationUrl', 'Job-posting URL', payload.applicationUrl);
  if (payload.candidatePortalUrl !== undefined) record('candidatePortalUrl', 'Candidate portal URL', payload.candidatePortalUrl);
  if ('emailUsed' in payload && payload.emailUsed !== undefined) record('emailUsed', 'Login email', payload.emailUsed);
  if ('portalUsername' in payload && payload.portalUsername !== undefined) record('portalUsername', 'Portal username', payload.portalUsername);
  if ('passwordManagerReference' in payload && payload.passwordManagerReference !== undefined) record('passwordManagerReference', 'Password-manager reference', payload.passwordManagerReference);
  if ('confirmationNumber' in payload && payload.confirmationNumber !== undefined) record('confirmationNumber', 'Confirmation number', payload.confirmationNumber);
  if ('compensationSummary' in payload && payload.compensationSummary !== undefined) record('compensationSummary', 'Compensation summary', payload.compensationSummary);
  if ('eligibility' in payload && payload.eligibility !== undefined) record('eligibility', 'Eligibility', payload.eligibility);
  if ('sponsorship' in payload && payload.sponsorship !== undefined) record('sponsorship', 'Sponsorship', payload.sponsorship);
  if ('whyFit' in payload && payload.whyFit !== undefined) record('whyFit', 'Why this role fits', payload.whyFit);
  if (payload.lastVerifiedAt !== undefined) record('lastVerifiedAt', 'Last verified date/time', payload.lastVerifiedAt ? parseDateTimeLocal(payload.lastVerifiedAt) : null);
  if ('nextAction' in payload && payload.nextAction !== undefined) record('nextAction', 'Personal next action', payload.nextAction);
  if ('notes' in payload && payload.notes !== undefined) record('notes', 'General notes', payload.notes);

  if (payload.nextActionDue !== undefined) {
    const kind = payload.nextActionDueKind ?? 'date';
    const parsed = payload.nextActionDue ? (kind === 'date' ? parseDateOnly(payload.nextActionDue) : parseDateTimeLocal(payload.nextActionDue)) : null;
    record('nextActionDue', 'Personal next-action due date/time', parsed);
    if (existing.nextActionDueKind !== kind) data.nextActionDueKind = kind;
  }

  if (!changes.length) return existing;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.application.update({ where: { id: applicationId }, data });
    await tx.activity.create({
      data: {
        applicationId,
        eventType: 'Application edited',
        previousStatus: existing.status,
        newStatus: existing.status,
        previousStage: existing.currentStage,
        newStage: existing.currentStage,
        summary: `Updated ${changes.join(', ')}`,
        metadataJson: JSON.stringify({ changedFields: changes }),
      },
    });
    return updated;
  });
}

// Note editing/deletion — informational, so (like adding a note or a
// contact) these aren't gated by lib/workflow-policy.ts's status transition
// matrix.
export async function updateNoteWorkflow(prisma: WorkflowPrisma, noteId: string, payload: NoteUpdatePayload) {
  const existing = await prisma.note.findUnique({ where: { id: noteId } });
  if (!existing) throw new Error('Note not found');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.note.update({
      where: { id: noteId },
      data: { category: payload.category ?? existing.category, content: payload.content },
    });
    await tx.activity.create({
      data: { applicationId: existing.applicationId, eventType: 'Note edited', summary: 'Edited note' },
    });
    return updated;
  });
}

export async function deleteNoteWorkflow(prisma: WorkflowPrisma, noteId: string) {
  const existing = await prisma.note.findUnique({ where: { id: noteId } });
  if (!existing) throw new Error('Note not found');

  return prisma.$transaction(async (tx) => {
    await tx.note.delete({ where: { id: noteId } });
    await tx.activity.create({
      data: { applicationId: existing.applicationId, eventType: 'Note deleted', summary: 'Deleted note' },
    });
    return existing;
  });
}

// ApplicationLink CRUD — supplementary reference links (company site, role
// research, interview prep, recruiter contact info, etc), distinct from the
// two primary applicationUrl/candidatePortalUrl fields on Application itself.
export async function createLinkWorkflow(prisma: WorkflowPrisma, payload: LinkCreatePayload) {
  const application = await prisma.application.findUnique({ where: { id: payload.applicationId } });
  if (!application) throw new Error('Application not found');

  return prisma.$transaction(async (tx) => {
    const created = await tx.applicationLink.create({
      data: {
        applicationId: payload.applicationId,
        label: payload.label,
        url: payload.url,
        category: payload.category ?? null,
        notes: payload.notes ?? null,
      },
    });
    await tx.activity.create({
      data: { applicationId: payload.applicationId, eventType: 'Link added', summary: `Added link: ${payload.label}` },
    });
    return created;
  });
}

export async function updateLinkWorkflow(prisma: WorkflowPrisma, linkId: string, payload: LinkUpdatePayload) {
  const existing = await prisma.applicationLink.findUnique({ where: { id: linkId } });
  if (!existing) throw new Error('Link not found');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.applicationLink.update({
      where: { id: linkId },
      data: {
        label: payload.label ?? undefined,
        url: payload.url ?? undefined,
        category: 'category' in payload ? payload.category ?? null : undefined,
        notes: 'notes' in payload ? payload.notes ?? null : undefined,
      },
    });
    await tx.activity.create({
      data: { applicationId: existing.applicationId, eventType: 'Link edited', summary: `Edited link: ${updated.label}` },
    });
    return updated;
  });
}

export async function deleteLinkWorkflow(prisma: WorkflowPrisma, linkId: string) {
  const existing = await prisma.applicationLink.findUnique({ where: { id: linkId } });
  if (!existing) throw new Error('Link not found');

  return prisma.$transaction(async (tx) => {
    await tx.applicationLink.delete({ where: { id: linkId } });
    await tx.activity.create({
      data: { applicationId: existing.applicationId, eventType: 'Link deleted', summary: `Deleted link: ${existing.label}` },
    });
    return existing;
  });
}
