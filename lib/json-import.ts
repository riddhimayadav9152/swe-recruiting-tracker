import { z } from 'zod';
import type { Prisma, PrismaClient } from '@prisma/client';
import { addUtcDays, isDateOnlyString, isDateTimeLocalString, parseDateOnly, parseDateTimeLocal, utcToday } from '@/lib/dates';
import {
  computePersonalApplyByDate, deriveInitialStage, generateApplicationCode, generateNextAction,
  personalDateBeforeOfficialDate, postingStatuses, priorities, statuses, TERMINAL_STATUSES, type ApplicationStatus,
} from '@/lib/recruiting';
import { findDuplicateApplication, isUniqueConstraintError, type DuplicateMatchCandidate } from '@/lib/import';
import { linkCategories } from '@/lib/schemas/workflows';

// --- Direct structured application import ("Paste Application Import") ------
//
// A SEPARATE, additive pathway from both the manually-reviewed single-sheet
// xlsx importer (lib/import.ts) and the full-workbook restore
// (lib/multi-sheet-import.ts) — this one takes a versioned JSON document
// (see JSON_IMPORT_FORMAT_VERSION) describing one or more applications,
// meant for pasting in an application recommendation (e.g. from ChatGPT)
// rather than reviewing a spreadsheet row by row. Still follows this app's
// established import conventions: strict validation, preview before write,
// duplicate detection (URL first, then normalized company+role), Create/
// Update/Skip per row, a database backup before any commit, and one
// transaction for the whole batch.

export const JSON_IMPORT_FORMAT_VERSION = 'swe-recruiting-tracker.application-import.v1';

const nullableString = () => z.string().nullable().optional().transform((v) => v ?? null);

const nullableDateOnly = (message: string) =>
  z.string().nullable().optional().transform((v) => v ?? null).refine((v) => v === null || isDateOnlyString(v), message);

const nullableTimestamp = (message: string) =>
  z.string().nullable().optional().transform((v) => v ?? null).refine((v) => v === null || isDateTimeLocalString(v), message);

const linkImportSchema = z.object({
  label: z.string().trim().min(1, 'label is required'),
  url: z.string().trim().url('url must be a valid URL'),
  category: z.enum(linkCategories).nullable().optional().transform((v) => v ?? null),
  notes: nullableString(),
});

const jsonImportClearableFields = [
  'jobId',
  'candidatePortalUrl',
  'postingStatus',
  'location',
  'workModel',
  'postingDate',
  'applicationDeadline',
  'dateFound',
  'nextAction',
  'nextActionDue',
  'loginEmail',
  'portalUsername',
  'passwordManagerReference',
  'confirmationNumber',
  'compensationSummary',
  'eligibility',
  'sponsorship',
  'whyFit',
  'lastVerifiedAt',
  'notes',
] as const;

type JsonImportClearableField = (typeof jsonImportClearableFields)[number];

