import { format as formatFn } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

// This module is the single place that knows how to parse and format the
// different kinds of date values this app deals with:
//   - date-only values ("2026-08-15", from an <input type="date">)
//   - datetime-local values ("2026-08-15T14:00", from <input type="datetime-local">)
//   - zoned datetimes (a datetime-local value plus an explicit IANA timezone,
//     e.g. an interview's scheduledStart/scheduledEnd)
//   - stored timestamps (createdAt, activity logs, etc.)
//
// Mixing these up is what caused the original bugs: a bare
// `new Date('2026-08-15')` anchors a date-only value at UTC midnight, so a
// formatter that reads *local* calendar fields can show the wrong day; and a
// bare `new Date('2026-08-15T14:00')` parses using whatever timezone the
// *server process* happens to be running in, not the timezone the user
// actually meant, silently corrupting interview times.

const isRealCalendarDate = (year: number, month: number, day: number): boolean => {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_COMPONENTS_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * True for a bare `<input type="date">` value, e.g. "2026-08-15" — and only
 * if it's a real calendar date. JS's `Date` constructor silently rolls
 * invalid dates like "2026-02-31" over into a different (valid) date instead
 * of rejecting them, so the shape check alone isn't enough.
 */
export const isDateOnlyString = (value: string): boolean => {
  const match = DATE_ONLY_PATTERN.exec(value.trim());
  if (!match) return false;
  const [, y, m, d] = match;
  return isRealCalendarDate(Number(y), Number(m), Number(d));
};

/**
 * True for a bare `<input type="datetime-local">` value, e.g.
 * "2026-08-15T14:00" (optionally with seconds/ms, and tolerant of a trailing
 * "Z"/offset so full ISO timestamps are also accepted) — and only if both
 * the date and time components are real (rejects "2026-02-31T10:00" and
 * "2026-08-15T25:70" alike, rather than letting `Date` silently roll them
 * over).
 */
export const isDateTimeLocalString = (value: string): boolean => {
  const trimmed = value.trim();
  const match = DATETIME_COMPONENTS_PATTERN.exec(trimmed);
  if (!match) return false;
  const [, y, m, d, hh, mm, ss] = match;
  if (!isRealCalendarDate(Number(y), Number(m), Number(d))) return false;
  const hours = Number(hh);
  const minutes = Number(mm);
  const seconds = ss ? Number(ss) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return false;
  return !Number.isNaN(new Date(trimmed).getTime());
};

/** True for a value `Intl` recognizes as an IANA timezone identifier, e.g. "America/Los_Angeles". */
export const isValidIanaTimeZone = (value: string): boolean => {
  if (!value.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/** @deprecated kept for any external callers that only need "is this a valid date/time string at all". */
export const isParseableDate = (value: string): boolean => !Number.isNaN(new Date(value).getTime());

/**
 * Parses an HTML `<input type="date">` value. Date-only values are anchored
 * to UTC midnight so they round-trip through storage without picking up a
 * timezone; pair this with `formatDateOnly` (never a plain `format()` call)
 * when displaying the result. Accepts `unknown` because callers sometimes
 * pass through loosely-typed payload fields that may be missing at runtime
 * even where the static type claims otherwise.
 */
export const parseDateOnly = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!isDateOnlyString(trimmed)) return null;
  const date = new Date(`${trimmed}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Parses an HTML `<input type="datetime-local">` value, or any other
 * timestamp string that already carries a time component, as *local server
 * time*. This is only correct when the value doesn't actually depend on a
 * specific timezone the user picked — e.g. "record this timestamp now" —
 * NOT for anything like an interview time, where the user selected a
 * specific IANA zone that may differ from wherever this code happens to be
 * running. Use `parseZonedDateTime` for those.
 */
export const parseDateTimeLocal = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Parses a datetime-local value ("2026-08-15T14:00") as wall-clock time
 * *in the given IANA timezone*, returning the equivalent, unambiguous UTC
 * instant — regardless of what timezone the server process itself is
 * running in. This is the correct way to interpret an interview's
 * scheduledStart/scheduledEnd, which the user picked in a specific zone.
 */
export const parseZonedDateTime = (value: unknown, timeZone: unknown): Date | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (typeof timeZone !== 'string' || !isValidIanaTimeZone(timeZone)) return null;
  try {
    const date = fromZonedTime(value.trim(), timeZone);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
};

/** Parses an already-serialized timestamp (Prisma/JSON output, `Date.now()`, etc.) as-is. */
export const parseTimestamp = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Formats a date-only value by reading its UTC calendar fields, so the same
 * calendar day is displayed everywhere regardless of the viewer's local
 * timezone. Use this — never `format()` directly — for anything sourced
 * from `parseDateOnly` (offer dates, decision deadlines, application dates,
 * follow-up dates, etc).
 */
export const formatDateOnly = (value: Date | string | null | undefined, pattern = 'MMM d, yyyy'): string => {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  const localAligned = new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return formatFn(localAligned, pattern);
};

/** Formats a real timestamp (datetime-local-derived or system-generated) in the viewer's local time. */
export const formatTimestamp = (value: Date | string | null | undefined, pattern = 'MMM d, yyyy h:mm a'): string => {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return formatFn(date, pattern);
};

/** Formats a stored UTC instant in a specific IANA timezone (e.g. an interview's own timezone), independent of the viewer's local timezone. */
export const formatInZone = (value: Date | string | null | undefined, timeZone: string | null | undefined, pattern = 'MMM d, yyyy h:mm a zzz'): string => {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  if (!timeZone || !isValidIanaTimeZone(timeZone)) return formatTimestamp(date, pattern.replace(' zzz', ''));
  try {
    return formatInTimeZone(date, timeZone, pattern);
  } catch {
    return formatTimestamp(date, pattern.replace(' zzz', ''));
  }
};

/**
 * Deadline-shaped fields (like `nextActionDue`) are populated from either a
 * date-only source (e.g. an offer decision deadline) or a real timestamp
 * (e.g. "one day before the interview"), depending on which workflow last
 * touched the application. Which one applies is tracked explicitly wherever
 * the value is stored (see `nextActionDueKind` on the Application model) —
 * deliberately NOT inferred from the value itself (a real timestamp can
 * legitimately land on exact UTC midnight, e.g. an 8:00 PM America/New_York
 * OA deadline during daylight saving time), so callers must say which kind
 * they have.
 */
export type DeadlineKind = 'date' | 'timestamp';

export const formatByKind = (value: Date | string | null | undefined, kind: DeadlineKind, pattern?: string): string =>
  kind === 'date' ? formatDateOnly(value, pattern) : formatTimestamp(value, pattern);

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * Resolves a deadline-shaped value (see `DeadlineKind`) to the single UTC
 * instant it's effectively "due at" — the shared primitive behind overdue
 * checks, "soon" urgency, and sorting, so all three treat date-vs-timestamp
 * deadlines the same way instead of drifting apart:
 *
 * - `timestamp` values already represent a specific moment — returned as-is.
 * - `date` values are calendar dates with no time component, resolved to the
 *   end of that calendar day in `userTimeZone` — an August 15 deadline is
 *   effectively due at the end of August 15 in the user's zone, not at UTC
 *   midnight on the 15th. Resolving it any other way (e.g. treating it as
 *   due at its own UTC-midnight-anchored instant) would sort it before same
 *   day timestamp deadlines that are actually earlier, and would mark it
 *   overdue as early as the previous evening for anyone west of UTC.
 *
 * Returns `null` for a missing/invalid value.
 */
export const resolveDeadlineInstant = (
  value: Date | string | null | undefined,
  kind: DeadlineKind,
  userTimeZone: string,
): Date | null => {
  if (!value) return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;

  if (kind === 'timestamp') return date;

  // `date`-kind values are anchored at UTC midnight by `parseDateOnly`, so
  // their intended calendar day lives in the UTC fields, not the local ones.
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  const zone = isValidIanaTimeZone(userTimeZone) ? userTimeZone : 'UTC';
  // The deadline's calendar day ends the moment the *next* day begins in the
  // user's timezone — construct that next-day boundary as a naive
  // datetime-local string and interpret it in `zone` (via
  // `parseZonedDateTime`) to get the correct UTC instant, handling
  // month/year rollover for free via the UTC Date constructor.
  const nextDayUtc = new Date(Date.UTC(year, month, day + 1));
  const nextDayString = `${nextDayUtc.getUTCFullYear()}-${pad2(nextDayUtc.getUTCMonth() + 1)}-${pad2(nextDayUtc.getUTCDate())}T00:00:00`;
  return parseZonedDateTime(nextDayString, zone) ?? nextDayUtc;
};

/**
 * Whether a deadline-shaped value (see `DeadlineKind`) counts as overdue
 * right now. See `resolveDeadlineInstant` for how date-vs-timestamp kinds
 * are each resolved to a single instant.
 */
export const isDeadlineOverdue = (
  value: Date | string | null | undefined,
  kind: DeadlineKind,
  userTimeZone: string,
  now: Date = new Date(),
): boolean => {
  const instant = resolveDeadlineInstant(value, kind, userTimeZone);
  if (!instant) return false;
  // A 'date' deadline is overdue starting exactly at its end-of-day
  // boundary (that boundary IS the moment it becomes overdue); a
  // 'timestamp' deadline isn't overdue until strictly after its instant.
  return kind === 'date' ? now.getTime() >= instant.getTime() : instant.getTime() < now.getTime();
};
