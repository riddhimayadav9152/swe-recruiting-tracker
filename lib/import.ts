import { z } from 'zod';
import * as XLSX from 'xlsx';
import type { Prisma, PrismaClient } from '@prisma/client';

/** Anything with the same model-delegate methods as PrismaClient — either the top-level client or an already-open interactive-transaction client. Every actual write in this module goes through this type, never opening its own nested `$transaction`, so the caller (see commitImportRow vs. commitImportRowInTransaction below) controls whether each row gets its own transaction or the whole batch shares one. */
type ImportDbClient = Prisma.TransactionClient | PrismaClient;
import { formatDateOnly, isDateOnlyString, isDateTimeLocalString, isValidIanaTimeZone, parseDateOnly, parseZonedDateTime } from '@/lib/dates';
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

/**
 * Whether an Excel number-format string represents a pure date (no time
 * component), a date+time, or is inconclusive (`null`) — used to decide how
 * to interpret an ambiguous numeric cell (e.g. Next Action Due) instead of
 * assuming every numeric serial is date-only. `h`/`s` format tokens next to
 * a `:` separator indicate a time component; a format built only from
 * date-shaped tokens (y/m/d and separators) is date-only.
 */
export const isTimeNumberFormat = (format: string | undefined | null): boolean | null => {
  if (!format) return null;
  const lower = format.toLowerCase();
  if (lower === 'general' || lower === '@') return null;
  if (/:/.test(lower) && /[hs]/.test(lower)) return true;
  if (/^[\sydm/\-.,]+$/i.test(lower)) return false;
  return null;
};

// --- Workbook parsing --------------------------------------------------------

export type ParsedWorkbook = { sheetNames: string[] };

export const parseWorkbookSheetNames = (buffer: Buffer): ParsedWorkbook => {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return { sheetNames: workbook.SheetNames };
};

/** Per-row, per-header Excel number-format strings (`cell.z`) — used to disambiguate an otherwise-ambiguous numeric cell (see `isTimeNumberFormat`). */
export type RowCellFormats = Record<string, string | undefined>;

export type SheetRowsResult = {
  rows: Array<Record<string, unknown>>;
  cellFormats: RowCellFormats[];
};

export const readWorkbookSheetRows = (buffer: Buffer, sheetName: string): SheetRowsResult => {
  // cellDates: true asks SheetJS to convert a numeric cell that's actually
  // formatted as a date/time into a real JS Date, using its own
  // format-aware logic — the same signal we separately inspect via `.z`
  // below for the ambiguous "no recognized date format" case.
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return { rows: [], cellFormats: [] };
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null }) as Array<Record<string, unknown>>;

  const ref = sheet['!ref'];
  if (!ref) return { rows, cellFormats: rows.map(() => ({})) };
  const range = XLSX.utils.decode_range(ref);
  const headerRowIndex = range.s.r;
  const headerToCol: Record<string, number> = {};
  for (let col = range.s.c; col <= range.e.c; col += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: headerRowIndex, c: col })];
    if (cell && typeof cell.v === 'string') headerToCol[cell.v] = col;
  }

  const cellFormats: RowCellFormats[] = rows.map((_, rowIdx) => {
    const sheetRow = headerRowIndex + 1 + rowIdx;
    const formats: RowCellFormats = {};
    for (const [header, col] of Object.entries(headerToCol)) {
      const cell = sheet[XLSX.utils.encode_cell({ r: sheetRow, c: col })];
      formats[header] = cell?.z;
    }
    return formats;
  });

  return { rows, cellFormats };
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

// Fields whose *existing* value on an Update-existing row is meaningfully
// "clearable" — i.e. nullable in the schema, so a deliberately blank mapped
// cell is a coherent request to erase the value. company/role/applicationUrl
// are always required (never blank on a valid row); priority/status are
// non-nullable with real defaults, so a blank/unmapped cell there means
// "leave as-is", never "clear" (there's nothing sensible to clear it to).
export const CLEARABLE_IMPORT_FIELDS: readonly ImportTargetField[] = [
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
];

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
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
};

const readMappedRaw = (row: Record<string, unknown>, columnMap: ColumnMap, field: ImportTargetField): unknown => {
  const header = columnMap[field];
  if (!header) return undefined;
  return row[header];
};