export const applicationImportSchema = z.object({
  company: z.string().trim().min(1, 'company is required'),
  role: z.string().trim().min(1, 'role is required'),
  jobId: nullableString(),
  applicationUrl: z.string().trim().url('applicationUrl must be a valid URL'),
  candidatePortalUrl: z.string().trim().url('candidatePortalUrl must be a valid URL').nullable().optional().transform((v) => v ?? null),
  priority: z.enum(priorities, { errorMap: () => ({ message: `priority must be one of ${priorities.join(', ')}` }) }),
  status: z.enum(statuses, { errorMap: () => ({ message: `status must be one of ${statuses.join(', ')}` }) }),
  postingStatus: z.enum(postingStatuses).nullable().optional().transform((v) => v ?? null),
  location: nullableString(),
  workModel: nullableString(),
  postingDate: nullableDateOnly('postingDate must be a real calendar date (YYYY-MM-DD)'),
  applicationDeadline: nullableDateOnly('applicationDeadline must be a real calendar date (YYYY-MM-DD)'),
  dateFound: nullableDateOnly('dateFound must be a real calendar date (YYYY-MM-DD)'),
  nextAction: nullableString(),
  nextActionDue: z.string().nullable().optional().transform((v) => v ?? null),
  nextActionDueKind: z.enum(['date', 'timestamp']).nullable().optional().transform((v) => v ?? null),
  loginEmail: nullableString(),
  portalUsername: nullableString(),
  passwordManagerReference: nullableString(),
  confirmationNumber: nullableString(),
  compensationSummary: nullableString(),
  eligibility: nullableString(),
  sponsorship: nullableString(),
  whyFit: nullableString(),
  lastVerifiedAt: nullableTimestamp('lastVerifiedAt must be a real timestamp'),
  notes: nullableString(),
  links: z.array(linkImportSchema).optional().default([]),
  clearFields: z.array(z.enum(jsonImportClearableFields)).optional().default([]),
}).superRefine((data, ctx) => {
  if (!data.nextActionDue) return;
  const kind = data.nextActionDueKind ?? 'date';
  const valid = kind === 'date' ? isDateOnlyString(data.nextActionDue) : isDateTimeLocalString(data.nextActionDue);
  if (!valid) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nextActionDue'], message: `nextActionDue does not match its declared kind "${kind}"` });
  }
});

export type ApplicationImportRow = z.infer<typeof applicationImportSchema>;

export type FieldValidationError = { field: string; message: string };

export type JsonImportRowPreview = {
  index: number;
  status: 'valid' | 'invalid';
  data: ApplicationImportRow | null;
  fieldPresence: JsonImportFieldPresence | null;
  errors: FieldValidationError[];
  duplicate: { source: 'database'; applicationId: string; matchedOn: string } | { source: 'batch'; index: number; matchedOn: string } | null;
  suggestedAction: 'create' | 'update' | 'skip' | 'error';
  /** What nextActionDue/Kind WOULD be written if this row's own nextActionDue is left blank — computed from the personal-deadline rules (see lib/recruiting.ts), for the user to see before confirming. */
  generatedNextActionDue: { value: string; kind: 'date' | 'timestamp' } | null;
};

export type JsonImportPreviewResult =
  | { ok: true; rows: JsonImportRowPreview[] }
  | { ok: false; error: string };

/**
 * Validates the outer document shape (format version + applications array)
 * FIRST, before ever looking at individual rows — an unsupported or missing
 * format version is a hard, whole-document rejection, not a per-row error.
 */
function validateDocumentShape(raw: unknown): { ok: true; applications: unknown[] } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Invalid JSON: expected an object with "format" and "applications" fields.' };
  }
  const format = (raw as Record<string, unknown>).format;
  if (format !== JSON_IMPORT_FORMAT_VERSION) {
    return { ok: false, error: `Unsupported or missing format version (expected "${JSON_IMPORT_FORMAT_VERSION}", got ${JSON.stringify(format ?? null)}).` };
  }
  const applications = (raw as Record<string, unknown>).applications;
  if (!Array.isArray(applications) || applications.length === 0) {
    return { ok: false, error: '"applications" must be a non-empty array.' };
  }
  return { ok: true, applications };
}

const normalizeKey = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

const isWorkflowProtectedStatus = (status: string): boolean =>
  !['Not Applied', 'Preparing'].includes(status);

const hasOwn = (value: unknown, key: string): boolean =>
  typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key);

export type JsonImportFieldPresence = Partial<Record<keyof ApplicationImportRow, boolean>>;

const jsonImportTopLevelFields = [
  'company',
  'role',
  'jobId',
  'applicationUrl',
  'candidatePortalUrl',
  'priority',
  'status',
  'postingStatus',
  'location',
  'workModel',
  'postingDate',
  'applicationDeadline',
  'dateFound',
  'nextAction',
  'nextActionDue',
  'nextActionDueKind',
  'loginEmail',
  'portalUsername',
  'passwordManagerReference',
  'confirmationNumber',
  'compensationSummary',
  'eligibility',
  'sponsorship',
  'whyFit',
  'lastVerifiedAt',
  'notes',
  'links',
  'clearFields',
] satisfies Array<keyof ApplicationImportRow>;

