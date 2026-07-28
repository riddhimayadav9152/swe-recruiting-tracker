import { describe, expect, it } from 'vitest';
import {
  deriveInitialStage,
  detectDuplicate,
  generateApplicationCode,
  generateNextAction,
  getDeadlineUrgency,
  getNextActionDueDate,
  validateApplicationInput,
} from '../recruiting';

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
    expect(generateNextAction('Applied')).toBe('Monitor application and email');
    expect(generateNextAction('Offer')).toBe('Review, compare, and respond to offer');
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
