import { z } from 'zod';
import * as XLSX from 'xlsx';
import type { PrismaClient } from '@prisma/client';
import { isDateOnlyString, isDateTimeLocalString, isValidIanaTimeZone, parseDateOnly, parseZonedDateTime } from '@/lib/dates';
import { deriveInitialStage, generateApplicationCode, generateNextAction, priorities, statuses, type ApplicationStatus } from '@/lib/recruiting';

// --- Excel date parsing -----------------------------------------------------

const pad2 = (value: number): string => String(value).padStart(2, '0');

const buildDateOnlyString = (year: number, month: number, day: number): string | null => {
  const candidate = `${year}-${pad2(month)}-${pad2(day)}`;
  return isDateOnlyString(candidate) ? candidate : null;
};

/**
 * Normalizes an Excel/spreadsheet cell value into a bare "YYYY-MM-DD"
 * date-only string (or `null` if it isn't a recognizable date) — never a
 * full ISO timestamp. Application Deadline / Date Found columns are
 * calendar dates with no time component, so this must feed directly into
 * `parseDateOnly` (which only accepts that exact shape); converting through
 * a full `Date`/ISO-timestamp round-trip first (as the importer used to)
 * silently fails `parseDateOnly`'s validation and drops the value entirely.
 *
 * Excel serial numbers and JS `Date` objects (what `xlsx` hands back for a
 * date-formatted cell) are read via their UTC calendar fields, since the
 * serial-to-Date conversion below anchors at UTC midnight — reading local
 * fields back out could shift the day depending on the server's timezone.
 */
export const parseExcelDateOnlyValue = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return buildDateOnlyString(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Use SheetJS's own date-code parser (rather than hand-rolled epoch
    // arithmetic) — it correctly accounts for Excel's date-code system
    // (including the spreadsheet-standard 1900 leap-year quirk), and
    // critically, it decomposes the integer (calendar day) and fractional
    // (time-of-day) parts separately, so a serial like 46249.75 (Aug 15,
    // 6:00 PM) resolves to day 15, not day 16. Rounding the raw serial
    // first (`Math.round(46249.75) === 46250`) would wrongly advance the
    // calendar day for any fractional value >= .5 — the time-of-day
    // component must be ignored, not rounded into the date.
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return buildDateOnlyString(parsed.y, parsed.m, parsed.d);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(trimmed);
    if (iso) return buildDateOnlyString(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
    if (slash) return buildDateOnlyString(Number(slash[3]), Number(slash[1]), Number(slash[2]));
    return null;
  }
  return null;
};

/** Same idea as `parseExcelDateOnlyValue`, but preserves a time-of-day component (for datetime-local-shaped fields like an OA/interview schedule) instead of discarding it. */
export const parseExcelDateTimeValue = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getUTCFullYear();
    const m = value.getUTCMonth() + 1;
    const d = value.getUTCDate();
    const candidate = `${y}-${pad2(m)}-${pad2(d)}T${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())}:${pad2(value.getUTCSeconds())}`;
    return isDateTimeLocalString(candidate) ? candidate : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    const candidate = `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}T${pad2(parsed.H)}:${pad2(parsed.M)}:${pad2(Math.floor(parsed.S))}`;
    return isDateTimeLocalString(candidate) ? candidate : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (isDateTimeLocalString(trimmed)) return trimmed;
    const dateOnly = parseExcelDateOnlyValue(trimmed);
    return dateOnly ? `${dateOnly}T00:00:00` : null;
  }
  return null;
};

// --- Workbook parsing --------------------------------------------------------

export type ParsedWorkbook = { sheetNames: string[] };

export const parseWorkbookSheetNames = (buffer: Buffer): ParsedWorkbook => {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return { sheetNames: workbook.SheetNames };
};

export const readWorkbookSheetRows = (buffer: Buffer, sheetName: string): Array<Record<string, unknown>> => {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet) as Array<Record<string, unknown>>;
};

export const detectHeaders = (rows: Array<Record<string, unknown>>): string[] => {
  const headers = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) headers.add(key);
  return Array.from(headers);
};

