import { describe, expect, it } from 'vitest';
import {
  computePersonalApplyByDate,
  deriveInitialStage,
  detectDuplicate,
  generateApplicationCode,
  generateNextAction,
  getDeadlineUrgency,
  getNextActionDueDate,
  nextBusinessDay,
  validateApplicationInput,
} from '../recruiting';
import { parseDateOnly } from '../dates';

describe('recruiting helpers', () => {
  it('generates a stable application code', () => {
    // Use the local-time Date constructor (year, month, day), not an ISO
    // date-only string — a bare "2026-07-26" parses as UTC midnight, which
    // reads back as July 25 in any timezone behind UTC, making the test's
    // expected value depend on the machine running it.
    expect(generateApplicationCode('Google', 'Software Engineer', new Date(2026, 6, 26))).toBe('GOOG-SOFT-260726');
  });

  it('detects likely duplicates', () => {
    const existing = [{ company: 'Google', role: 'Software Engineer', applicationUrl: 'https://example.com' }];
    const duplicate = detectDuplicate(existing, {
      company: 'Google',
      role: 'Software Engineer',
      applicationUrl: 'https://example.com',
      priority: 'P1',
    });
    expect(duplicate).toBeDefined();
  });

  it('creates a unique application code when the base code already exists', () => {
    const existingCodes = ['GOOG-SOFT-260726', 'GOOG-SOFT-260726-2'];
    expect(generateApplicationCode('Google', 'Software Engineer', new Date(2026, 6, 26), existingCodes)).toBe('GOOG-SOFT-260726-3');
  });

  it('suggests next actions from status', () => {
    expect(generateNextAction('Applied')).toBe('Check email and candidate portal');
    expect(generateNextAction('Offer')).toBe('Review, compare and respond to offer');
  });

  it('flags deadlines that are urgent', () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 2);
    expect(getDeadlineUrgency(soon)).toBe('soon');
  });

  it('resolves a date-kind deadline to its end-of-day instant (not its raw UTC-midnight value) for "soon" classification', () => {
    // The "soon" cutoff is now + 3 days = 2026-08-16T02:00:00Z, which falls
    // BETWEEN the deadline's two possible end-of-day instants: end-of-day
    // UTC (2026-08-16T00:00Z) is before it, but end-of-day America/New_York
    // (2026-08-16T04:00Z, since midnight EDT is 4 hours after UTC midnight)
    // is after it — so the same stored value is "soon" for a UTC user but
    // merely "normal" for a New York user, depending entirely on which
    // timezone's calendar day it's actually due at the end of.
    const now = new Date('2026-08-13T02:00:00.000Z');
    const deadline = new Date('2026-08-15T00:00:00.000Z');
    expect(getDeadlineUrgency(deadline, 'date', 'UTC', now)).toBe('soon');
    expect(getDeadlineUrgency(deadline, 'date', 'America/New_York', now)).toBe('normal');
  });

  it('validates required fields', () => {
    const errors = validateApplicationInput({ company: '', role: '', applicationUrl: '', priority: 'P2' });
    expect(errors.company).toBeDefined();
    expect(errors.role).toBeDefined();
    expect(errors.applicationUrl).toBeDefined();
  });

  it('creates a default next action due date', () => {
    const due = getNextActionDueDate('Applied', undefined, new Date(2026, 6, 20));
    expect(due.toDateString()).toBe('Thu Jul 30 2026');
  });

  it('derives a compatible current stage from status, never accepting an arbitrary one', () => {
    expect(deriveInitialStage('Not Applied')).toBe('Discovered');
    expect(deriveInitialStage('Preparing')).toBe('Preparing');
    expect(deriveInitialStage('Applied')).toBe('Application Submitted');
    expect(deriveInitialStage('OA')).toBe('Online Assessment');
    expect(deriveInitialStage('Recruiter Screen')).toBe('Recruiter Screen');
    expect(deriveInitialStage('Offer')).toBe('Offer Received');
    expect(deriveInitialStage('Rejected')).toBe('Rejected');
  });
});

