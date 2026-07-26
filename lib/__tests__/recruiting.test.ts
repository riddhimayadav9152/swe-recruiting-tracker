import { describe, expect, it } from 'vitest';
import {
  detectDuplicate,
  generateApplicationCode,
  generateNextAction,
  getDeadlineUrgency,
  getNextActionDueDate,
  parseExcelDateValue,
  validateApplicationInput,
} from '../recruiting';

describe('recruiting helpers', () => {
  it('generates a stable application code', () => {
    expect(generateApplicationCode('Google', 'Software Engineer', new Date('2026-07-26'))).toBe('GOOG-SOFT-260725');
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
    const existingCodes = ['GOOG-SOFT-260725', 'GOOG-SOFT-260725-2'];
    expect(generateApplicationCode('Google', 'Software Engineer', new Date('2026-07-26'), existingCodes)).toBe('GOOG-SOFT-260725-3');
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

  it('parses Excel-like dates', () => {
    expect(parseExcelDateValue('2026-07-26')).toBeInstanceOf(Date);
  });

  it('validates required fields', () => {
    const errors = validateApplicationInput({ company: '', role: '', applicationUrl: '', priority: 'P2' });
    expect(errors.company).toBeDefined();
    expect(errors.role).toBeDefined();
    expect(errors.applicationUrl).toBeDefined();
  });

  it('creates a default next action due date', () => {
    const due = getNextActionDueDate('Applied', undefined, new Date('2026-07-20'));
    expect(due.toDateString()).toBe('Wed Jul 29 2026');
  });
});