/** Whether `field`'s source cell was actually filled in, present-but-blank, or has no column mapped at all — independent of any default value normalization later applies. This is what Update-existing consults to decide whether to touch a field at all. */
export type FieldPresence = 'supplied' | 'blank' | 'unmapped';
export type FieldPresenceMap = Record<ImportTargetField, FieldPresence>;

const computePresence = (row: Record<string, unknown>, columnMap: ColumnMap, field: ImportTargetField): FieldPresence => {
  const header = columnMap[field];
  if (!header) return 'unmapped';
  const raw = row[header];
  if (raw === undefined || raw === null) return 'blank';
  if (raw instanceof Date) return 'supplied';
  if (String(raw).trim() === '') return 'blank';
  return 'supplied';
};

const computeFieldPresenceMap = (row: Record<string, unknown>, columnMap: ColumnMap): FieldPresenceMap => {
  const map = {} as FieldPresenceMap;
  for (const field of IMPORT_TARGET_FIELDS) map[field] = computePresence(row, columnMap, field);
  return map;
};

// --- Row validation/normalization --------------------------------------------

export const STATUSES_REQUIRING_SUBMISSION_EVIDENCE: readonly ApplicationStatus[] = ['Applied', 'OA', 'Recruiter Screen', 'Technical Interview', 'Final Round', 'Offer', 'Accepted'];
export const INTERVIEW_STAGES: readonly ApplicationStatus[] = ['Recruiter Screen', 'Technical Interview', 'Final Round'];
export const TERMINAL_STATUSES: readonly ApplicationStatus[] = ['Rejected', 'Withdrawn', 'Closed', 'Accepted'];

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
  | { ok: true; data: NormalizedImportRow; fieldPresence: FieldPresenceMap; warnings: string[]; downgradedFrom: ApplicationStatus | null }
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
  const errors = validateStatusInvariants(parsed.data);
  if (errors.length) return { ok: false, errors };
  return { ok: true, data: parsed.data };
};

/** Hard, commit-blocking invariants that depend on more than one field together (so they can't be expressed as a single Zod field rule). Reused by both preview-time normalization and commit-time re-validation. */
function validateStatusInvariants(data: NormalizedImportRow): string[] {
  const errors: string[] = [];
  if (data.status === 'Offer' && !data.offerDecisionDeadline) {
    errors.push('Decision Deadline is required when Status is Offer');
  }
  if (data.assessmentDueAt && !data.assessmentTimezone) errors.push('OA Timezone is required when OA Due At is supplied');
  if (data.assessmentTimezone && !isValidIanaTimeZone(data.assessmentTimezone)) errors.push('OA Timezone is not a recognized IANA timezone');
  if (data.interviewScheduledStart && !data.interviewTimezone) errors.push('Interview Timezone is required when Interview Scheduled Start is supplied');
  if (data.interviewTimezone && !isValidIanaTimeZone(data.interviewTimezone)) errors.push('Interview Timezone is not a recognized IANA timezone');
  if (data.nextActionDue && !data.nextActionDueKind) errors.push('Next Action Due is missing its date/timestamp kind');
  return errors;
}

export type NormalizeRowOptions = {
  cellFormats?: RowCellFormats;
  /** Fallback used ONLY when Next Action Due is an ambiguous numeric cell whose format can't be inspected (e.g. no cell metadata available) — set explicitly by the user during column mapping, per item 10. */
  nextActionDueKindOverride?: 'date' | 'timestamp' | null;
};

/**
 * Validates and normalizes a single raw spreadsheet row using an explicit
 * column mapping. Never throws — a bad row comes back as a list of
 * human-readable errors so the caller can report it and keep processing the
 * rest of the file, rather than aborting the whole import or silently
 * coercing garbage into a valid-looking record.
 *
 * Advanced statuses (OA, an interview stage, Accepted) that are missing the
 * structural data a real workflow action would have required are never
 * imported "hollow" — they're downgraded to the nearest safe, honest status
 * (Applied) with a warning explaining what's missing and how to repair it
 * manually afterward, rather than silently creating an Assessment/Interview
 * with every field null.
 */
