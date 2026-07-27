import { format, subDays } from 'date-fns';
import { isDateOnlyString, isDeadlineOverdue, type DeadlineKind } from '@/lib/dates';

export const statuses = [
  'Not Applied',
  'Preparing',
  'Applied',
  'OA',
  'Recruiter Screen',
  'Technical Interview',
  'Final Round',
  'Offer',
  'Accepted',
  'Rejected',
  'Withdrawn',
  'Closed',
] as const;

export const priorities = ['P0', 'P1', 'P2', 'P3'] as const;

export type ApplicationStatus = (typeof statuses)[number];
export type Priority = (typeof priorities)[number];

export type ApplicationInput = {
  company: string;
  role: string;
  applicationUrl: string;
  priority: Priority;
  status?: ApplicationStatus;
  currentStage?: string;
  location?: string;
  applicationDeadline?: string | null;
  dateFound?: string | null;
  notes?: string;
};

export const generateApplicationCode = (company: string, role: string, createdAt: Date = new Date(), existingCodes: string[] = []) => {
  const base = `${company.replace(/[^a-z0-9]+/gi, '').slice(0, 4).toUpperCase()}-${role.replace(/[^a-z0-9]+/gi, '').slice(0, 4).toUpperCase()}`;
  const stamp = format(createdAt, 'yyMMdd');
  const seed = `${base}-${stamp}`;
  const normalized = new Set(existingCodes.map((value) => value.toUpperCase()));
  if (!normalized.has(seed.toUpperCase())) {
    return seed;
  }

  let suffix = 2;
  let code = `${seed}-${suffix}`;
  while (normalized.has(code.toUpperCase())) {
    suffix += 1;
    code = `${seed}-${suffix}`;
  }

  return code;
};

export const generateNextAction = (status: ApplicationStatus, currentStage?: string | null) => {
  switch (status) {
    case 'Preparing':
      return 'Finish tailoring and submit';
    case 'Applied':
      return 'Monitor application and email';
    case 'OA':
      return 'Prepare for and complete OA';
    case 'Recruiter Screen':
    case 'Technical Interview':
    case 'Final Round':
      return `Prepare for ${currentStage ?? 'interview'}`;
    case 'Offer':
      return 'Review, compare, and respond to offer';
    case 'Rejected':
    case 'Withdrawn':
    case 'Closed':
    case 'Accepted':
      return 'No active next action';
    default:
      return 'Review and apply';
  }
};

export const detectDuplicate = (applications: Array<{ company: string; role: string; applicationUrl?: string | null }>, payload: ApplicationInput) => {
  const normalizedCompany = payload.company.trim().toLowerCase();
  const normalizedRole = payload.role.trim().toLowerCase();
  const normalizedUrl = payload.applicationUrl?.trim().toLowerCase();

  return applications.find((application) => {
    const sameCompany = application.company.trim().toLowerCase() === normalizedCompany;
    const sameRole = application.role.trim().toLowerCase() === normalizedRole;
    const sameUrl = normalizedUrl ? application.applicationUrl?.trim().toLowerCase() === normalizedUrl : false;
    return (sameCompany && sameRole) || sameUrl;
  });
};

export const validateApplicationInput = (payload: ApplicationInput) => {
  const errors: Record<string, string> = {};
  if (!payload.company?.trim()) errors.company = 'Company is required';
  if (!payload.role?.trim()) errors.role = 'Role is required';
  if (!payload.applicationUrl?.trim()) errors.applicationUrl = 'Application URL is required';
  if (!payload.priority) errors.priority = 'Priority is required';
  return errors;
};

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
    const asDate = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return buildDateOnlyString(asDate.getUTCFullYear(), asDate.getUTCMonth() + 1, asDate.getUTCDate());
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

export type DeadlineUrgency = 'none' | 'overdue' | 'soon' | 'normal';

export const getDeadlineUrgency = (
  date: Date | null,
  kind: DeadlineKind = 'timestamp',
  userTimeZone = 'UTC',
  now: Date = new Date(),
): DeadlineUrgency => {
  if (!date) return 'none';
  if (isDeadlineOverdue(date, kind, userTimeZone, now)) return 'overdue';
  if (date.getTime() <= subDays(now, -3).getTime()) return 'soon';
  return 'normal';
};

// Status and current stage must always stay consistent — the stage is
// derived from the (validated) status, never taken verbatim from client
// input or a spreadsheet's own "Current Stage" column, so it's impossible to
// end up with e.g. Status: Applied paired with Stage: Discovered.
export const deriveInitialStage = (status: ApplicationStatus): string => {
  switch (status) {
    case 'Preparing':
      return 'Preparing';
    case 'Applied':
      return 'Application Submitted';
    case 'OA':
      return 'Online Assessment';
    case 'Recruiter Screen':
      return 'Recruiter Screen';
    case 'Technical Interview':
      return 'Technical Interview';
    case 'Final Round':
      return 'Final Round';
    case 'Offer':
      return 'Offer Received';
    case 'Accepted':
      return 'Accepted';
    case 'Rejected':
      return 'Rejected';
    case 'Withdrawn':
      return 'Withdrawn';
    case 'Closed':
      return 'Closed';
    case 'Not Applied':
    default:
      return 'Discovered';
  }
};

export const getNextActionDueDate = (status: ApplicationStatus, currentStage?: string | null, referenceDate: Date = new Date()) => {
  switch (status) {
    case 'Applied':
      return subDays(referenceDate, -10);
    case 'OA':
      return subDays(referenceDate, -3);
    case 'Recruiter Screen':
    case 'Technical Interview':
    case 'Final Round':
      return subDays(referenceDate, -1);
    case 'Offer':
      return subDays(referenceDate, -7);
    default:
      return subDays(referenceDate, 2);
  }
};

export const formatDisplayDate = (value: Date | string | null | undefined) => {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  return format(date, 'MMM d, yyyy');
};
