import { format, subDays } from 'date-fns';
import { addUtcDays, isDeadlineOverdue, resolveDeadlineInstant, utcToday, type DeadlineKind } from '@/lib/dates';

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

export const postingStatuses = ['Open', 'Opening Soon', 'Closed', 'Unknown'] as const;

export type ApplicationStatus = (typeof statuses)[number];
export type Priority = (typeof priorities)[number];
export type PostingStatus = (typeof postingStatuses)[number];

export const TERMINAL_STATUSES: readonly ApplicationStatus[] = ['Accepted', 'Rejected', 'Withdrawn', 'Closed'];

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

export type DeadlineUrgency = 'none' | 'overdue' | 'soon' | 'normal';

export const getDeadlineUrgency = (
  date: Date | null,
  kind: DeadlineKind = 'timestamp',
  userTimeZone = 'UTC',
  now: Date = new Date(),
): DeadlineUrgency => {
  if (!date) return 'none';
  if (isDeadlineOverdue(date, kind, userTimeZone, now)) return 'overdue';
  const instant = resolveDeadlineInstant(date, kind, userTimeZone);
  if (instant && instant.getTime() <= subDays(now, -3).getTime()) return 'soon';
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

// --- Personal deadline generation --------------------------------------------
//
// `nextActionDue` is the user's OWN personal action deadline — distinct from
// `applicationDeadline`, the employer's official deadline (displayed
// separately, for context only). These rules generate a personal apply-by
// date for a newly created or imported Not Applied/Preparing application
// when one isn't explicitly supplied.

const PRIORITY_APPLY_BY_DAYS: Record<Priority, number> = { P0: 2, P1: 4, P2: 7, P3: 14 };

export type PersonalApplyByInput = {
  priority: Priority;
  /** Defaults to today (UTC) when not supplied. */
  dateFound?: Date | null;
  applicationDeadline?: Date | null;
  postingStatus?: string | null;
  /** Only consulted when postingStatus is "Opening Soon" — treated as the known opening date. */
  postingDate?: Date | null;
};

/**
 * Generates the personal "apply by" deadline used when a new/imported
 * Not Applied or Preparing application doesn't already have its own
 * `nextActionDue`:
 *  - a priority-scaled number of days after `dateFound` (P0 fastest, P3
 *    slowest) as the base candidate;
 *  - UNLESS the posting is "Opening Soon" with a known opening date, in
 *    which case the opening date itself is the base candidate instead;
 *  - then, if an official `applicationDeadline` is known, capped to the
 *    EARLIER of that base candidate or two days before the official
 *    deadline;
 *  - and finally clamped so the result is NEVER later than the official
 *    deadline itself.
 * Always returns a date-only value (UTC-midnight-anchored, matching
 * `parseDateOnly`'s own convention) — never a real timestamp.
 */
export function computePersonalApplyByDate(input: PersonalApplyByInput): Date {
  const referenceDate = input.dateFound ?? utcToday();
  let candidate = addUtcDays(referenceDate, PRIORITY_APPLY_BY_DAYS[input.priority]);

  if (input.postingStatus === 'Opening Soon' && input.postingDate) {
    candidate = input.postingDate;
  }

  if (input.applicationDeadline) {
    const twoDaysBeforeOfficial = addUtcDays(input.applicationDeadline, -2);
    if (twoDaysBeforeOfficial.getTime() < candidate.getTime()) candidate = twoDaysBeforeOfficial;
    if (candidate.getTime() > input.applicationDeadline.getTime()) candidate = input.applicationDeadline;
  }

  return candidate;
}

/** The next Monday–Friday calendar day after `date` (skips Saturday/Sunday) — used for "follow up next business day" workflow defaults. */
export function nextBusinessDay(date: Date): Date {
  let next = addUtcDays(date, 1);
  const day = next.getUTCDay();
  if (day === 6) next = addUtcDays(next, 2);
  else if (day === 0) next = addUtcDays(next, 1);
  return next;
}