export const normalizeImportRow = (row: Record<string, unknown>, columnMap: ColumnMap, options: NormalizeRowOptions = {}): ImportRowOutcome => {
  const company = readMapped(row, columnMap, 'company');
  const role = readMapped(row, columnMap, 'role');
  const applicationUrl = readMapped(row, columnMap, 'applicationUrl');

  // A fully blank row (common as spreadsheet trailing padding) is silently
  // skipped — that's not a data error, just an empty line.
  if (!company && !role && !applicationUrl) return { ok: 'blank' };

  const errors: string[] = [];
  const warnings: string[] = [];

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

  const interviewTimezoneRaw = readMapped(row, columnMap, 'interviewTimezone');
  const interviewTimezone = interviewTimezoneRaw || null;
  if (interviewTimezone && !isValidIanaTimeZone(interviewTimezone)) errors.push('Interview Timezone is not a recognized IANA timezone');

  // An explicit Next Action Due may be either a bare calendar date or a
  // full datetime-local value. A STRING value's own shape is unambiguous
  // (either it parses as "YYYY-MM-DD" or it doesn't); a NUMERIC (Excel
  // serial) value is fundamentally ambiguous on its own — 46249 could be
  // "August 15" or "August 15, 12:00 AM" — so it's resolved via the cell's
  // own number-format string when available, then the user's explicit
  // column-mapping choice, and only errors out if neither is available,
  // rather than silently assuming every numeric serial is date-only.
  const nextActionDueRaw = readMappedRaw(row, columnMap, 'nextActionDue');
  let nextActionDue: string | null = null;
  let nextActionDueKind: 'date' | 'timestamp' | null = null;
  if (nextActionDueRaw !== undefined && nextActionDueRaw !== null && String(nextActionDueRaw).trim() !== '') {
    if (typeof nextActionDueRaw === 'string') {
      const trimmed = nextActionDueRaw.trim();
      if (isDateOnlyString(trimmed)) {
        nextActionDue = trimmed;
        nextActionDueKind = 'date';
      } else {
        const asDateTime = parseExcelDateTimeValue(trimmed);
        if (asDateTime) {
          nextActionDue = asDateTime;
          nextActionDueKind = 'timestamp';
        } else {
          errors.push('Next Action Due is not a recognizable date or date/time');
        }
      }
    } else if (typeof nextActionDueRaw === 'number') {
      const header = columnMap.nextActionDue;
      const cellFormat = header ? options.cellFormats?.[header] : undefined;
      const formatSaysTime = isTimeNumberFormat(cellFormat);
      const isTimeShaped = formatSaysTime ?? (options.nextActionDueKindOverride ? options.nextActionDueKindOverride === 'timestamp' : null);
      if (isTimeShaped === null) {
        errors.push('Next Action Due is a number with no recognizable date format — choose Date or Timestamp for this column during mapping');
      } else if (isTimeShaped) {
        nextActionDue = parseExcelDateTimeValue(nextActionDueRaw);
        nextActionDueKind = 'timestamp';
        if (!nextActionDue) errors.push('Next Action Due is not a recognizable date/time');
      } else {
        nextActionDue = parseExcelDateOnlyValue(nextActionDueRaw);
        nextActionDueKind = 'date';
        if (!nextActionDue) errors.push('Next Action Due is not a recognizable calendar date');
      }
    } else {
      // Date object or anything else — datetime-shaped by construction.
      nextActionDue = parseExcelDateTimeValue(nextActionDueRaw);
      nextActionDueKind = 'timestamp';
      if (!nextActionDue) errors.push('Next Action Due is not a recognizable date or date/time');
    }
  }

  let status = (readMapped(row, columnMap, 'status') || 'Not Applied') as ApplicationStatus;
  let downgradedFrom: ApplicationStatus | null = null;

  // An imported Offer status must have a decision deadline — it's the one
  // sub-record field that's load-bearing enough to reject the row over,
  // rather than importing a structurally incomplete Offer.
  if (status === 'Offer' && !offerDecisionDeadline) {
    errors.push('Decision Deadline is required when Status is Offer');
  }

  // OA/interview statuses need their own schedule to avoid a hollow
  // Assessment/Interview record (every field null) — downgrade to Applied
  // rather than reject the whole row, since the company/role/etc are still
  // good data worth importing.
  if (status === 'OA' && !(assessmentDueAt && assessmentTimezone)) {
    downgradedFrom = status;
    status = 'Applied';
    warnings.push('OA Due At/Timezone not supplied — imported as Applied instead of OA; use OA Received to add the assessment manually.');
  }
  if (INTERVIEW_STAGES.includes(status) && !(interviewScheduledStart && interviewTimezone)) {
    downgradedFrom = status;
    status = 'Applied';
    warnings.push(`Interview Scheduled Start/Timezone not supplied — imported as Applied instead of ${downgradedFrom}; use Interview Received to add the interview manually.`);
  }
  if (status === 'Accepted' && !offerDecisionDeadline) {
    warnings.push('Imported as Accepted with no offer record — Decision Deadline was not supplied.');
  }
  if (STATUSES_REQUIRING_SUBMISSION_EVIDENCE.includes(status) && !dateApplied) {
    warnings.push('No Date Applied supplied for a post-submission status — use Set Application Date to repair this record after import.');
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

  const fieldPresence = computeFieldPresenceMap(row, columnMap);
  return { ok: true, data: parsed.data, fieldPresence, warnings, downgradedFrom };
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

export type ImportFieldDiffKind = 'preserved' | 'unchanged' | 'changed' | 'clear';

export type ImportFieldDiff = {
  field: ImportTargetField;
  presence: FieldPresence;
  previousValue: string | null;
  newValue: string | null;
  kind: ImportFieldDiffKind;
};

export type ResumeVersionMatch = { id: string; name: string } | null;

export type PreviewRow = {
  rowNumber: number;
  status: 'valid' | 'invalid' | 'blank';
  data: NormalizedImportRow | null;
  fieldPresence: FieldPresenceMap | null;
  errors: string[];
  warnings: string[];
  downgradedFrom: ApplicationStatus | null;
  duplicate: ImportDuplicateInfo | null;
  suggestedAction: ImportRowDecision | 'error' | 'blank';
  /** Only populated when `duplicate?.source === 'database'` — what Update existing would actually change. */
  diff: ImportFieldDiff[] | null;
  resumeMatch: ResumeVersionMatch;
};

export type ExistingApplicationRecord = {
  id: string;
  company: string;
  role: string;
  applicationUrl: string | null;
  priority: string;
  status: string;
  location: string | null;
  applicationDeadline: Date | null;
  dateFound: Date | null;
  dateApplied: Date | null;
  notes: string | null;
  resumeVersionName: string | null;
};

const normalizeKey = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

const displayValue = (value: string | null | undefined): string | null => (value ? value : null);

const FIELD_DISPLAY_ORDER: ImportTargetField[] = [
  'company', 'role', 'applicationUrl', 'priority', 'status', 'location',
  'applicationDeadline', 'dateFound', 'dateApplied', 'notes', 'resumeVersionName',
];

function getExistingDisplayValue(existing: ExistingApplicationRecord, field: ImportTargetField): string | null {
  switch (field) {
    case 'company': return displayValue(existing.company);
    case 'role': return displayValue(existing.role);
    case 'applicationUrl': return displayValue(existing.applicationUrl);
    case 'priority': return displayValue(existing.priority);
    case 'status': return displayValue(existing.status);
    case 'location': return displayValue(existing.location);
    case 'applicationDeadline': return existing.applicationDeadline ? formatDateOnly(existing.applicationDeadline) : null;
    case 'dateFound': return existing.dateFound ? formatDateOnly(existing.dateFound) : null;
    case 'dateApplied': return existing.dateApplied ? formatDateOnly(existing.dateApplied) : null;
    case 'notes': return displayValue(existing.notes);
    case 'resumeVersionName': return displayValue(existing.resumeVersionName);
    default: return null;
  }
}

function getNewDisplayValue(data: NormalizedImportRow, field: ImportTargetField): string | null {
  switch (field) {
    case 'company': return displayValue(data.company);
    case 'role': return displayValue(data.role);
    case 'applicationUrl': return displayValue(data.applicationUrl);
    case 'priority': return displayValue(data.priority);
    case 'status': return displayValue(data.status);
    case 'location': return displayValue(data.location ?? null);
    case 'applicationDeadline': return data.applicationDeadline;
    case 'dateFound': return data.dateFound;
    case 'dateApplied': return data.dateApplied;
    case 'notes': return displayValue(data.notes ?? null);
    case 'resumeVersionName': return displayValue(data.resumeVersionName ?? null);
    default: return null;
  }
}

/**
 * Computes the before/after diff an Update-existing decision would apply —
 * per field, whether it's preserved (unmapped, never touched), unchanged
 * (supplied but identical), changed (supplied and different), or a
 * candidate clear (mapped but blank — requires the caller's explicit
 * confirmation before it's actually applied; see `confirmedClears` on
 * `updateImportedApplication`).
 */
export function computeImportRowDiff(existing: ExistingApplicationRecord, data: NormalizedImportRow, fieldPresence: FieldPresenceMap): ImportFieldDiff[] {
  return FIELD_DISPLAY_ORDER.map((field) => {
    const presence = fieldPresence[field];
    const previousValue = getExistingDisplayValue(existing, field);

    if (presence === 'unmapped') return { field, presence, previousValue, newValue: previousValue, kind: 'preserved' };

    // priority/status are never nullable and always carry a real default —
    // a blank cell for either means "don't touch", exactly like unmapped,
    // never "clear" (there's nothing sensible to clear it to).
    if (presence === 'blank' && !CLEARABLE_IMPORT_FIELDS.includes(field)) {
      return { field, presence, previousValue, newValue: previousValue, kind: 'preserved' };
    }
    if (presence === 'blank') {
      return { field, presence, previousValue, newValue: null, kind: previousValue ? 'clear' : 'unchanged' };
    }

    const newValue = getNewDisplayValue(data, field);
    return { field, presence, previousValue, newValue, kind: newValue === previousValue ? 'unchanged' : 'changed' };
  });
}

export function buildImportPreview(
  rows: Array<Record<string, unknown>>,
  columnMap: ColumnMap,
  existingApplications: ExistingApplicationRecord[],
  existingResumeVersions: Array<{ id: string; name: string }>,
  options: { cellFormats?: RowCellFormats[]; nextActionDueKindOverride?: 'date' | 'timestamp' | null } = {},
): PreviewRow[] {
  const results: PreviewRow[] = [];
  const seenInWorkbook: Array<{ rowNumber: number; company: string; role: string; applicationUrl: string }> = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // row 1 is the header
    const outcome = normalizeImportRow(row, columnMap, {
      cellFormats: options.cellFormats?.[index],
      nextActionDueKindOverride: options.nextActionDueKindOverride,
    });

    if (outcome.ok === 'blank') {
      results.push({ rowNumber, status: 'blank', data: null, fieldPresence: null, errors: [], warnings: [], downgradedFrom: null, duplicate: null, suggestedAction: 'blank', diff: null, resumeMatch: null });
      return;
    }
    if (!outcome.ok) {
      results.push({ rowNumber, status: 'invalid', data: null, fieldPresence: null, errors: outcome.errors, warnings: [], downgradedFrom: null, duplicate: null, suggestedAction: 'error', diff: null, resumeMatch: null });
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

    let resumeMatch: ResumeVersionMatch = null;
    const warnings = [...outcome.warnings];
    if (outcome.data.resumeVersionName) {
      const match = existingResumeVersions.find((rv) => rv.name.trim().toLowerCase() === outcome.data.resumeVersionName!.trim().toLowerCase());
      if (match) resumeMatch = match;
      else warnings.push(`Resume version "${outcome.data.resumeVersionName}" was not found — choose an existing resume, create a new one, or leave it blank.`);
    }

    seenInWorkbook.push({ rowNumber, company, role, applicationUrl: url });
    results.push({
      rowNumber,
      status: 'valid',
      data: outcome.data,
      fieldPresence: outcome.fieldPresence,
      errors: [],
      warnings,
      downgradedFrom: outcome.downgradedFrom,
      duplicate,
      suggestedAction: duplicate ? 'skip' : 'create',
      diff: dbMatch ? computeImportRowDiff(dbMatch, outcome.data, outcome.fieldPresence) : null,
      resumeMatch,
    });
  });

  return results;
}

// --- Next action / due date derivation ---------------------------------------

export type NextActionDerivation = { nextAction: string; nextActionDue: Date | null; nextActionDueKind: 'date' | 'timestamp' };

/**
 * Derives the next action text and due date for an imported row by its
 * (validated, possibly downgraded) status — this is what an equivalent
 * manual workflow action would have set, so an imported record's next
 * action never falls back to reusing the application deadline once it's
 * past Not Applied/Preparing. An explicit Next Action / Next Action Due
 * column, when supplied and validated, always overrides the derived
 * default.
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
  // (In practice this branch is now unreachable for OA/interview specifically
  // since those get downgraded to Applied above when their schedule is
  // missing — kept as a defensive fallback.)
  return { nextAction: generateNextAction(status, currentStage), nextActionDue: new Date(Date.now() + 4 * 86400000), nextActionDueKind: 'timestamp' };
}

// --- Resume version resolution ------------------------------------------------

export type ResumeVersionDecision =
  | { action: 'existing'; resumeVersionId: string }
  | { action: 'create'; name: string; targetType: string }
  | { action: 'blank' };

async function resolveResumeVersionId(tx: ImportDbClient, decision: ResumeVersionDecision | undefined): Promise<string | null> {
  if (!decision || decision.action === 'blank') return null;
  if (decision.action === 'existing') return decision.resumeVersionId;
  const created = await tx.resumeVersion.create({ data: { name: decision.name, targetType: decision.targetType } });
  return created.id;
}

// --- Commit -------------------------------------------------------------------

export type ImportCommitOutcome =
  | { ok: true; applicationId: string; action: 'create' | 'update' }
  | { ok: false; errors: string[] };

export type CommitRowOptions = {
  resumeVersionDecision?: ResumeVersionDecision;
  /** Fields the caller has explicitly confirmed should be CLEARED on an update, having reviewed the diff (see computeImportRowDiff) — any other 'blank'-presence field is preserved instead. */
  confirmedClears?: ImportTargetField[];
};