// --- Column mapping ----------------------------------------------------------

export const IMPORT_TARGET_FIELDS = [
  'company',
  'role',
  'applicationUrl',
  'priority',
  'status',
  'location',
  'applicationDeadline',
  'dateFound',
  'notes',
  'dateApplied',
  'resumeVersionName',
  'assessmentDueAt',
  'assessmentTimezone',
  'assessmentPlatform',
  'interviewScheduledStart',
  'interviewTimezone',
  'offerDecisionDeadline',
  'offerCompensationSummary',
  'outcome',
  'nextAction',
  'nextActionDue',
] as const;

export type ImportTargetField = (typeof IMPORT_TARGET_FIELDS)[number];

export type ColumnMap = Record<ImportTargetField, string | null>;

// Default header aliases used to auto-detect a column mapping from a
// workbook's own header row. The user can always override any of these in
// the preview UI before confirming — this is only a starting guess.
export const IMPORT_FIELD_ALIASES: Record<ImportTargetField, string[]> = {
  company: ['Company', 'company'],
  role: ['Role', 'role'],
  applicationUrl: ['URL', 'url', 'Application URL', 'applicationUrl'],
  priority: ['Priority', 'priority'],
  status: ['Status', 'status'],
  location: ['Location', 'location'],
  applicationDeadline: ['Application Deadline', 'applicationDeadline'],
  dateFound: ['Date Found', 'dateFound'],
  notes: ['Notes', 'notes'],
  dateApplied: ['Date Applied', 'dateApplied'],
  resumeVersionName: ['Resume Version', 'resumeVersion', 'Resume'],
  assessmentDueAt: ['OA Due At', 'Assessment Due At', 'assessmentDueAt'],
  assessmentTimezone: ['OA Timezone', 'Assessment Timezone', 'assessmentTimezone'],
  assessmentPlatform: ['OA Platform', 'Assessment Platform', 'assessmentPlatform'],
  interviewScheduledStart: ['Interview Scheduled Start', 'interviewScheduledStart'],
  interviewTimezone: ['Interview Timezone', 'interviewTimezone'],
  offerDecisionDeadline: ['Decision Deadline', 'offerDecisionDeadline'],
  offerCompensationSummary: ['Compensation', 'offerCompensationSummary'],
  outcome: ['Outcome', 'Rejection Reason', 'outcome'],
  nextAction: ['Next Action', 'nextAction'],
  nextActionDue: ['Next Action Due', 'nextActionDue'],
};

export const autoDetectColumnMap = (headers: string[]): ColumnMap => {
  const map = {} as ColumnMap;
  for (const field of IMPORT_TARGET_FIELDS) {
    const alias = IMPORT_FIELD_ALIASES[field].find((candidate) => headers.includes(candidate));
    map[field] = alias ?? null;
  }
  return map;
};