const buildJsonImportFieldPresence = (rawRow: unknown): JsonImportFieldPresence => {
  const presence: JsonImportFieldPresence = {};
  for (const field of jsonImportTopLevelFields) {
    presence[field] = hasOwn(rawRow, field);
  }
  return presence;
};

const deriveJsonImportDeadline = (
  data: ApplicationImportRow,
  status: ApplicationStatus,
  applicationDeadline: Date | null,
): { nextActionDue: Date | null; nextActionDueKind: 'date' | 'timestamp' } => {
  if (data.nextActionDue) {
    const nextActionDueKind = data.nextActionDueKind ?? 'date';
    return {
      nextActionDue: nextActionDueKind === 'date' ? parseDateOnly(data.nextActionDue) : parseDateTimeLocal(data.nextActionDue),
      nextActionDueKind,
    };
  }

  if (status === 'Not Applied' || status === 'Preparing') {
    return {
      nextActionDue: computePersonalApplyByDate({
        priority: data.priority,
        dateFound: data.dateFound ? parseDateOnly(data.dateFound) : null,
        applicationDeadline,
        postingStatus: data.postingStatus,
        postingDate: data.postingDate ? parseDateOnly(data.postingDate) : null,
      }),
      nextActionDueKind: 'date',
    };
  }

  if (status === 'Applied') {
    return { nextActionDue: addUtcDays(utcToday(), 7), nextActionDueKind: 'date' };
  }

  if (status === 'Offer' && applicationDeadline) {
    return { nextActionDue: personalDateBeforeOfficialDate(applicationDeadline, 2), nextActionDueKind: 'date' };
  }

  if ((TERMINAL_STATUSES as readonly string[]).includes(status)) {
    return { nextActionDue: null, nextActionDueKind: 'date' };
  }

  return { nextActionDue: null, nextActionDueKind: 'date' };
};

export function previewJsonImport(raw: unknown, existingApplications: DuplicateMatchCandidate[]): JsonImportPreviewResult {
  const shape = validateDocumentShape(raw);
  if (!shape.ok) return shape;

  const rows: JsonImportRowPreview[] = [];
  const seenInBatch: Array<{ index: number; company: string; role: string; applicationUrl: string }> = [];

  shape.applications.forEach((rawRow, index) => {
    const parsed = applicationImportSchema.safeParse(rawRow);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((issue) => ({ field: issue.path.join('.') || '(root)', message: issue.message }));
      rows.push({ index, status: 'invalid', data: null, fieldPresence: null, errors, duplicate: null, suggestedAction: 'error', generatedNextActionDue: null });
      return;
    }

    const data = parsed.data;
    const fieldPresence = buildJsonImportFieldPresence(rawRow);
    const company = normalizeKey(data.company);
    const role = normalizeKey(data.role);
    const url = normalizeKey(data.applicationUrl);

    let duplicate: JsonImportRowPreview['duplicate'] = null;
    const dbMatch = findDuplicateApplication(data.company, data.role, data.applicationUrl, existingApplications);
    if (dbMatch) {
      const matchedOn = dbMatch.applicationUrl && normalizeKey(dbMatch.applicationUrl) === url ? 'applicationUrl' : 'company+role';
      duplicate = { source: 'database', applicationId: dbMatch.id, matchedOn };
    } else {
      const batchMatch = seenInBatch.find((seen) => seen.applicationUrl === url || (seen.company === company && seen.role === role));
      if (batchMatch) {
        const matchedOn = batchMatch.applicationUrl === url ? 'applicationUrl' : 'company+role';
        duplicate = { source: 'batch', index: batchMatch.index, matchedOn };
      }
    }
    seenInBatch.push({ index, company, role, applicationUrl: url });

    let generatedNextActionDue: JsonImportRowPreview['generatedNextActionDue'] = null;
    if (!data.nextActionDue && (data.status === 'Not Applied' || data.status === 'Preparing')) {
      const generated = computePersonalApplyByDate({
        priority: data.priority,
        dateFound: data.dateFound ? parseDateOnly(data.dateFound) : null,
        applicationDeadline: data.applicationDeadline ? parseDateOnly(data.applicationDeadline) : null,
        postingStatus: data.postingStatus,
        postingDate: data.postingDate ? parseDateOnly(data.postingDate) : null,
      });
      generatedNextActionDue = { value: generated.toISOString().slice(0, 10), kind: 'date' };
    }

    rows.push({
      index,
      status: 'valid',
      data,
      fieldPresence,
      errors: [],
      duplicate,
      suggestedAction: duplicate ? 'skip' : 'create',
      generatedNextActionDue,
    });
  });

  return { ok: true, rows };
}