describe('computePersonalApplyByDate', () => {
  const dateFound = parseDateOnly('2026-07-01')!;

  it.each([
    ['P0', 2], ['P1', 4], ['P2', 7], ['P3', 14],
  ] as const)('adds the priority-scaled number of days after dateFound for %s (+%d days)', (priority, days) => {
    const result = computePersonalApplyByDate({ priority, dateFound });
    expect(result.toISOString().slice(0, 10)).toBe(parseDateOnly(`2026-07-${String(1 + days).padStart(2, '0')}`)!.toISOString().slice(0, 10));
  });

  it('defaults the reference date to today (UTC) when dateFound is not supplied', () => {
    const result = computePersonalApplyByDate({ priority: 'P0' });
    const today = new Date();
    const expected = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 2));
    expect(result.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it('uses the known opening date as the base candidate when Opening Soon', () => {
    const openingDate = parseDateOnly('2026-08-01')!;
    const result = computePersonalApplyByDate({ priority: 'P3', dateFound, postingStatus: 'Opening Soon', postingDate: openingDate });
    expect(result.toISOString().slice(0, 10)).toBe('2026-08-01');
  });

  it('ignores the opening date when postingStatus is not "Opening Soon"', () => {
    const openingDate = parseDateOnly('2026-08-01')!;
    const result = computePersonalApplyByDate({ priority: 'P0', dateFound, postingStatus: 'Open', postingDate: openingDate });
    // P0 -> dateFound + 2 days = 2026-07-03, NOT the opening date.
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-03');
  });

  it('caps the personal deadline at two days before an official deadline when that is earlier than the priority date', () => {
    // P3 would normally be dateFound + 14 days (2026-07-15), but the
    // official deadline is only 3 days out (2026-07-04) — two days before
    // that (2026-07-02) is earlier, so it wins.
    const applicationDeadline = parseDateOnly('2026-07-04')!;
    const result = computePersonalApplyByDate({ priority: 'P3', dateFound, applicationDeadline, today: dateFound });
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-02');
  });

  it('never generates a personal deadline after the official deadline, even when two-days-before would be later than the priority date', () => {
    // P0 -> dateFound + 2 days = 2026-07-03. The official deadline is
    // 2026-07-10, so two-days-before (2026-07-08) is LATER than the P0
    // candidate — the earlier of the two (2026-07-03) should still win,
    // and it must never exceed the official deadline itself either way.
    const applicationDeadline = parseDateOnly('2026-07-10')!;
    const result = computePersonalApplyByDate({ priority: 'P0', dateFound, applicationDeadline, today: dateFound });
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-03');
    expect(result.getTime()).toBeLessThanOrEqual(applicationDeadline.getTime());
  });

  it('clamps a near future official deadline to today when the two-day buffer has already passed', () => {
    const applicationDeadline = parseDateOnly('2026-07-02')!;
    const result = computePersonalApplyByDate({ priority: 'P3', dateFound, applicationDeadline, today: parseDateOnly('2026-07-01')! });
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('preserves a past official deadline as an overdue personal deadline', () => {
    const applicationDeadline = parseDateOnly('2026-07-02')!;
    const result = computePersonalApplyByDate({ priority: 'P3', dateFound, applicationDeadline, today: parseDateOnly('2026-07-10')! });
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-02');
  });

  it('does not generate an apply-by date before the date found unless the official deadline is already past', () => {
    const applicationDeadline = parseDateOnly('2026-07-03')!;
    const result = computePersonalApplyByDate({ priority: 'P3', dateFound: parseDateOnly('2026-07-02')!, applicationDeadline, today: parseDateOnly('2026-07-02')! });
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-02');
  });
});

describe('nextBusinessDay', () => {
  it('returns the very next day when it is a weekday', () => {
    // Wednesday 2026-07-01 -> Thursday 2026-07-02
    const result = nextBusinessDay(parseDateOnly('2026-07-01')!);
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-02');
  });

  it('skips Saturday, landing on Monday', () => {
    // Friday 2026-07-03 -> Monday 2026-07-06
    const result = nextBusinessDay(parseDateOnly('2026-07-03')!);
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-06');
  });

  it('skips Sunday, landing on Monday', () => {
    // Saturday 2026-07-04 -> Monday 2026-07-06
    const result = nextBusinessDay(parseDateOnly('2026-07-04')!);
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-06');
  });
});
