import { z } from 'zod';

const isValidDate = (value: string) => !Number.isNaN(new Date(value).getTime());

const emptyToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const optionalDateString = () =>
  z.preprocess(emptyToUndefined, z.string().trim().refine(isValidDate, 'Valid date required').optional());

const requiredDateString = (message: string) =>
  optionalDateString().refine((value): value is string => value !== undefined, message);

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
  applicationDeadline: optionalDateString().nullable(),
  dateFound: optionalDateString().nullable(),
  notes: z.string().optional(),
});

const interviewStageSchema = z.enum(['Recruiter Screen', 'Technical Interview', 'Final Round']);

const applySchema = z.object({
  action: z.literal('apply'),
  resumeVersionId: z.string().trim().min(1, 'Resume is required'),
  dateApplied: optionalDateString(),
  emailUsed: z.string().optional(),
  coverLetterStatus: z.string().optional(),
  notes: z.string().optional(),
  nextActionDue: optionalDateString(),
});

const oaReceivedSchema = z.object({
  action: z.literal('oaReceived'),
  receivedAt: optionalDateString(),
  dueAt: requiredDateString('dueAt is required'),
  platform: z.string().optional(),
  durationMinutes: z.coerce.number().int().positive().optional(),
  questionCount: z.coerce.number().int().positive().optional(),
  topics: z.string().optional(),
  notes: z.string().optional(),
  nextActionDue: optionalDateString(),
});

const oaCompletedSchema = z.object({
  action: z.literal('oaCompleted'),
  assessmentId: z.string().trim().min(1, 'assessmentId is required'),
  completedAt: optionalDateString(),
  difficulty: z.string().optional(),
  confidence: z.string().optional(),
  result: z.string().optional(),
  encounteredQuestions: z.string().optional(),
  topics: z.string().optional(),
  notes: z.string().optional(),
});

const interviewReceivedSchema = z.object({
  action: z.literal('interviewReceived'),
  stage: interviewStageSchema,
  scheduledStart: requiredDateString('scheduledStart is required'),
  scheduledEnd: optionalDateString().nullable(),
  timezone: z.string().optional().nullable(),
  format: z.string().optional().nullable(),
  durationMinutes: z.coerce.number().int().positive().optional(),
  location: z.string().optional().nullable(),
  meetingUrl: optionalUrlString().nullable(),
  recruiter: z.string().optional().nullable(),
  interviewer: z.string().optional().nullable(),
  notes: z.string().optional(),
});

const interviewCompletedSchema = z.object({
  action: z.literal('interviewCompleted'),
  interviewId: z.string().trim().min(1, 'interviewId is required'),
  stage: interviewStageSchema.optional(),
  completedAt: optionalDateString(),
  result: z.string().optional(),
  questions: z.string().optional(),
  whatWentWell: z.string().optional(),
  improvements: z.string().optional(),
  notes: z.string().optional(),
  followUpDate: optionalDateString(),
});

const rejectSchema = z.object({
  action: z.literal('reject'),
  rejectionReason: z.string().optional(),
  notes: z.string().optional(),
});

const offerSchema = z.object({
  action: z.literal('offer'),
  offerDate: optionalDateString(),
  decisionDeadline: requiredDateString('decisionDeadline is required'),
  compensationSummary: z.string().optional(),
  notes: z.string().optional(),
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
  notes: z.string().optional(),
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