const readMapped = (row: Record<string, unknown>, columnMap: ColumnMap, field: ImportTargetField): string => {
  const header = columnMap[field];
  if (!header) return '';
  const value = row[header];
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const readMappedRaw = (row: Record<string, unknown>, columnMap: ColumnMap, field: ImportTargetField): unknown => {
  const header = columnMap[field];
  if (!header) return undefined;
  return row[header];
};

// --- Row validation/normalization --------------------------------------------

const STATUSES_REQUIRING_SUBMISSION_EVIDENCE: readonly ApplicationStatus[] = ['Applied', 'OA', 'Recruiter Screen', 'Technical Interview', 'Final Round', 'Offer', 'Accepted'];
const INTERVIEW_STAGES: readonly ApplicationStatus[] = ['Recruiter Screen', 'Technical Interview', 'Final Round'];
const TERMINAL_STATUSES: readonly ApplicationStatus[] = ['Rejected', 'Withdrawn', 'Closed', 'Accepted'];

const importRowSchema = z.object({
  company: z.string().trim().min(1, 'Company is required'),
  role: z.string().trim().min(1, 'Role is required'),
  applicationUrl: z.string().trim().url('Application URL must be a valid URL'),
  priority: z.enum(priorities, { errorMap: () => ({ message: `Priority must be one of ${priorities.join(', ')}` }) }),
  status: z.enum(statuses, { errorMap: () => ({ message: `Status must be one of ${statuses.join(', ')}` }) }),
  location: z.string().trim().optional(),
  applicationDeadline: z.string().nullable(),
  dateFound: z.string().nullable(),
  notes: z.string().optional(),
  dateApplied: z.string().nullable(),
  resumeVersionName: z.string().trim().optional(),
  assessmentDueAt: z.string().nullable(),
  assessmentTimezone: z.string().nullable(),
  assessmentPlatform: z.string().trim().optional(),
  interviewScheduledStart: z.string().nullable(),
  interviewTimezone: z.string().nullable(),
  offerDecisionDeadline: z.string().nullable(),
  offerCompensationSummary: z.string().trim().optional(),
  outcome: z.string().trim().optional(),
  nextAction: z.string().trim().optional(),
  nextActionDue: z.string().nullable(),
  nextActionDueKind: z.enum(['date', 'timestamp']).nullable(),
});

export type NormalizedImportRow = z.infer<typeof importRowSchema>;

export type ImportRowOutcome =
  | { ok: true; data: NormalizedImportRow }
  | { ok: false; errors: string[] }
  | { ok: 'blank' };

/**
 * Re-validates an already-normalized row (as sent back by the client at
 * commit time, after preview) against the same schema/invariants — defense
 * in depth against a tampered or stale request, independent of whatever the
 * client claims was already validated during preview.
 */
export const validateNormalizedImportRow = (data: unknown): { ok: true; data: NormalizedImportRow } | { ok: false; errors: string[] } => {
  const parsed = importRowSchema.safeParse(data);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((issue) => issue.message) };
  if (parsed.data.status === 'Offer' && !parsed.data.offerDecisionDeadline) {
    return { ok: false, errors: ['Decision Deadline is required when Status is Offer'] };
  }
  return { ok: true, data: parsed.data };
};

/**
 * Validates and normalizes a single raw spreadsheet row using an explicit
 * column mapping. Never throws — a bad row comes back as a list of
 * human-readable errors so the caller can report it and keep processing the
 * rest of the file, rather than aborting the whole import or silently
 * coercing garbage into a valid-looking record.
 */
