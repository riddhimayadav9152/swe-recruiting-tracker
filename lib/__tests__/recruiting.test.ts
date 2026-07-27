import { describe, expect, it } from 'vitest';
import {
  deriveInitialStage,
  detectDuplicate,
  generateApplicationCode,
  generateNextAction,
  getDeadlineUrgency,
  getNextActionDueDate,
  parseExcelDateOnlyValue,
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

  it('parses Excel-like dates into bare YYYY-MM-DD strings, never full timestamps', () => {
    expect(parseExcelDateOnlyValue('2026-07-26')).toBe('2026-07-26');
    expect(parseExcelDateOnlyValue('8/15/2026')).toBe('2026-08-15');
    // An Excel serial date number (what xlsx returns for a date-formatted
    // cell when cellDates isn't set) must round-trip to the same calendar
    // day regardless of the server's own timezone.
    expect(parseExcelDateOnlyValue(46249)).toBe('2026-08-15');
    expect(parseExcelDateOnlyValue(new Date(Date.UTC(2026, 7, 15)))).toBe('2026-08-15');
  });

  it('rejects unrecognizable or impossible Excel date values instead of guessing', () => {
    expect(parseExcelDateOnlyValue('not a date')).toBeNull();
    expect(parseExcelDateOnlyValue('2026-02-31')).toBeNull();
    expect(parseExcelDateOnlyValue('')).toBeNull();
    expect(parseExcelDateOnlyValue(null)).toBeNull();
    expect(parseExcelDateOnlyValue(undefined)).toBeNull();
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
