import { z } from 'zod';
import { isDateOnlyString, isDateTimeLocalString, isValidIanaTimeZone } from '@/lib/dates';

const emptyToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

// datetime-local values (and other real timestamps) — accepts a
// "2026-08-15T14:00"-shaped value (or a full ISO timestamp) whose date and
// time components are all real, e.g. rejects "2026-02-31T10:00".
const optionalDateTimeString = () =>
  z.preprocess(emptyToUndefined, z.string().trim().refine(isDateTimeLocalString, 'Enter a valid date and time').optional());

const requiredDateTimeString = (message: string) =>
  optionalDateTimeString().refine((value): value is string => value !== undefined, message);

// date-only values — must be the bare "YYYY-MM-DD" shape an
// `<input type="date">` actually emits, so a datetime-local string can never
// be silently accepted where a date-only value is expected. Parse these
// with `parseDateOnly` and display them with `formatDateOnly` (see lib/dates.ts).
const optionalDateOnlyString = () =>
  z.preprocess(emptyToUndefined, z.string().trim().refine(isDateOnlyString, 'Enter a valid date (YYYY-MM-DD)').optional());

const requiredDateOnlyString = (message: string) =>
  optionalDateOnlyString().refine((value): value is string => value !== undefined, message);

const optionalUrlString = () =>
  z.preprocess(emptyToUndefined, z.string().trim().url('Enter a valid URL').optional());

const requiredUrlString = (message: string) =>
  optionalUrlString().refine((value): value is string => value !== undefined, message);

const requiredIanaTimeZone = (message: string) =>
  z.string().trim().refine(isValidIanaTimeZone, message);

// The standard "New Opportunity" form can only create an application that
// hasn't been submitted yet — everything past that (Applied, OA, interview
// stages, Offer, ...) is reached exclusively through the matching workflow
// action (see lib/workflow-policy.ts), which keeps status and currentStage
// consistent (e.g. it's impossible to end up with Status: Applied and
// Stage: Discovered). A future, separately-validated import pathway can
// relax this later; this endpoint intentionally does not.
// currentStage is deliberately NOT a field here — it's always derived from
// `status` (see deriveInitialStage in lib/recruiting.ts), never accepted
// from the client. Zod strips unknown keys by default, so a client that
// still sends currentStage has it silently ignored rather than honored.
export const applicationCreateSchema = z.object({
  company: z.string().trim().min(1, 'Company is required'),
  role: z.string().trim().min(1, 'Role is required'),
  applicationUrl: requiredUrlString('applicationUrl is required'),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  status: z.enum(['Not Applied', 'Preparing']).optional(),
  location: z.string().optional(),
  applicationDeadline: optionalDateOnlyString().nullable(),
  dateFound: optionalDateOnlyString().nullable(),
  notes: z.string().optional(),
});

const interviewStageSchema = z.enum(['Recruiter Screen', 'Technical Interview', 'Final Round']);

const applySchema = z.object({
  action: z.literal('apply'),
  resumeVersionId: z.string().trim().min(1, 'Resume is required'),
  dateApplied: optionalDateOnlyString(),
  emailUsed: z.string().optional(),
  coverLetterStatus: z.string().optional(),
  notes: z.string().optional(),
  nextActionDue: optionalDateTimeString(),
  override: z.boolean().optional(),
});

const oaReceivedSchema = z.object({
  action: z.literal('oaReceived'),
  receivedAt: optionalDateTimeString(),
  dueAt: requiredDateTimeString('dueAt is required'),
  // dueAt/receivedAt are wall-clock times with no timezone of their own —
  // timezone is what tells us which instant that actually is (see
  // parseZonedDateTime in lib/dates.ts), same as an interview's
  // scheduledStart/scheduledEnd.
  timezone: requiredIanaTimeZone('A valid IANA timezone is required'),
  platform: z.string().optional(),
  durationMinutes: z.coerce.number().int().positive().optional(),
  questionCount: z.coerce.number().int().positive().optional(),
  topics: z.string().optional(),
  notes: z.string().optional(),
  nextActionDue: optionalDateTimeString(),
  override: z.boolean().optional(),
});

const oaCompletedSchema = z.object({
  action: z.literal('oaCompleted'),
  assessmentId: z.string().trim().min(1, 'assessmentId is required'),
  completedAt: optionalDateTimeString(),
  difficulty: z.string().optional(),
  confidence: z.string().optional(),
  result: z.string().optional(),
  encounteredQuestions: z.string().optional(),
  topics: z.string().optional(),
  notes: z.string().optional(),
  override: z.boolean().optional(),
});