export const normalizeImportRow = (row: Record<string, unknown>, columnMap: ColumnMap): ImportRowOutcome => {
  const company = readMapped(row, columnMap, 'company');
  const role = readMapped(row, columnMap, 'role');
  const applicationUrl = readMapped(row, columnMap, 'applicationUrl');

  // A fully blank row (common as spreadsheet trailing padding) is silently
  // skipped — that's not a data error, just an empty line.
  if (!company && !role && !applicationUrl) return { ok: 'blank' };

  const errors: string[] = [];

  const parseMappedDateOnly = (field: ImportTargetField, label: string): string | null => {
    const raw = readMappedRaw(row, columnMap, field);
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const parsed = parseExcelDateOnlyValue(raw);
    if (!parsed) errors.push(`${label} is not a recognizable calendar date`);
    return parsed;
  };

  const parseMappedDateTime = (field: ImportTargetField, label: string): string | null => {
    const raw = readMappedRaw(row, columnMap, field);
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const parsed = parseExcelDateTimeValue(raw);
    if (!parsed) errors.push(`${label} is not a recognizable date/time`);
    return parsed;
  };

  const applicationDeadline = parseMappedDateOnly('applicationDeadline', 'Application Deadline');
  const dateFound = parseMappedDateOnly('dateFound', 'Date Found');
  const dateApplied = parseMappedDateOnly('dateApplied', 'Date Applied');
  const offerDecisionDeadline = parseMappedDateOnly('offerDecisionDeadline', 'Decision Deadline');
  const assessmentDueAt = parseMappedDateTime('assessmentDueAt', 'OA Due At');
  const interviewScheduledStart = parseMappedDateTime('interviewScheduledStart', 'Interview Scheduled Start');

  const assessmentTimezoneRaw = readMapped(row, columnMap, 'assessmentTimezone');
  const assessmentTimezone = assessmentTimezoneRaw || null;
  if (assessmentTimezone && !isValidIanaTimeZone(assessmentTimezone)) errors.push('OA Timezone is not a recognized IANA timezone');
  if (assessmentDueAt && !assessmentTimezone) errors.push('OA Timezone is required when OA Due At is supplied');

  const interviewTimezoneRaw = readMapped(row, columnMap, 'interviewTimezone');
  const interviewTimezone = interviewTimezoneRaw || null;
  if (interviewTimezone && !isValidIanaTimeZone(interviewTimezone)) errors.push('Interview Timezone is not a recognized IANA timezone');
  if (interviewScheduledStart && !interviewTimezone) errors.push('Interview Timezone is required when Interview Scheduled Start is supplied');

  // An explicit Next Action Due may be either a bare calendar date or a
  // full datetime-local value — sniff which shape was actually supplied so
  // its nextActionDueKind is tracked correctly (see lib/dates.ts).
  const nextActionDueRaw = readMappedRaw(row, columnMap, 'nextActionDue');
  let nextActionDue: string | null = null;
  let nextActionDueKind: 'date' | 'timestamp' | null = null;
  if (nextActionDueRaw !== undefined && nextActionDueRaw !== null && String(nextActionDueRaw).trim() !== '') {
    const asDateOnly = parseExcelDateOnlyValue(nextActionDueRaw);
    const asDateTime = parseExcelDateTimeValue(nextActionDueRaw);
    if (asDateOnly && (typeof nextActionDueRaw !== 'string' || isDateOnlyString(nextActionDueRaw.trim()))) {
      nextActionDue = asDateOnly;
      nextActionDueKind = 'date';
    } else if (asDateTime) {
      nextActionDue = asDateTime;
      nextActionDueKind = 'timestamp';
    } else {
      errors.push('Next Action Due is not a recognizable date or date/time');
    }
  }

  const status = readMapped(row, columnMap, 'status') || 'Not Applied';

  // An imported Offer status must have a decision deadline — it's the one
  // sub-record field that's load-bearing enough to reject the row over,
  // rather than importing a structurally incomplete Offer.
  if (status === 'Offer' && !offerDecisionDeadline) {
    errors.push('Decision Deadline is required when Status is Offer');
  }

  const candidate = {
    company,
    role,
    applicationUrl,
    priority: readMapped(row, columnMap, 'priority') || 'P2',
    status,
    location: readMapped(row, columnMap, 'location') || undefined,
    applicationDeadline,
    dateFound,
    notes: readMapped(row, columnMap, 'notes') || undefined,
    dateApplied,
    resumeVersionName: readMapped(row, columnMap, 'resumeVersionName') || undefined,
    assessmentDueAt,
    assessmentTimezone,
    assessmentPlatform: readMapped(row, columnMap, 'assessmentPlatform') || undefined,
    interviewScheduledStart,
    interviewTimezone,
    offerDecisionDeadline,
    offerCompensationSummary: readMapped(row, columnMap, 'offerCompensationSummary') || undefined,
    outcome: readMapped(row, columnMap, 'outcome') || undefined,
    nextAction: readMapped(row, columnMap, 'nextAction') || undefined,
    nextActionDue,
    nextActionDueKind,
  };

  const parsed = importRowSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, errors: [...errors, ...parsed.error.issues.map((issue) => issue.message)] };
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, data: parsed.data };
};

// --- Duplicate detection + preview -------------------------------------------

// The full set of decisions a user can make about a row in the preview UI.
// `commitImportRow` below only ever needs to actually WRITE for 'create' /
// 'update' / 'importAnyway' — a 'skip' decision means never calling it at
// all (see app/api/import/commit/route.ts), so it's excluded from
// `CommittableImportRowAction` to make that contract explicit in the type.
export type ImportRowDecision = 'create' | 'update' | 'skip' | 'importAnyway';
export type CommittableImportRowAction = Exclude<ImportRowDecision, 'skip'>;

