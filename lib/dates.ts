import { format as formatFn } from 'date-fns';

// This module is the single place that knows how to parse and format the
// three different kinds of date values this app deals with. Mixing them up
// is what caused the original bug: an HTML `<input type="date">` value like
// "2026-08-15" has no time-of-day or timezone attached to it, so parsing it
// with a bare `new Date('2026-08-15')` anchors it at UTC midnight. If that
// instant is later displayed with a formatter that reads *local* calendar
// fields (as date-fns' `format` does), a viewer west of UTC sees "Aug 14"
// instead of "Aug 15". datetime-local values ("2026-08-15T14:00") and real
// timestamps (createdAt, activity logs, etc.) don't have this problem: they
// already represent an unambiguous instant, so local-time parsing/formatting
// is correct for them.

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** True for a bare `<input type="date">` value, e.g. "2026-08-15". */
export const isDateOnlyString = (value: string): boolean => DATE_ONLY_PATTERN.test(value.trim());

/** True for a bare `<input type="datetime-local">` value, e.g. "2026-08-15T14:00". */
export const isDateTimeLocalString = (value: string): boolean => DATETIME_LOCAL_PATTERN.test(value.trim());

const isParseableDate = (value: string): boolean => !Number.isNaN(new Date(value).getTime());

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
 * timestamp string that already carries a time component. These represent a
 * specific wall-clock moment (in the local case, the user's own timezone at
 * the moment they picked it), so ordinary local-time parsing is correct.
 */
export const parseDateTimeLocal = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
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

/**
 * Some fields (like `nextActionDue`) are populated from either a date-only
 * source (e.g. an offer decision deadline) or a real timestamp (e.g. "one
 * day before the interview"), depending on which workflow last touched the
 * application. Every date-only value this app stores is anchored at UTC
 * midnight (see `parseDateOnly`), and a genuine timestamp landing on exact
 * UTC midnight is practically impossible, so that's a reliable signal for
 * which formatter to use.
 */
export const formatFlexibleDate = (value: Date | string | null | undefined, pattern = 'MMM d, yyyy'): string => {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  const isMidnightUtc = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  return isMidnightUtc ? formatDateOnly(date, pattern) : formatFn(date, pattern);
};

export { isParseableDate };
