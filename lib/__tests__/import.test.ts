import { describe, expect, it } from 'vitest';
import { validateImportRow } from '../import';

describe('validateImportRow', () => {
  it('normalizes a well-formed row and preserves an August 15 deadline exactly as August 15', () => {
    const outcome = validateImportRow({
      Company: 'Acme',
      Role: 'Software Engineer',
      URL: 'https://acme.com/apply',
      Priority: 'P1',
      Status: 'Applied',
      'Application Deadline': '2026-08-15',
      'Date Found': '2026-07-01',
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) throw new Error('expected success');
    expect(outcome.data.applicationDeadline).toBe('2026-08-15');
    expect(outcome.data.dateFound).toBe('2026-07-01');
    expect(outcome.data.status).toBe('Applied');
    expect(outcome.data.priority).toBe('P1');
  });

  it('preserves an August 15 deadline given as an Excel serial date number, regardless of format', () => {
    // 46249 is the Excel serial number for 2026-08-15 (days since the Excel
    // epoch of 1899-12-30) — what `xlsx` returns for a date-formatted cell
    // when cellDates isn't enabled.
    const outcome = validateImportRow({
      Company: 'Acme',
      Role: 'Software Engineer',
      URL: 'https://acme.com/apply',
      'Application Deadline': 46249,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) throw new Error('expected success');
    expect(outcome.data.applicationDeadline).toBe('2026-08-15');
  });

  it('preserves an August 15 deadline given as a real Date object (what xlsx returns with cellDates enabled)', () => {
    const outcome = validateImportRow({
      Company: 'Acme',
      Role: 'Software Engineer',
      URL: 'https://acme.com/apply',
      'Application Deadline': new Date(Date.UTC(2026, 7, 15)),
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) throw new Error('expected success');
    expect(outcome.data.applicationDeadline).toBe('2026-08-15');
  });

  it('defaults priority to P2 and status to Not Applied when the columns are absent', () => {
    const outcome = validateImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) throw new Error('expected success');
    expect(outcome.data.priority).toBe('P2');
    expect(outcome.data.status).toBe('Not Applied');
  });

  it('rejects (never silently coerces) an invalid priority value', () => {
    const outcome = validateImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Priority: 'SUPER URGENT' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) throw new Error('expected failure');
    expect(outcome.errors.some((message) => message.includes('Priority'))).toBe(true);
  });

  it('rejects (never silently coerces) an invalid status value', () => {
    const outcome = validateImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'In Progress' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) throw new Error('expected failure');
    expect(outcome.errors.some((message) => message.includes('Status'))).toBe(true);
  });

  it('rejects an invalid application URL', () => {
    const outcome = validateImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'not-a-url' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) throw new Error('expected failure');
    expect(outcome.errors.some((message) => message.toLowerCase().includes('url'))).toBe(true);
  });

  it('rejects a missing company or role', () => {
    const missingCompany = validateImportRow({ Role: 'Software Engineer', URL: 'https://acme.com/apply' });
    expect(missingCompany.ok).toBe(false);
    const missingRole = validateImportRow({ Company: 'Acme', URL: 'https://acme.com/apply' });
    expect(missingRole.ok).toBe(false);
  });

  it('rejects an unrecognizable Application Deadline instead of silently dropping it', () => {
    const outcome = validateImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', 'Application Deadline': 'sometime next week' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) throw new Error('expected failure');
    expect(outcome.errors.some((message) => message.includes('Application Deadline'))).toBe(true);
  });

  it('rejects an impossible calendar date rather than rolling it over', () => {
    const outcome = validateImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', 'Application Deadline': '2026-02-31' });
    expect(outcome.ok).toBe(false);
  });

  it('treats a fully blank row as blank, not an error', () => {
    const outcome = validateImportRow({});
    expect(outcome.ok).toBe('blank');
  });

  it('accumulates multiple errors on the same row rather than stopping at the first', () => {
    const outcome = validateImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'not-a-url', Priority: 'URGENT', Status: 'In Progress' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) throw new Error('expected failure');
    expect(outcome.errors.length).toBeGreaterThanOrEqual(3);
  });
});