const interviewReceivedSchema = z.object({
  action: z.literal('interviewReceived'),
  stage: interviewStageSchema,
  // scheduledStart/scheduledEnd are wall-clock times ("2026-08-15T14:00")
  // with no timezone of their own — timezone is what tells us which instant
  // that actually is (see parseZonedDateTime in lib/dates.ts), so it's
  // required, not an afterthought.
  scheduledStart: requiredDateTimeString('scheduledStart is required'),
  scheduledEnd: optionalDateTimeString().nullable(),
  timezone: requiredIanaTimeZone('A valid IANA timezone is required'),
  format: z.string().optional().nullable(),
  durationMinutes: z.coerce.number().int().positive().optional(),
  location: z.string().optional().nullable(),
  meetingUrl: optionalUrlString().nullable(),
  recruiter: z.string().optional().nullable(),
  interviewer: z.string().optional().nullable(),
  notes: z.string().optional(),
  override: z.boolean().optional(),
});

const interviewCompletedSchema = z.object({
  action: z.literal('interviewCompleted'),
  interviewId: z.string().trim().min(1, 'interviewId is required'),
  stage: interviewStageSchema.optional(),
  completedAt: optionalDateTimeString(),
  result: z.string().optional(),
  questions: z.string().optional(),
  whatWentWell: z.string().optional(),
  improvements: z.string().optional(),
  notes: z.string().optional(),
  followUpDate: optionalDateOnlyString(),
  override: z.boolean().optional(),
});

const rejectSchema = z.object({
  action: z.literal('reject'),
  rejectionReason: z.string().optional(),
  notes: z.string().optional(),
  override: z.boolean().optional(),
});

const offerSchema = z.object({
  action: z.literal('offer'),
  offerDate: optionalDateOnlyString(),
  decisionDeadline: requiredDateOnlyString('decisionDeadline is required'),
  compensationSummary: z.string().optional(),
  notes: z.string().optional(),
  override: z.boolean().optional(),
});

const noteSchema = z.object({
  action: z.literal('note'),
  category: z.string().optional(),
  content: z.string().trim().min(1, 'content is required'),
});

const contactSchema = z.object({
  action: z.literal('contact'),
  name: z.string().trim().min(1, 'name is required'),
  title: z.string().optional(),
  email: z.string().optional(),
  relationship: z.string().optional(),
  referralStatus: z.string().optional(),
  notes: z.string().optional(),
  nextFollowUp: optionalDateOnlyString(),
});

const setApplicationDateSchema = z.object({
  action: z.literal('setApplicationDate'),
  dateApplied: requiredDateOnlyString('dateApplied is required'),
  // Normally, submission evidence (a post-submission status or an
  // "Application submitted" activity entry — see hasSubmittedApplication in
  // lib/workflow-policy.ts) is what justifies repairing a missing date. An
  // ordinary Not Applied/Preparing record has neither and must be rejected.
  // This flag is a narrow, explicit escape hatch for the one case that
  // doesn't: a bulk import that intentionally created a pre-submission
  // record needing a backdated application date with no activity trail yet.
  // It must be set deliberately by that caller — the UI's own "Set
  // Application Date" button never sends it.
  confirmImportRepair: z.boolean().optional(),
});

const descriptionSchema = z.object({
  action: z.literal('description'),
  fullText: z.string().optional(),
  minimumQualifications: z.string().optional(),
  preferredQualifications: z.string().optional(),
  keywords: z.string().optional(),
});

export const workflowPayloadSchema = z.discriminatedUnion('action', [
  applySchema,
  oaReceivedSchema,
  oaCompletedSchema,
  interviewReceivedSchema,
  interviewCompletedSchema,
  rejectSchema,
  offerSchema,
  noteSchema,
  contactSchema,
  descriptionSchema,
  setApplicationDateSchema,
]);

export type ApplyPayload = z.infer<typeof applySchema>;
export type OaReceivedPayload = z.infer<typeof oaReceivedSchema>;
export type OaCompletedPayload = z.infer<typeof oaCompletedSchema>;
export type InterviewReceivedPayload = z.infer<typeof interviewReceivedSchema>;
export type InterviewCompletedPayload = z.infer<typeof interviewCompletedSchema>;
export type RejectPayload = z.infer<typeof rejectSchema>;
export type OfferPayload = z.infer<typeof offerSchema>;
export type NotePayload = z.infer<typeof noteSchema>;
export type ContactPayload = z.infer<typeof contactSchema>;
export type DescriptionPayload = z.infer<typeof descriptionSchema>;
export type SetApplicationDatePayload = z.infer<typeof setApplicationDateSchema>;
export type WorkflowPayload = z.infer<typeof workflowPayloadSchema>;
