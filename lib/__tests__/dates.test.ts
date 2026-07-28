import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatByKind,
  formatDateOnly,
  formatInZone,
  formatTimestamp,
  isDateOnlyString,
  isDateTimeLocalString,
  isDeadlineOverdue,
  isValidIanaTimeZone,
  parseDateOnly,
  parseDateTimeLocal,
  parseTimestamp,
  parseZonedDateTime,
  resolveDeadlineInstant,
} from '../dates';

const TIME_ZONES = ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Midway', 'Asia/Tokyo'];

const withTimeZone = (tz: string, fn: () => void) => {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    process.env.TZ = original;
  }
};

describe('date-only vs datetime-local detection', () => {
  it('recognizes date-only strings', () => {
    expect(isDateOnlyString('2026-08-15')).toBe(true);
    expect(isDateOnlyString(' 2026-08-15 ')).toBe(true);
    expect(isDateOnlyString('2026-08-15T14:00')).toBe(false);
    expect(isDateOnlyString('not-a-date')).toBe(false);
  });

  it('recognizes datetime-local strings', () => {
    expect(isDateTimeLocalString('2026-08-15T14:00')).toBe(true);
    expect(isDateTimeLocalString('2026-08-15T14:00:00')).toBe(true);
    expect(isDateTimeLocalString('2026-08-15T14:00:00.000Z')).toBe(true);
    expect(isDateTimeLocalString('2026-08-15')).toBe(false);
  });
});