/**
 * Dispatches one already-validated, already-decided import row's writes
 * (application + sub-records + activity) against whatever `tx` client is
 * passed in. Never opens its own transaction — that's the caller's choice:
 * `commitImportRow` below wraps a single call in its own `$transaction` for
 * per-row mode (a failure here rolls back only this row); the entire-batch
 * commit mode instead passes an already-open transaction shared across every
 * row (see app/api/import/commit/route.ts), so any row's failure rolls back
 * the whole batch.
 */
async function writeImportRow(
  tx: ImportDbClient,
  action: CommittableImportRowAction,
  data: NormalizedImportRow,
  existingCodes: string[],
  matchedApplicationId: string | null,
  fieldPresence: FieldPresenceMap | undefined,
  rowOptions: CommitRowOptions,
): Promise<{ applicationId: string; action: 'create' | 'update' }> {
  if (action === 'update') {
    if (!matchedApplicationId) throw new Error('No matching existing application to update');
    const applicationId = await updateImportedApplication(tx, matchedApplicationId, data, fieldPresence, rowOptions);
    return { applicationId, action: 'update' };
  }

  // action is 'create' or 'importAnyway' — both create a new row; the only
  // difference is that 'importAnyway' was chosen deliberately despite a
  // flagged duplicate, which the caller already resolved before getting here.
  const applicationId = await createImportedApplication(tx, data, existingCodes, rowOptions);
  return { applicationId, action: 'create' };
}