export type ImportDuplicateInfo =
  | { source: 'database'; applicationId: string; matchedOn: 'company+role' | 'applicationUrl' }
  | { source: 'workbook'; rowNumber: number; matchedOn: 'company+role' | 'applicationUrl' };

export type PreviewRow = {
  rowNumber: number;
  status: 'valid' | 'invalid' | 'blank';
  data: NormalizedImportRow | null;
  errors: string[];
  duplicate: ImportDuplicateInfo | null;
  suggestedAction: ImportRowDecision | 'error' | 'blank';
};

export type ExistingApplicationKey = { id: string; company: string; role: string; applicationUrl: string | null };

const normalizeKey = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

export function buildImportPreview(
  rows: Array<Record<string, unknown>>,
  columnMap: ColumnMap,
  existingApplications: ExistingApplicationKey[],
): PreviewRow[] {
  const results: PreviewRow[] = [];
  const seenInWorkbook: Array<{ rowNumber: number; company: string; role: string; applicationUrl: string }> = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // row 1 is the header
    const outcome = normalizeImportRow(row, columnMap);

    if (outcome.ok === 'blank') {
      results.push({ rowNumber, status: 'blank', data: null, errors: [], duplicate: null, suggestedAction: 'blank' });
      return;
    }
    if (!outcome.ok) {
      results.push({ rowNumber, status: 'invalid', data: null, errors: outcome.errors, duplicate: null, suggestedAction: 'error' });
      return;
    }

    const company = normalizeKey(outcome.data.company);
    const role = normalizeKey(outcome.data.role);
    const url = normalizeKey(outcome.data.applicationUrl);

    let duplicate: ImportDuplicateInfo | null = null;
    const dbMatch = existingApplications.find((app) => {
      const sameUrl = app.applicationUrl && normalizeKey(app.applicationUrl) === url;
      const sameCompanyRole = normalizeKey(app.company) === company && normalizeKey(app.role) === role;
      return sameUrl || sameCompanyRole;
    });
    if (dbMatch) {
      const matchedOn = dbMatch.applicationUrl && normalizeKey(dbMatch.applicationUrl) === url ? 'applicationUrl' : 'company+role';
      duplicate = { source: 'database', applicationId: dbMatch.id, matchedOn };
    } else {
      const workbookMatch = seenInWorkbook.find((seen) => seen.applicationUrl === url || (seen.company === company && seen.role === role));
      if (workbookMatch) {
        const matchedOn = workbookMatch.applicationUrl === url ? 'applicationUrl' : 'company+role';
        duplicate = { source: 'workbook', rowNumber: workbookMatch.rowNumber, matchedOn };
      }
    }

    seenInWorkbook.push({ rowNumber, company, role, applicationUrl: url });
    results.push({
      rowNumber,
      status: 'valid',
      data: outcome.data,
      errors: [],
      duplicate,
      suggestedAction: duplicate ? 'skip' : 'create',
    });
  });

  return results;
}

// --- Next action / due date derivation ---------------------------------------

export type NextActionDerivation = { nextAction: string; nextActionDue: Date | null; nextActionDueKind: 'date' | 'timestamp' };

/**
 * Derives the next action text and due date for an imported row by its
 * (validated) status — this is what an equivalent manual workflow action
 * would have set, so an imported record's next action never falls back to
 * reusing the application deadline once it's past Not Applied/Preparing.
 * An explicit Next Action / Next Action Due column, when supplied and
 * validated, always overrides the derived default.
 */