describe('real calendar date validation', () => {
  it('rejects impossible date-only values instead of letting them silently roll over', () => {
    expect(isDateOnlyString('2026-02-31')).toBe(false);
    expect(isDateOnlyString('2026-04-31')).toBe(false);
    expect(isDateOnlyString('2026-13-01')).toBe(false);
    expect(isDateOnlyString('2026-00-10')).toBe(false);
    expect(isDateOnlyString('2026-01-00')).toBe(false);
  });

  it('rejects non-leap-year February 29 but accepts it in a leap year', () => {
    expect(isDateOnlyString('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isDateOnlyString('2024-02-29')).toBe(true); // 2024 is a leap year
    expect(isDateOnlyString('2000-02-29')).toBe(true); // divisible by 400 -> leap
    expect(isDateOnlyString('1900-02-29')).toBe(false); // divisible by 100 but not 400 -> not leap
  });

  it('parseDateOnly returns null for impossible calendar dates', () => {
    expect(parseDateOnly('2026-02-31')).toBeNull();
    expect(parseDateOnly('2026-04-31')).toBeNull();
    expect(parseDateOnly('2026-02-29')).toBeNull();
    expect(parseDateOnly('2024-02-29')).not.toBeNull();
  });

  it('rejects impossible calendar dates and impossible times in datetime-local values', () => {
    expect(isDateTimeLocalString('2026-02-31T10:00')).toBe(false);
    expect(isDateTimeLocalString('2026-08-15T25:00')).toBe(false);
    expect(isDateTimeLocalString('2026-08-15T10:70')).toBe(false);
    expect(isDateTimeLocalString('2026-08-15T10:00:70')).toBe(false);
  });
});

describe('parseDateOnly / parseDateTimeLocal / parseTimestamp', () => {
  it('parses a date-only value to UTC midnight', () => {
    const parsed = parseDateOnly('2026-08-15');
    expect(parsed?.toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });

  it('rejects a datetime-local shaped value as date-only', () => {
    expect(parseDateOnly('2026-08-15T14:00')).toBeNull();
  });

  it('returns null for missing or non-string input', () => {
    expect(parseDateOnly(undefined)).toBeNull();
    expect(parseDateOnly(null)).toBeNull();
    expect(parseDateOnly('')).toBeNull();
    expect(parseDateTimeLocal(undefined)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
  });

  it('parses a datetime-local value as a real instant', () => {
    const parsed = parseDateTimeLocal('2026-08-15T14:00');
    expect(parsed).not.toBeNull();
    expect(parsed?.getHours()).toBe(14);
  });

  it('parses an already-serialized timestamp as-is', () => {
    const parsed = parseTimestamp('2026-08-15T18:30:00.000Z');
    expect(parsed?.toISOString()).toBe('2026-08-15T18:30:00.000Z');
  });
});

describe('isValidIanaTimeZone', () => {
  it('accepts real IANA identifiers', () => {
    expect(isValidIanaTimeZone('America/New_York')).toBe(true);
    expect(isValidIanaTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidIanaTimeZone('UTC')).toBe(true);
  });

  it('rejects garbage input', () => {
    expect(isValidIanaTimeZone('')).toBe(false);
    expect(isValidIanaTimeZone('Not/AZone')).toBe(false);
    expect(isValidIanaTimeZone('PDT')).toBe(false); // not a recognized zone identifier at all
  });
});

describe('parseZonedDateTime interprets a wall-clock time in the SELECTED zone, not the server process timezone', () => {
  const scenarios: Array<[string, string, string]> = [
    ['America/New_York', '2026-08-15T14:00', '2026-08-15T18:00:00.000Z'], // 2pm EDT (UTC-4)
    ['America/Los_Angeles', '2026-08-15T14:00', '2026-08-15T21:00:00.000Z'], // 2pm PDT (UTC-7)
    ['UTC', '2026-08-15T14:00', '2026-08-15T14:00:00.000Z'],
  ];

  for (const [zone, input, expectedUtc] of scenarios) {
    for (const serverTz of TIME_ZONES) {
      it(`parses ${input} in ${zone} as ${expectedUtc}, regardless of the server running in ${serverTz}`, () => {
        withTimeZone(serverTz, () => {
          const parsed = parseZonedDateTime(input, zone);
          expect(parsed?.toISOString()).toBe(expectedUtc);
        });
      });
    }
  }

  it('a Pacific interview entered from a computer set to Eastern time still resolves to the correct UTC instant', () => {
    withTimeZone('America/New_York', () => {
      // The user is scheduling a 2:00 PM Pacific interview; the server
      // process (and the browser, if the code ran there) happens to be set
      // to Eastern time. The result must reflect Pacific time, not Eastern.
      const parsed = parseZonedDateTime('2026-08-15T14:00', 'America/Los_Angeles');
      expect(parsed?.toISOString()).toBe('2026-08-15T21:00:00.000Z');
      // Sanity check this actually differs from naively parsing as local
      // (Eastern) time, i.e. that the test would catch the regression.
      const naive = new Date('2026-08-15T14:00');
      expect(parsed?.getTime()).not.toBe(naive.getTime());
    });
  });

  it('rejects an invalid IANA timezone', () => {
    expect(parseZonedDateTime('2026-08-15T14:00', 'Not/AZone')).toBeNull();
    expect(parseZonedDateTime('2026-08-15T14:00', '')).toBeNull();
  });

  it('rejects a missing or non-string value', () => {
    expect(parseZonedDateTime(undefined, 'America/New_York')).toBeNull();
    expect(parseZonedDateTime('', 'America/New_York')).toBeNull();
  });
});

describe('formatDateOnly displays the same calendar day in every timezone', () => {
  const stored = parseDateOnly('2026-08-15')!;

  for (const tz of TIME_ZONES) {
    it(`shows August 15 in ${tz}`, () => {
      withTimeZone(tz, () => {
        expect(formatDateOnly(stored)).toBe('Aug 15, 2026');
        expect(formatDateOnly(stored.toISOString())).toBe('Aug 15, 2026');
      });
    });
  }

  it('returns an em dash for null/undefined/invalid values', () => {
    expect(formatDateOnly(null)).toBe('—');
    expect(formatDateOnly(undefined)).toBe('—');
    expect(formatDateOnly('not-a-date')).toBe('—');
  });
});

describe('formatTimestamp reads the local wall-clock time', () => {
  it('formats a real timestamp with its time component', () => {
    const value = parseDateTimeLocal('2026-08-15T14:30')!;
    expect(formatTimestamp(value)).toMatch(/Aug 15, 2026 2:30 PM/);
  });
});

describe('formatInZone formats a stored instant in a specific IANA zone, independent of the viewer', () => {
  it('shows the interview\'s own zone regardless of the server/viewer timezone', () => {
    const utcInstant = parseZonedDateTime('2026-08-15T14:00', 'America/Los_Angeles')!;
    for (const tz of TIME_ZONES) {
      withTimeZone(tz, () => {
        expect(formatInZone(utcInstant, 'America/Los_Angeles')).toBe('Aug 15, 2026 2:00 PM PDT');
      });
    }
  });

  it('falls back to local formatting for a missing/invalid timezone rather than throwing', () => {
    const utcInstant = parseDateTimeLocal('2026-08-15T14:00')!;
    expect(formatInZone(utcInstant, null)).not.toBe('—');
    expect(formatInZone(utcInstant, 'Not/AZone')).not.toBe('—');
  });

  it('returns an em dash for null/undefined/invalid values', () => {
    expect(formatInZone(null, 'America/New_York')).toBe('—');
    expect(formatInZone('not-a-date', 'America/New_York')).toBe('—');
  });
});

describe('formatByKind dispatches on an explicit kind rather than inferring it from the value', () => {
  it('formats a "date" kind using UTC-safe date-only extraction', () => {
    const dateOnly = parseDateOnly('2026-08-15')!;
    expect(formatByKind(dateOnly, 'date')).toBe('Aug 15, 2026');
  });

  it('formats a "timestamp" kind using local time, even when it lands exactly on UTC midnight', () => {
    // Regression case: an OA due at 8:00 PM America/New_York during daylight
    // saving time serializes to exactly midnight UTC. The old heuristic
    // (inferring "date-only" from UTC-midnight) would have mis-rendered
    // this; explicit `kind` must not be fooled by the coincidence.
    const dueAt = parseZonedDateTime('2026-08-15T20:00', 'America/New_York')!;
    expect(dueAt.toISOString()).toBe('2026-08-16T00:00:00.000Z'); // confirms the UTC-midnight setup

    withTimeZone('America/New_York', () => {
      expect(formatByKind(dueAt, 'timestamp')).toBe(formatTimestamp(dueAt));
      expect(formatByKind(dueAt, 'timestamp')).toMatch(/Aug 15, 2026 8:00 PM/);
    });
    withTimeZone('UTC', () => {
      // Viewed from UTC, the same instant is legitimately the next day —
      // proving this is being treated as a real timestamp, not silently
      // re-anchored to a fixed calendar day the way a date-only value would be.
      expect(formatByKind(dueAt, 'timestamp')).toMatch(/Aug 16, 2026 12:00 AM/);
    });
  });

  it('a real timestamp at UTC midnight is NOT reformatted as a fixed calendar day', () => {
    const utcMidnightTimestamp = new Date('2026-08-16T00:00:00.000Z');
    withTimeZone('Pacific/Kiritimati', () => {
      // UTC+14: this instant is already Aug 16, 14:00 local.
      expect(formatByKind(utcMidnightTimestamp, 'timestamp')).toMatch(/Aug 16, 2026 2:00 PM/);
    });
    withTimeZone('Pacific/Midway', () => {
      // UTC-11: this instant is Aug 15, 13:00 local — a DIFFERENT calendar
      // day than in Kiritimati above, exactly as a real timestamp should
      // behave and exactly what the old date-only heuristic would have
      // gotten wrong (it would have shown "Aug 16" in both zones).
      expect(formatByKind(utcMidnightTimestamp, 'timestamp')).toMatch(/Aug 15, 2026 1:00 PM/);
    });
  });
});

describe('resolveDeadlineInstant', () => {
  it('returns a timestamp-kind value as-is', () => {
    const value = new Date('2026-08-15T20:00:00.000Z');
    expect(resolveDeadlineInstant(value, 'timestamp', 'America/New_York')?.toISOString()).toBe('2026-08-15T20:00:00.000Z');
  });

  it('resolves a date-kind value to the end of that calendar day in userTimeZone', () => {
    const value = parseDateOnly('2026-08-15')!;
    expect(resolveDeadlineInstant(value, 'date', 'America/New_York')?.toISOString()).toBe('2026-08-16T04:00:00.000Z'); // midnight EDT
    expect(resolveDeadlineInstant(value, 'date', 'UTC')?.toISOString()).toBe('2026-08-16T00:00:00.000Z');
  });

  it('sorts a same-nominal-day mix of date-kind and timestamp-kind deadlines by their true effective instant', () => {
    const userTimeZone = 'America/New_York';
    // A same-day 8:00 PM EDT timestamp deadline is effectively DUE BEFORE an
    // August 15 date-kind deadline, whose real due moment is the start of
    // August 16 in New York — even though both nominally reference "Aug 15".
    const timestampDeadline = { value: new Date('2026-08-15T20:00:00.000Z'), kind: 'timestamp' as const };
    const dateDeadline = { value: parseDateOnly('2026-08-15')!, kind: 'date' as const };

    const deadlines = [dateDeadline, timestampDeadline];
    const sorted = [...deadlines].sort((a, b) => {
      const aInstant = resolveDeadlineInstant(a.value, a.kind, userTimeZone)!;
      const bInstant = resolveDeadlineInstant(b.value, b.kind, userTimeZone)!;
      return aInstant.getTime() - bInstant.getTime();
    });

    expect(sorted[0]).toBe(timestampDeadline);
    expect(sorted[1]).toBe(dateDeadline);
  });

  it('accounts for DST when resolving a date-kind deadline to its end-of-day instant', () => {
    // Same spring-forward case as the isDeadlineOverdue DST test below: the
    // boundary after March 8, 2026 already observes EDT (UTC-4), not the
    // EST (UTC-5) the deadline's own day started under.
    const value = parseDateOnly('2026-03-08')!;
    expect(resolveDeadlineInstant(value, 'date', 'America/New_York')?.toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });

  it('returns null for a missing or invalid value', () => {
    expect(resolveDeadlineInstant(null, 'date', 'UTC')).toBeNull();
    expect(resolveDeadlineInstant(undefined, 'timestamp', 'UTC')).toBeNull();
  });
});

describe('isDeadlineOverdue', () => {
  it('compares timestamp-kind values as exact instants', () => {
    const value = new Date('2026-08-15T12:00:00.000Z');
    expect(isDeadlineOverdue(value, 'timestamp', 'America/New_York', new Date('2026-08-15T11:59:59.000Z'))).toBe(false);
    expect(isDeadlineOverdue(value, 'timestamp', 'America/New_York', new Date('2026-08-15T12:00:00.000Z'))).toBe(false);
    expect(isDeadlineOverdue(value, 'timestamp', 'America/New_York', new Date('2026-08-15T12:00:01.000Z'))).toBe(true);
  });

  it('never marks an August 15 calendar deadline overdue on August 14 in America/New_York', () => {
    const deadline = parseDateOnly('2026-08-15')!;
    // 4:00 PM EDT on the 14th — clearly still August 14 in New York, and
    // would be wrongly flagged overdue by a naive `new Date(deadline) < now`
    // comparison in any timezone behind UTC.
    const aug14Evening = new Date('2026-08-14T20:00:00.000Z');
    expect(isDeadlineOverdue(deadline, 'date', 'America/New_York', aug14Evening)).toBe(false);
  });

  it('does not mark a date-kind deadline overdue at any point during its own calendar day in America/New_York', () => {
    const deadline = parseDateOnly('2026-08-15')!;
    expect(isDeadlineOverdue(deadline, 'date', 'America/New_York', new Date('2026-08-15T04:00:00.000Z'))).toBe(false); // 12:00 AM EDT
    expect(isDeadlineOverdue(deadline, 'date', 'America/New_York', new Date('2026-08-16T03:59:59.000Z'))).toBe(false); // 11:59:59 PM EDT
  });

  it('marks a date-kind deadline overdue exactly once the next calendar day begins in America/New_York', () => {
    const deadline = parseDateOnly('2026-08-15')!;
    // August 16, 12:00 AM EDT (UTC-4) is 2026-08-16T04:00:00Z.
    expect(isDeadlineOverdue(deadline, 'date', 'America/New_York', new Date('2026-08-16T03:59:59.000Z'))).toBe(false);
    expect(isDeadlineOverdue(deadline, 'date', 'America/New_York', new Date('2026-08-16T04:00:00.000Z'))).toBe(true);
  });

  it('treats a date-kind deadline as due at UTC midnight when userTimeZone is UTC', () => {
    const deadline = parseDateOnly('2026-08-15')!;
    expect(isDeadlineOverdue(deadline, 'date', 'UTC', new Date('2026-08-15T23:59:59.000Z'))).toBe(false);
    expect(isDeadlineOverdue(deadline, 'date', 'UTC', new Date('2026-08-16T00:00:00.000Z'))).toBe(true);
  });

  it('accounts for a spring-forward DST transition in the boundary calculation', () => {
    // US DST begins 2026-03-08 at 2:00 AM local (America/New_York). A
    // deadline dated the day before the change is still due at the
    // following midnight — which, by then, already observes EDT (UTC-4),
    // not the EST (UTC-5) offset the deadline's own day started under.
    const deadline = parseDateOnly('2026-03-08')!;
    expect(isDeadlineOverdue(deadline, 'date', 'America/New_York', new Date('2026-03-09T03:59:59.000Z'))).toBe(false);
    expect(isDeadlineOverdue(deadline, 'date', 'America/New_York', new Date('2026-03-09T04:00:00.000Z'))).toBe(true);
  });

  it('accounts for a fall-back DST transition in the boundary calculation', () => {
    // US DST ends 2026-11-01 at 2:00 AM local — midnight that day is still
    // EDT (UTC-4); the clocks don't fall back to EST until 2:00 AM.
    const deadline = parseDateOnly('2026-10-31')!;
    expect(isDeadlineOverdue(deadline, 'date', 'America/New_York', new Date('2026-11-01T03:59:59.000Z'))).toBe(false);
    expect(isDeadlineOverdue(deadline, 'date', 'America/New_York', new Date('2026-11-01T04:00:00.000Z'))).toBe(true);
  });

  it('returns false for a null/undefined value and falls back to UTC for an invalid timezone', () => {
    expect(isDeadlineOverdue(null, 'date', 'America/New_York')).toBe(false);
    expect(isDeadlineOverdue(undefined, 'timestamp', 'America/New_York')).toBe(false);
    const deadline = parseDateOnly('2026-08-15')!;
    expect(isDeadlineOverdue(deadline, 'date', 'Not/AZone', new Date('2026-08-15T23:59:59.000Z'))).toBe(false);
    expect(isDeadlineOverdue(deadline, 'date', 'Not/AZone', new Date('2026-08-16T00:00:00.000Z'))).toBe(true);
  });
});

describe('TZ environment behavior sanity check', () => {
  let originalTz: string | undefined;

  beforeEach(() => {
    originalTz = process.env.TZ;
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('actually shifts local getters when process.env.TZ changes', () => {
    // Guards the premise the rest of this file relies on: that setting
    // process.env.TZ affects Date's local-time methods within this Node
    // process. If this ever stops being true, the timezone-parameterized
    // tests above would be silently testing nothing.
    const instant = new Date('2026-08-15T02:00:00.000Z');
    process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
    const hoursAhead = instant.getHours();
    process.env.TZ = 'Pacific/Midway'; // UTC-11
    const hoursBehind = instant.getHours();
    expect(hoursAhead).not.toBe(hoursBehind);
  });
});
