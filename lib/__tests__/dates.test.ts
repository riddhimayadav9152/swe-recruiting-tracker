import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatByKind,
  formatDateOnly,
  formatInZone,
  formatTimestamp,
  isDateOnlyString,
  isDateTimeLocalString,
  isValidIanaTimeZone,
  parseDateOnly,
  parseDateTimeLocal,
  parseTimestamp,
  parseZonedDateTime,
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