export function deriveImportNextAction(data: NormalizedImportRow, currentStage: string): NextActionDerivation {
  const status = data.status as ApplicationStatus;

  if (data.nextAction || data.nextActionDue) {
    const due = data.nextActionDue ? (data.nextActionDueKind === 'date' ? parseDateOnly(data.nextActionDue) : new Date(data.nextActionDue)) : null;
    return {
      nextAction: data.nextAction ?? generateNextAction(status, currentStage),
      nextActionDue: due,
      nextActionDueKind: data.nextActionDueKind ?? 'timestamp',
    };
  }

  if (TERMINAL_STATUSES.includes(status)) {
    return { nextAction: generateNextAction(status, currentStage), nextActionDue: null, nextActionDueKind: 'timestamp' };
  }

  if (status === 'Offer') {
    // offerDecisionDeadline is required for Offer rows (enforced during
    // normalization), so this is always present here.
    return { nextAction: generateNextAction(status, currentStage), nextActionDue: parseDateOnly(data.offerDecisionDeadline), nextActionDueKind: 'date' };
  }

  if (status === 'OA' && data.assessmentDueAt && data.assessmentTimezone) {
    return { nextAction: generateNextAction(status, currentStage), nextActionDue: parseZonedDateTime(data.assessmentDueAt, data.assessmentTimezone), nextActionDueKind: 'timestamp' };
  }

  if (INTERVIEW_STAGES.includes(status) && data.interviewScheduledStart && data.interviewTimezone) {
    return { nextAction: generateNextAction(status, currentStage), nextActionDue: parseZonedDateTime(data.interviewScheduledStart, data.interviewTimezone), nextActionDueKind: 'timestamp' };
  }

  if (status === 'Applied') {
    const reference = data.dateApplied ? parseDateOnly(data.dateApplied) ?? new Date() : new Date();
    return { nextAction: generateNextAction(status, currentStage), nextActionDue: new Date(reference.getTime() + 10 * 86400000), nextActionDueKind: 'timestamp' };
  }

  if (status === 'Not Applied' || status === 'Preparing') {
    if (data.applicationDeadline) {
      return { nextAction: generateNextAction(status, currentStage), nextActionDue: parseDateOnly(data.applicationDeadline), nextActionDueKind: 'date' };
    }
    return { nextAction: generateNextAction(status, currentStage), nextActionDue: new Date(Date.now() + 2 * 86400000), nextActionDueKind: 'timestamp' };
  }

  // OA/interview statuses without a schedule column supplied — a safe,
  // generic default rather than reusing an unrelated applicationDeadline.
  return { nextAction: generateNextAction(status, currentStage), nextActionDue: new Date(Date.now() + 4 * 86400000), nextActionDueKind: 'timestamp' };
}

// --- Commit -------------------------------------------------------------------

export type ImportCommitOutcome =
  | { ok: true; applicationId: string; action: 'create' | 'update' }
  | { ok: false; errors: string[] };

/**
 * Writes one already-validated, already-decided import row to the
 * database. Every code path runs inside its own `$transaction`, so a
 * failure partway through this row's writes (application + sub-records +
 * activity) rolls back only this row — rows already committed earlier in
 * the same import batch are unaffected, and rows after it are still
 * attempted.
 */
export async function commitImportRow(
  prisma: PrismaClient,
  action: CommittableImportRowAction,
  data: NormalizedImportRow,
  existingCodes: string[],
  matchedApplicationId: string | null,
): Promise<ImportCommitOutcome> {
  try {
    if (action === 'update') {
      if (!matchedApplicationId) return { ok: false, errors: ['No matching existing application to update'] };
      const applicationId = await updateImportedApplication(prisma, matchedApplicationId, data);
      return { ok: true, applicationId, action: 'update' };
    }

    // action is 'create' or 'importAnyway' — both create a new row; the
    // only difference is that 'importAnyway' was chosen deliberately
    // despite a flagged duplicate, which the caller already resolved
    // before getting here.
    const applicationId = await createImportedApplication(prisma, data, existingCodes);
    return { ok: true, applicationId, action: 'create' };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : 'Unknown error writing this row'] };
  }
}