/** Per-row commit mode: this row's writes get their own transaction, so a failure here never affects rows committed earlier or attempted after it in the same batch. */
export async function commitImportRow(
  prisma: PrismaClient,
  action: CommittableImportRowAction,
  data: NormalizedImportRow,
  existingCodes: string[],
  matchedApplicationId: string | null,
  fieldPresence: FieldPresenceMap | undefined,
  rowOptions: CommitRowOptions = {},
): Promise<ImportCommitOutcome> {
  try {
    const result = await prisma.$transaction((tx) => writeImportRow(tx, action, data, existingCodes, matchedApplicationId, fieldPresence, rowOptions));
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : 'Unknown error writing this row'] };
  }
}

/** Entire-batch commit mode: `tx` is a transaction already opened around the whole batch by the caller — throwing here rolls back every row in the batch, not just this one. */
export async function commitImportRowInTransaction(
  tx: Prisma.TransactionClient,
  action: CommittableImportRowAction,
  data: NormalizedImportRow,
  existingCodes: string[],
  matchedApplicationId: string | null,
  fieldPresence: FieldPresenceMap | undefined,
  rowOptions: CommitRowOptions = {},
): Promise<{ applicationId: string; action: 'create' | 'update' }> {
  return writeImportRow(tx, action, data, existingCodes, matchedApplicationId, fieldPresence, rowOptions);
}

