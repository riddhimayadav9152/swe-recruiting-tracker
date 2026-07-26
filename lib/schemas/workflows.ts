import { z } from 'zod';

export const applicationCreateSchema = z.object({
  company: z.string().trim().min(1),
  role: z.string().trim().min(1),
  applicationUrl: z.string().trim().url().or(z.string().trim().min(1)),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  status: z.enum(['Not Applied', 'Preparing', 'Applied', 'OA', 'Recruiter Screen', 'Technical Interview', 'Final Round', 'Offer', 'Accepted', 'Rejected', 'Withdrawn', 'Closed']).optional(),
  currentStage: z.string().optional(),
  location: z.string().optional(),
  applicationDeadline: z.string().optional().nullable(),
  dateFound: z.string().optional().nullable(),
  notes: z.string().optional(),
});

const interviewStageSchema = z.enum(['Recruiter Screen', 'Technical Interview', 'Final Round']);

const applySchema = z.object({
  action: z.literal('apply'),
  resumeVersionId: z.string().optional(),
  dateApplied: z.string().optional(),
  emailUsed: z.string().optional(),
  coverLetterStatus: z.string().optional(),
  notes: z.string().optional(),
  nextActionDue: z.string().optional(),
});

const oaReceivedSchema = z.object({
  action: z.literal('oaReceived'),
  receivedAt: z.string().optional(),
  dueAt: z.string().optional(),
  platform: z.string().optional(),
  durationMinutes: z.coerce.number().int().positive().optional(),
  questionCount: z.coerce.number().int().positive().optional(),
  topics: z.string().optional(),
  notes: z.string().optional(),
  nextActionDue: z.string().optional(),
});

const oaCompletedSchema = z.object({
  action: z.literal('oaCompleted'),
  completedAt: z.string().optional(),
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
  scheduledStart: z.string().min(1, 'scheduledStart is required'),
  scheduledEnd: z.string().optional().nullable(),
  timezone: z.string().optional().nullable(),
  format: z.string().optional().nullable(),
  durationMinutes: z.coerce.number().int().positive().optional(),
  location: z.string().optional().nullable(),
  meetingUrl: z.string().optional().nullable(),
  recruiter: z.string().optional().nullable(),
  interviewer: z.string().optional().nullable(),
  notes: z.string().optional(),
});

const interviewCompletedSchema = z.object({
  action: z.literal('interviewCompleted'),
  stage: interviewStageSchema.optional(),
  completedAt: z.string().optional(),
  result: z.string().optional(),
  notes: z.string().optional(),
});

const rejectSchema = z.object({
  action: z.literal('reject'),
  rejectionReason: z.string().optional(),
  notes: z.string().optional(),
});

const offerSchema = z.object({
  action: z.literal('offer'),
  offerDate: z.string().optional(),
  decisionDeadline: z.string().optional(),
  compensationSummary: z.string().optional(),
  notes: z.string().optional(),
});

const noteSchema = z.object({
  action: z.literal('note'),
  category: z.string().optional(),
  content: z.string().optional(),
});

const contactSchema = z.object({
  action: z.literal('contact'),
  name: z.string().optional(),
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
