import { z } from 'zod';
import { isDateOnlyString, isParseableDate } from '@/lib/dates';

const emptyToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

// datetime-local values (and other real timestamps) — accepts anything that
// parses to a valid instant, e.g. "2026-08-15T14:00" from an
// `<input type="datetime-local">`, or a full ISO timestamp.
const optionalDateTimeString = () =>
  z.preprocess(emptyToUndefined, z.string().trim().refine(isParseableDate, 'Valid date required').optional());

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

export const applicationCreateSchema = z.object({
  company: z.string().trim().min(1, 'Company is required'),
  role: z.string().trim().min(1, 'Role is required'),
  applicationUrl: requiredUrlString('applicationUrl is required'),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  status: z.enum(['Not Applied', 'Preparing', 'Applied', 'OA', 'Recruiter Screen', 'Technical Interview', 'Final Round', 'Offer', 'Accepted', 'Rejected', 'Withdrawn', 'Closed']).optional(),
  currentStage: z.string().optional(),
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
  scheduledStart: requiredDateTimeString('scheduledStart is required'),
  scheduledEnd: optionalDateTimeString().nullable(),
  timezone: z.string().optional().nullable(),
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
export type WorkflowPayload = z.infer<typeof workflowPayloadSchema>;