async function createImportedApplication(tx: ImportDbClient, data: NormalizedImportRow, existingCodes: string[], rowOptions: CommitRowOptions): Promise<string> {
  const status = data.status as ApplicationStatus;
  const currentStage = deriveInitialStage(status);
  const applicationCode = generateApplicationCode(data.company, data.role, new Date(), existingCodes);
  const { nextAction, nextActionDue, nextActionDueKind } = deriveImportNextAction(data, currentStage);
  // Preserve an explicitly-supplied Date Applied regardless of status — even
  // a Rejected/Withdrawn/Closed row can genuinely have applied before being
  // turned down, and the sheet saying so is real historical data, not
  // something to second-guess and discard. (STATUSES_REQUIRING_SUBMISSION_EVIDENCE
  // governs the separate "should the missing-date warning fire" question —
  // see hasSubmittedApplication in lib/workflow-policy.ts — not whether a
  // value the user actually gave us gets kept.)
  const dateApplied = data.dateApplied ? parseDateOnly(data.dateApplied) : null;

  const resumeVersionId = rowOptions.resumeVersionDecision
    ? await resolveResumeVersionId(tx, rowOptions.resumeVersionDecision)
    : data.resumeVersionName
      ? (await tx.resumeVersion.findFirst({ where: { name: { equals: data.resumeVersionName } } }))?.id ?? null
      : null;

  {
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
        resumeVersionId,
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

    existingCodes.push(applicationCode);
    return application.id;
  }
}