export type JsonImportRowDecision = {
  index: number;
  action: 'create' | 'update' | 'skip';
  data: unknown;
  fieldPresence?: JsonImportFieldPresence | null;
  matchedApplicationId?: string | null;
};

export type JsonImportRowOutcome =
  | { index: number; ok: true; action: 'create' | 'update'; applicationId: string }
  | { index: number; ok: true; action: 'skip' }
  | { index: number; ok: false; errors: string[] };

export type JsonImportCommitSummary = {
  created: number;
  updated: number;
  skipped: number;
  outcomes: JsonImportRowOutcome[];
};

type ImportDbClient = Prisma.TransactionClient | PrismaClient;

async function writeJsonImportRow(
  tx: ImportDbClient,
  decision: JsonImportRowDecision,
  existingCodes: string[],
): Promise<{ applicationId: string; action: 'create' | 'update' }> {
  const revalidated = applicationImportSchema.safeParse(decision.data);
  if (!revalidated.success) {
    throw new Error(`Row ${decision.index}: ${revalidated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const data = revalidated.data;
  const status = data.status as ApplicationStatus;
  const currentStage = deriveInitialStage(status);
  const dateFound = data.dateFound ? parseDateOnly(data.dateFound) : null;
  const applicationDeadline = data.applicationDeadline ? parseDateOnly(data.applicationDeadline) : null;

  const { nextActionDue, nextActionDueKind } = deriveJsonImportDeadline(data, status, applicationDeadline);

  const applicationData = {
    company: data.company,
    role: data.role,
    jobId: data.jobId,
    applicationUrl: data.applicationUrl,
    candidatePortalUrl: data.candidatePortalUrl,
    priority: data.priority,
    status,
    currentStage,
    postingStatus: data.postingStatus,
    location: data.location,
    workModel: data.workModel,
    postingDate: data.postingDate ? parseDateOnly(data.postingDate) : null,
    applicationDeadline,
    dateFound,
    nextAction: data.nextAction ?? generateNextAction(status, currentStage),
    nextActionDue,
    nextActionDueKind,
    emailUsed: data.loginEmail,
    portalUsername: data.portalUsername,
    passwordManagerReference: data.passwordManagerReference,
    confirmationNumber: data.confirmationNumber,
    compensationSummary: data.compensationSummary,
    eligibility: data.eligibility,
    sponsorship: data.sponsorship,
    whyFit: data.whyFit,
    lastVerifiedAt: data.lastVerifiedAt ? parseDateTimeLocal(data.lastVerifiedAt) : null,
    notes: data.notes,
  };

  if (decision.action === 'update') {
    if (!decision.matchedApplicationId) throw new Error(`Row ${decision.index}: no matching existing application to update`);
    const current = await tx.application.findUnique({
      where: { id: decision.matchedApplicationId },
      select: { id: true, company: true, role: true, applicationUrl: true, status: true },
    });
    if (!current) throw new Error(`Row ${decision.index}: the matched application no longer exists`);
    const sameUrl = current.applicationUrl && normalizeKey(current.applicationUrl) === normalizeKey(data.applicationUrl);
    const sameCompanyRole = normalizeKey(current.company) === normalizeKey(data.company) && normalizeKey(current.role) === normalizeKey(data.role);
    if (!sameUrl && !sameCompanyRole) throw new Error(`Row ${decision.index}: the matched application no longer matches this row — it may have changed since preview`);

    const fieldPresence = decision.fieldPresence;
    if (!fieldPresence) throw new Error(`Row ${decision.index}: update decisions must include fieldPresence from preview; re-run preview and try again`);
    const workflowProtectedExisting = isWorkflowProtectedStatus(current.status);
    const updateData: Prisma.ApplicationUpdateInput = {};
    const fieldWasSupplied = (field: keyof ApplicationImportRow) => fieldPresence[field] === true;
    const explicitClears = new Set<JsonImportClearableField>(data.clearFields);
    const fieldWasExplicitlyCleared = (field: keyof ApplicationImportRow): field is JsonImportClearableField =>
      (jsonImportClearableFields as readonly string[]).includes(field) && explicitClears.has(field as JsonImportClearableField);
    const maybeSet = <K extends keyof Prisma.ApplicationUpdateInput>(rawKey: keyof ApplicationImportRow, dbKey: K, value: Prisma.ApplicationUpdateInput[K]) => {
      if (fieldWasExplicitlyCleared(rawKey)) {
        updateData[dbKey] = null as Prisma.ApplicationUpdateInput[K];
        return;
      }
      if (!fieldWasSupplied(rawKey)) return;
      if (value === null || value === undefined) return;
      updateData[dbKey] = value;
    };

    maybeSet('company', 'company', data.company);
    maybeSet('role', 'role', data.role);
    maybeSet('jobId', 'jobId', data.jobId);
    maybeSet('applicationUrl', 'applicationUrl', data.applicationUrl);
    maybeSet('candidatePortalUrl', 'candidatePortalUrl', data.candidatePortalUrl);
    maybeSet('priority', 'priority', data.priority);
    maybeSet('postingStatus', 'postingStatus', data.postingStatus);
    maybeSet('location', 'location', data.location);
    maybeSet('workModel', 'workModel', data.workModel);
    maybeSet('postingDate', 'postingDate', data.postingDate ? parseDateOnly(data.postingDate) : null);
    maybeSet('applicationDeadline', 'applicationDeadline', applicationDeadline);
    maybeSet('dateFound', 'dateFound', dateFound);
    maybeSet('loginEmail', 'emailUsed', data.loginEmail);
    maybeSet('portalUsername', 'portalUsername', data.portalUsername);
    maybeSet('passwordManagerReference', 'passwordManagerReference', data.passwordManagerReference);
    maybeSet('confirmationNumber', 'confirmationNumber', data.confirmationNumber);
    maybeSet('compensationSummary', 'compensationSummary', data.compensationSummary);
    maybeSet('eligibility', 'eligibility', data.eligibility);
    maybeSet('sponsorship', 'sponsorship', data.sponsorship);
    maybeSet('whyFit', 'whyFit', data.whyFit);
    maybeSet('lastVerifiedAt', 'lastVerifiedAt', data.lastVerifiedAt ? parseDateTimeLocal(data.lastVerifiedAt) : null);
    maybeSet('notes', 'notes', data.notes);
    if (!workflowProtectedExisting) {
      maybeSet('nextAction', 'nextAction', data.nextAction);
      if (fieldWasExplicitlyCleared('nextActionDue')) {
        updateData.nextActionDue = null;
        updateData.nextActionDueKind = 'date';
      } else if (fieldWasSupplied('nextActionDue') && data.nextActionDue) {
        updateData.nextActionDue = nextActionDue;
        updateData.nextActionDueKind = nextActionDueKind;
      }
    }

    if (Object.keys(updateData).length) {
      await tx.application.update({ where: { id: decision.matchedApplicationId }, data: updateData });
    }

    const existingLinks = await tx.applicationLink.findMany({ where: { applicationId: decision.matchedApplicationId } });
    if (fieldWasSupplied('links')) {
      for (const link of data.links) {
        const matching = existingLinks.find((existingLink) => normalizeKey(existingLink.url) === normalizeKey(link.url));
        if (matching) {
          await tx.applicationLink.update({
            where: { id: matching.id },
            data: { label: link.label, category: link.category, notes: link.notes },
          });
        } else {
          await tx.applicationLink.create({ data: { applicationId: decision.matchedApplicationId, label: link.label, url: link.url, category: link.category, notes: link.notes } });
        }
      }
    }
    await tx.activity.create({
      data: { applicationId: decision.matchedApplicationId, eventType: 'JSON import updated', summary: `Updated ${data.company} — ${data.role} via JSON import`, metadataJson: JSON.stringify({ source: 'json-import' }) },
    });
    return { applicationId: decision.matchedApplicationId, action: 'update' };
  }

  // action === 'create'. Re-check for a duplicate against the CURRENT
  // database (via `tx`, so it also sees earlier rows written in this same
  // batch) — a duplicate may have appeared since preview.
  const currentApplications = await tx.application.findMany({ select: { id: true, company: true, role: true, applicationUrl: true } });
  const duplicate = findDuplicateApplication(data.company, data.role, data.applicationUrl, currentApplications);
  if (duplicate) {
    throw new Error(`Row ${decision.index}: a matching application now exists in the database (created after preview) — re-run preview or choose Update.`);
  }

  const applicationCode = generateApplicationCode(data.company, data.role, new Date(), existingCodes);
  let application;
  try {
    application = await tx.application.create({ data: { applicationCode, ...applicationData } });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const fallbackCode = generateApplicationCode(data.company, data.role, new Date(), [...existingCodes, applicationCode]);
    application = await tx.application.create({ data: { applicationCode: fallbackCode, ...applicationData } });
  }
  existingCodes.push(application.applicationCode);

  for (const link of data.links) {
    await tx.applicationLink.create({ data: { applicationId: application.id, label: link.label, url: link.url, category: link.category, notes: link.notes } });
  }

  await tx.activity.create({
    data: { applicationId: application.id, eventType: 'JSON import created', summary: `Imported ${data.company} — ${data.role} via JSON import`, metadataJson: JSON.stringify({ source: 'json-import' }) },
  });

  return { applicationId: application.id, action: 'create' };
}

/**
 * Commits a batch of JSON-import row decisions in ONE transaction
 * (all-or-nothing) — the caller (see app/api/import/json/commit/route.ts) is
 * responsible for taking a database backup before calling this. Every row's
 * `data` is re-validated here regardless of what preview said (defense in
 * depth against a stale or tampered request), duplicates are re-checked for
 * 'create' rows against the live transaction, and 'update' rows re-verify
 * their matched application still matches.
 */
export async function commitJsonImportBatch(prisma: PrismaClient, rows: JsonImportRowDecision[]): Promise<JsonImportCommitSummary> {
  const summary: JsonImportCommitSummary = { created: 0, updated: 0, skipped: 0, outcomes: [] };

  const existingCodes = (await prisma.application.findMany({ select: { applicationCode: true } })).map((a) => a.applicationCode);

  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      if (row.action === 'skip') {
        summary.skipped += 1;
        summary.outcomes.push({ index: row.index, ok: true, action: 'skip' });
        continue;
      }
      const result = await writeJsonImportRow(tx, row, existingCodes);
      if (result.action === 'update') summary.updated += 1; else summary.created += 1;
      summary.outcomes.push({ index: row.index, ok: true, action: result.action, applicationId: result.applicationId });
    }
  });

  return summary;
}