async function createImportedApplication(prisma: PrismaClient, data: NormalizedImportRow, existingCodes: string[]): Promise<string> {
  const status = data.status as ApplicationStatus;
  const currentStage = deriveInitialStage(status);
  const applicationCode = generateApplicationCode(data.company, data.role, new Date(), existingCodes);
  const { nextAction, nextActionDue, nextActionDueKind } = deriveImportNextAction(data, currentStage);
  const dateApplied = STATUSES_REQUIRING_SUBMISSION_EVIDENCE.includes(status) && data.dateApplied ? parseDateOnly(data.dateApplied) : null;

  const resumeVersion = data.resumeVersionName
    ? await prisma.resumeVersion.findFirst({ where: { name: { equals: data.resumeVersionName } } })
    : null;

  const applicationId = await prisma.$transaction(async (tx) => {
    const application = await tx.application.create({
      data: {
        applicationCode,
        company: data.company,
        role: data.role,
        applicationUrl: data.applicationUrl,
        priority: data.priority,
        status,
        currentStage,
        location: data.location ?? null,
        applicationDeadline: data.applicationDeadline ? parseDateOnly(data.applicationDeadline) : null,
        dateFound: data.dateFound ? parseDateOnly(data.dateFound) : new Date(),
        dateApplied,
        notes: data.notes ?? '',
        nextAction,
        nextActionDue,
        nextActionDueKind,
        resumeVersionId: resumeVersion?.id ?? null,
        outcome: TERMINAL_STATUSES.includes(status) ? data.outcome ?? null : null,
      },
    });

    if (status === 'OA') {
      await tx.assessment.create({
        data: {
          applicationId: application.id,
          type: 'OA',
          dueAt: data.assessmentDueAt && data.assessmentTimezone ? parseZonedDateTime(data.assessmentDueAt, data.assessmentTimezone) : null,
          timezone: data.assessmentTimezone,
          platform: data.assessmentPlatform ?? null,
        },
      });
    }

    if (INTERVIEW_STAGES.includes(status)) {
      await tx.interview.create({
        data: {
          applicationId: application.id,
          stage: status,
          scheduledStart: data.interviewScheduledStart && data.interviewTimezone ? parseZonedDateTime(data.interviewScheduledStart, data.interviewTimezone) : null,
          timezone: data.interviewTimezone,
        },
      });
    }

    if (status === 'Offer') {
      await tx.offer.create({
        data: {
          applicationId: application.id,
          decisionDeadline: parseDateOnly(data.offerDecisionDeadline!),
          compensationSummary: data.offerCompensationSummary ?? null,
        },
      });
    }

    await tx.activity.create({
      data: {
        applicationId: application.id,
        eventType: 'Imported from workbook',
        previousStatus: null,
        newStatus: status,
        previousStage: null,
        newStage: currentStage,
        summary: `Imported ${application.company} from workbook as ${status}`,
      },
    });

    // A structurally complete activity trail for an imported row that
    // starts out already-submitted — matches what applyWorkflow would have
    // logged, and is also independently sufficient "submission evidence"
    // for hasSubmittedApplication (see lib/workflow-policy.ts), alongside
    // the status check that already covers it.
    if (STATUSES_REQUIRING_SUBMISSION_EVIDENCE.includes(status)) {
      await tx.activity.create({
        data: {
          applicationId: application.id,
          eventType: 'Application submitted',
          summary: 'Marked as submitted via import',
        },
      });
    }

    return application.id;
  });

  existingCodes.push(applicationCode);
  return applicationId;
}

async function updateImportedApplication(prisma: PrismaClient, applicationId: string, data: NormalizedImportRow): Promise<string> {
  await prisma.application.update({
    where: { id: applicationId },
    data: {
      company: data.company,
      role: data.role,
      applicationUrl: data.applicationUrl,
      priority: data.priority,
      location: data.location ?? null,
      applicationDeadline: data.applicationDeadline ? parseDateOnly(data.applicationDeadline) : null,
      dateFound: data.dateFound ? parseDateOnly(data.dateFound) : undefined,
      notes: data.notes ?? undefined,
    },
  });
  await prisma.activity.create({
    data: {
      applicationId,
      eventType: 'Updated from workbook',
      summary: `Updated ${data.company} from re-imported workbook row`,
    },
  });
  return applicationId;
}