async function updateImportedApplication(
  tx: ImportDbClient,
  applicationId: string,
  data: NormalizedImportRow,
  fieldPresence: FieldPresenceMap | undefined,
  rowOptions: CommitRowOptions,
): Promise<string> {
  const presence = fieldPresence ?? ({} as FieldPresenceMap);
  const confirmedClears = new Set(rowOptions.confirmedClears ?? []);

  // Per field: 'unmapped' never touches the existing value; 'blank' only
  // touches it if the caller explicitly confirmed clearing it (after
  // reviewing the diff); 'supplied' always applies the new value. This is
  // the whole point of field-presence tracking — Update existing must
  // never silently blank out location/notes/etc just because a column
  // wasn't mapped in this particular workbook.
  const include = (field: ImportTargetField): boolean => {
    const state = presence[field];
    if (state === 'unmapped' || state === undefined) return false;
    if (state === 'blank') return CLEARABLE_IMPORT_FIELDS.includes(field) && confirmedClears.has(field);
    return true;
  };

  {
    const existing = await tx.application.findUniqueOrThrow({ where: { id: applicationId } });
    const previousStatus = existing.status;
    const previousStage = existing.currentStage;

    const nextStatus = include('status') ? (data.status as ApplicationStatus) : (previousStatus as ApplicationStatus);
    const statusChanged = nextStatus !== previousStatus;
    const currentStage = statusChanged ? deriveInitialStage(nextStatus) : previousStage;

    const resumeVersionId = rowOptions.resumeVersionDecision
      ? await resolveResumeVersionId(tx, rowOptions.resumeVersionDecision)
      : include('resumeVersionName') && data.resumeVersionName
        ? (await tx.resumeVersion.findFirst({ where: { name: { equals: data.resumeVersionName } } }))?.id ?? null
        : include('resumeVersionName')
          ? null // explicitly confirmed clear
          : undefined;

    const applicationData: Record<string, unknown> = {};
    if (include('company')) applicationData.company = data.company;
    if (include('role')) applicationData.role = data.role;
    if (include('applicationUrl')) applicationData.applicationUrl = data.applicationUrl;
    if (include('priority')) applicationData.priority = data.priority;
    if (include('location')) applicationData.location = data.location ?? null;
    if (include('applicationDeadline')) applicationData.applicationDeadline = data.applicationDeadline ? parseDateOnly(data.applicationDeadline) : null;
    if (include('dateFound')) applicationData.dateFound = data.dateFound ? parseDateOnly(data.dateFound) : null;
    if (include('notes')) applicationData.notes = data.notes ?? null;
    if (include('dateApplied')) applicationData.dateApplied = data.dateApplied ? parseDateOnly(data.dateApplied) : null;
    if (resumeVersionId !== undefined) applicationData.resumeVersionId = resumeVersionId;
    if (statusChanged) {
      applicationData.status = nextStatus;
      applicationData.currentStage = currentStage;
    }

    // Deriving next action / due date and clearing terminal-status
    // deadlines only matters when the status actually changed (or an
    // explicit Next Action / Next Action Due override was supplied) —
    // otherwise leave the application's existing next action alone.
    if (statusChanged || include('nextAction') || include('nextActionDue')) {
      const derivation = deriveImportNextAction({ ...data, status: nextStatus }, currentStage ?? deriveInitialStage(nextStatus));
      applicationData.nextAction = derivation.nextAction;
      applicationData.nextActionDue = derivation.nextActionDue;
      applicationData.nextActionDueKind = derivation.nextActionDueKind;
    }
    if (TERMINAL_STATUSES.includes(nextStatus) && statusChanged) {
      applicationData.nextActionDue = null;
    }
    if (statusChanged && TERMINAL_STATUSES.includes(nextStatus) && include('outcome')) {
      applicationData.outcome = data.outcome ?? null;
    } else if (include('outcome') && TERMINAL_STATUSES.includes(previousStatus as ApplicationStatus)) {
      applicationData.outcome = data.outcome ?? null;
    }

    await tx.application.update({ where: { id: applicationId }, data: applicationData });

    // Upsert the sub-record appropriate to the (possibly newly-updated)
    // status, so an advanced-status update never leaves a stale/missing
    // related record inconsistent with what the application now says.
    if (nextStatus === 'OA' && (include('assessmentDueAt') || include('assessmentTimezone') || include('assessmentPlatform') || statusChanged)) {
      const dueAt = data.assessmentDueAt && data.assessmentTimezone ? parseZonedDateTime(data.assessmentDueAt, data.assessmentTimezone) : null;
      const existingAssessment = await tx.assessment.findFirst({ where: { applicationId, type: 'OA' }, orderBy: { id: 'desc' } });
      if (existingAssessment) {
        await tx.assessment.update({
          where: { id: existingAssessment.id },
          data: {
            dueAt: include('assessmentDueAt') ? dueAt : undefined,
            timezone: include('assessmentTimezone') ? data.assessmentTimezone : undefined,
            platform: include('assessmentPlatform') ? data.assessmentPlatform ?? null : undefined,
          },
        });
      } else {
        await tx.assessment.create({ data: { applicationId, type: 'OA', dueAt, timezone: data.assessmentTimezone, platform: data.assessmentPlatform ?? null } });
      }
    }

    if (INTERVIEW_STAGES.includes(nextStatus) && (include('interviewScheduledStart') || include('interviewTimezone') || statusChanged)) {
      const scheduledStart = data.interviewScheduledStart && data.interviewTimezone ? parseZonedDateTime(data.interviewScheduledStart, data.interviewTimezone) : null;
      const existingInterview = await tx.interview.findFirst({ where: { applicationId, stage: nextStatus }, orderBy: { id: 'desc' } });
      if (existingInterview) {
        await tx.interview.update({
          where: { id: existingInterview.id },
          data: {
            scheduledStart: include('interviewScheduledStart') ? scheduledStart : undefined,
            timezone: include('interviewTimezone') ? data.interviewTimezone : undefined,
          },
        });
      } else {
        await tx.interview.create({ data: { applicationId, stage: nextStatus, scheduledStart, timezone: data.interviewTimezone } });
      }
    }

    if (nextStatus === 'Offer' && (include('offerDecisionDeadline') || include('offerCompensationSummary') || statusChanged)) {
      await tx.offer.upsert({
        where: { applicationId },
        create: {
          applicationId,
          decisionDeadline: data.offerDecisionDeadline ? parseDateOnly(data.offerDecisionDeadline) : null,
          compensationSummary: data.offerCompensationSummary ?? null,
        },
        update: {
          decisionDeadline: include('offerDecisionDeadline') ? (data.offerDecisionDeadline ? parseDateOnly(data.offerDecisionDeadline) : null) : undefined,
          compensationSummary: include('offerCompensationSummary') ? data.offerCompensationSummary ?? null : undefined,
        },
      });
    }

    await tx.activity.create({
      data: {
        applicationId,
        eventType: 'Updated from workbook',
        previousStatus,
        newStatus: statusChanged ? nextStatus : null,
        previousStage: statusChanged ? previousStage : null,
        newStage: statusChanged ? currentStage : null,
        summary: statusChanged ? `Updated ${data.company} from re-imported workbook row (status: ${previousStatus} → ${nextStatus})` : `Updated ${data.company} from re-imported workbook row`,
      },
    });

    if (statusChanged && STATUSES_REQUIRING_SUBMISSION_EVIDENCE.includes(nextStatus) && !existing.dateApplied && !include('dateApplied')) {
      await tx.activity.create({
        data: { applicationId, eventType: 'Application submitted', summary: 'Marked as submitted via import update' },
      });
    }

    return applicationId;
  }
}
