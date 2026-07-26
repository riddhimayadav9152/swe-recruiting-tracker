import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatDateOnly,
  formatFlexibleDate,
  formatTimestamp,
  isDateOnlyString,
  isDateTimeLocalString,
  parseDateOnly,
  parseDateTimeLocal,
  parseTimestamp,
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
    expect(isDateTimeLocalString('2026-08-15')).toBe(false);
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

describe('formatFlexibleDate auto-detects date-only vs timestamp', () => {
  for (const tz of TIME_ZONES) {
    it(`formats a UTC-midnight value as a date-only value in ${tz}`, () => {
      withTimeZone(tz, () => {
        const dateOnly = parseDateOnly('2026-08-15')!;
        expect(formatFlexibleDate(dateOnly)).toBe('Aug 15, 2026');
      });
    });
  }

  it('formats a genuine timestamp using local time, not UTC extraction', () => {
    const timestamp = parseDateTimeLocal('2026-08-15T23:30')!;
    expect(formatFlexibleDate(timestamp)).toBe(formatTimestamp(timestamp, 'MMM d, yyyy'));
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
