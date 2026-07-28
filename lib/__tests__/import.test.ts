import { describe, expect, it } from 'vitest';
import {
  autoDetectColumnMap,
  buildImportPreview,
  computeImportRowDiff,
  detectHeaders,
  isTimeNumberFormat,
  normalizeImportRow,
  parseExcelDateOnlyValue,
  type ColumnMap,
  type ExistingApplicationRecord,
} from '../import';

const BASE_MAP: ColumnMap = autoDetectColumnMap(['Company', 'Role', 'URL', 'Priority', 'Status', 'Application Deadline', 'Date Found', 'Notes']);

describe('parseExcelDateOnlyValue', () => {
  it('parses ISO and US-style date strings', () => {
    expect(parseExcelDateOnlyValue('2026-07-26')).toBe('2026-07-26');
    expect(parseExcelDateOnlyValue('8/15/2026')).toBe('2026-08-15');
  });

  it('round-trips an Excel serial date number to the same calendar day regardless of the server timezone', () => {
    expect(parseExcelDateOnlyValue(46249)).toBe('2026-08-15');
    expect(parseExcelDateOnlyValue(new Date(Date.UTC(2026, 7, 15)))).toBe('2026-08-15');
  });

  it('ignores a fractional time-of-day component on a serial date WITHOUT advancing the calendar day', () => {
    // 46249.75 is Aug 15, 2026, 6:00 PM — a naive `Math.round(46249.75)`
    // would give 46250 (Aug 16), silently advancing the deadline by a day
    // for any fractional value >= .5. The correct behavior is to keep the
    // calendar day and simply discard the time-of-day, since this is a
    // date-only field.
    expect(parseExcelDateOnlyValue(46249.75)).toBe('2026-08-15');
    expect(parseExcelDateOnlyValue(46249.5)).toBe('2026-08-15');
    expect(parseExcelDateOnlyValue(46249.0001)).toBe('2026-08-15');
    expect(parseExcelDateOnlyValue(46249.9999)).toBe('2026-08-15');
  });

  it('rejects unrecognizable or impossible Excel date values instead of guessing', () => {
    expect(parseExcelDateOnlyValue('not a date')).toBeNull();
    expect(parseExcelDateOnlyValue('2026-02-31')).toBeNull();
    expect(parseExcelDateOnlyValue('')).toBeNull();
    expect(parseExcelDateOnlyValue(null)).toBeNull();
    expect(parseExcelDateOnlyValue(undefined)).toBeNull();
  });
});

describe('isTimeNumberFormat', () => {
  it('recognizes date-only Excel number formats', () => {
    expect(isTimeNumberFormat('m/d/yy')).toBe(false);
    expect(isTimeNumberFormat('yyyy-mm-dd')).toBe(false);
  });

  it('recognizes date+time Excel number formats', () => {
    expect(isTimeNumberFormat('m/d/yy h:mm')).toBe(true);
    expect(isTimeNumberFormat('yyyy-mm-dd hh:mm:ss')).toBe(true);
  });

  it('is inconclusive for a missing or generic format', () => {
    expect(isTimeNumberFormat(undefined)).toBeNull();
    expect(isTimeNumberFormat('General')).toBeNull();
  });
});

describe('autoDetectColumnMap', () => {
  it('maps standard headers to their target fields', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Priority', 'Status']);
    expect(map.company).toBe('Company');
    expect(map.role).toBe('Role');
    expect(map.applicationUrl).toBe('URL');
    expect(map.priority).toBe('Priority');
    expect(map.status).toBe('Status');
  });

  it('leaves unmapped fields null when no matching header exists', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL']);
    expect(map.offerDecisionDeadline).toBeNull();
    expect(map.assessmentDueAt).toBeNull();
  });
});

describe('detectHeaders', () => {
  it('collects the union of headers across all rows', () => {
    const headers = detectHeaders([{ Company: 'A', Role: 'B' }, { Company: 'C', Notes: 'D' }]);
    expect(headers.sort()).toEqual(['Company', 'Notes', 'Role']);
  });
});

describe('normalizeImportRow', () => {
  it('normalizes a well-formed row and preserves an August 15 deadline exactly as August 15', () => {
    const outcome = normalizeImportRow(
      { Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Priority: 'P1', Status: 'Applied', 'Application Deadline': '2026-08-15', 'Date Found': '2026-07-01' },
      BASE_MAP,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) throw new Error('expected success');
    expect(outcome.data.applicationDeadline).toBe('2026-08-15');
    expect(outcome.data.dateFound).toBe('2026-07-01');
    expect(outcome.data.status).toBe('Applied');
    expect(outcome.data.priority).toBe('P1');
    expect(outcome.fieldPresence.applicationDeadline).toBe('supplied');
    expect(outcome.fieldPresence.notes).toBe('blank'); // Notes column IS mapped by BASE_MAP; this row just has no value under that key
  });

  it('defaults priority to P2 and status to Not Applied when the columns are absent', () => {
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply' }, BASE_MAP);
    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) throw new Error('expected success');
    expect(outcome.data.priority).toBe('P2');
    expect(outcome.data.status).toBe('Not Applied');
    expect(outcome.fieldPresence.priority).toBe('blank'); // Priority column IS mapped by BASE_MAP; this row just has no value under that key
    expect(outcome.fieldPresence.status).toBe('blank');
  });

  it('tracks blank (mapped-but-empty) separately from unmapped', () => {
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Notes: '' }, BASE_MAP);
    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) throw new Error('expected success');
    expect(outcome.fieldPresence.notes).toBe('blank');
  });

  it('rejects (never silently coerces) an invalid priority value', () => {
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Priority: 'SUPER URGENT' }, BASE_MAP);
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) throw new Error('expected failure');
    expect(outcome.errors.some((message) => message.includes('Priority'))).toBe(true);
  });

  it('rejects (never silently coerces) an invalid status value', () => {
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'In Progress' }, BASE_MAP);
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) throw new Error('expected failure');
    expect(outcome.errors.some((message) => message.includes('Status'))).toBe(true);
  });

  it('rejects an invalid application URL', () => {
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'not-a-url' }, BASE_MAP);
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) throw new Error('expected failure');
    expect(outcome.errors.some((message) => message.toLowerCase().includes('url'))).toBe(true);
  });

  it('rejects a missing company or role', () => {
    expect(normalizeImportRow({ Role: 'Software Engineer', URL: 'https://acme.com/apply' }, BASE_MAP).ok).toBe(false);
    expect(normalizeImportRow({ Company: 'Acme', URL: 'https://acme.com/apply' }, BASE_MAP).ok).toBe(false);
  });

  it('rejects an unrecognizable Application Deadline instead of silently dropping it', () => {
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', 'Application Deadline': 'sometime next week' }, BASE_MAP);
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) throw new Error('expected failure');
    expect(outcome.errors.some((message) => message.includes('Application Deadline'))).toBe(true);
  });

  it('rejects an impossible calendar date rather than rolling it over', () => {
    expect(normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', 'Application Deadline': '2026-02-31' }, BASE_MAP).ok).toBe(false);
  });

  it('treats a fully blank row as blank, not an error', () => {
    expect(normalizeImportRow({}, BASE_MAP).ok).toBe('blank');
  });

  it('accumulates multiple errors on the same row rather than stopping at the first', () => {
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'not-a-url', Priority: 'URGENT', Status: 'In Progress' }, BASE_MAP);
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) throw new Error('expected failure');
    expect(outcome.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('requires a Decision Deadline for an Offer-status row', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Status']);
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'Offer' }, map);
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) throw new Error('expected failure');
    expect(outcome.errors.some((message) => message.includes('Decision Deadline'))).toBe(true);
  });

  it('accepts an Offer-status row that supplies a Decision Deadline', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Status', 'Decision Deadline']);
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'Offer', 'Decision Deadline': '2026-08-15' }, map);
    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) throw new Error('expected success');
    expect(outcome.data.offerDecisionDeadline).toBe('2026-08-15');
  });

  it('downgrades an OA-status row missing its schedule to Applied instead of importing a hollow Assessment', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Status', 'OA Due At', 'OA Timezone']);
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'OA', 'OA Due At': '2026-08-15T09:00' }, map);
    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) throw new Error('expected success');
    expect(outcome.data.status).toBe('Applied');
    expect(outcome.downgradedFrom).toBe('OA');
    expect(outcome.warnings.some((message) => message.includes('OA Due At/Timezone'))).toBe(true);
  });

  it('still rejects an OA row whose timezone is actively invalid, rather than downgrading around it', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Status', 'OA Due At', 'OA Timezone']);
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'OA', 'OA Due At': '2026-08-15T09:00', 'OA Timezone': 'Nowhere/Place' }, map);
    expect(outcome.ok).toBe(false);
  });

  it('accepts an OA row with a complete valid schedule', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Status', 'OA Due At', 'OA Timezone']);
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'OA', 'OA Due At': '2026-08-15T09:00', 'OA Timezone': 'America/New_York' }, map);
    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) throw new Error('expected success');
    expect(outcome.data.status).toBe('OA');
    expect(outcome.downgradedFrom).toBeNull();
  });

  it('downgrades an interview-stage row missing its schedule to Applied', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Status', 'Interview Scheduled Start', 'Interview Timezone']);
    const outcome = normalizeImportRow(
      { Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'Recruiter Screen', 'Interview Scheduled Start': '2026-08-15T14:00' },
      map,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) throw new Error('expected success');
    expect(outcome.data.status).toBe('Applied');
    expect(outcome.downgradedFrom).toBe('Recruiter Screen');
  });

  it('warns (without blocking) when Accepted has no offer record', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Status']);
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'Accepted' }, map);
    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) throw new Error('expected success');
    expect(outcome.warnings.some((message) => message.includes('Accepted with no offer record'))).toBe(true);
  });

  it('warns (without blocking) when a post-submission status has no Date Applied', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Status']);
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Status: 'Applied' }, map);
    expect(outcome.ok).toBe(true);
    if (outcome.ok !== true) throw new Error('expected success');
    expect(outcome.warnings.some((message) => message.includes('No Date Applied supplied'))).toBe(true);
  });

  it('sniffs an explicit string-shaped Next Action Due as date-only vs datetime-local and tracks the kind', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Next Action Due']);
    const dateOnly = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', 'Next Action Due': '2026-08-15' }, map);
    expect(dateOnly.ok).toBe(true);
    if (dateOnly.ok !== true) throw new Error('expected success');
    expect(dateOnly.data.nextActionDueKind).toBe('date');

    const dateTime = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', 'Next Action Due': '2026-08-15T14:00' }, map);
    expect(dateTime.ok).toBe(true);
    if (dateTime.ok !== true) throw new Error('expected success');
    expect(dateTime.data.nextActionDueKind).toBe('timestamp');
  });

  it('uses the cell number format to interpret a numeric Next Action Due, preserving a fractional time', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Next Action Due']);
    const base = { Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', 'Next Action Due': 46249.75 };

    const asDateTime = normalizeImportRow(base, map, { cellFormats: { 'Next Action Due': 'm/d/yy h:mm' } });
    expect(asDateTime.ok).toBe(true);
    if (asDateTime.ok !== true) throw new Error('expected success');
    expect(asDateTime.data.nextActionDueKind).toBe('timestamp');
    // 46249.75 = Aug 15, 2026, 6:00 PM — the fractional time must survive.
    expect(asDateTime.data.nextActionDue).toBe('2026-08-15T18:00:00');

    const asDateOnly = normalizeImportRow({ ...base, 'Next Action Due': 46249 }, map, { cellFormats: { 'Next Action Due': 'm/d/yy' } });
    expect(asDateOnly.ok).toBe(true);
    if (asDateOnly.ok !== true) throw new Error('expected success');
    expect(asDateOnly.data.nextActionDueKind).toBe('date');
    expect(asDateOnly.data.nextActionDue).toBe('2026-08-15');
  });

  it('requires an explicit Date/Timestamp column-mapping choice for an ambiguous numeric Next Action Due with no usable cell format', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Next Action Due']);
    const noFormat = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', 'Next Action Due': 46249.75 }, map);
    expect(noFormat.ok).toBe(false);
    if (noFormat.ok !== false) throw new Error('expected failure');
    expect(noFormat.errors.some((message) => message.includes('choose Date or Timestamp'))).toBe(true);

    const withOverride = normalizeImportRow(
      { Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', 'Next Action Due': 46249.75 },
      map,
      { nextActionDueKindOverride: 'timestamp' },
    );
    expect(withOverride.ok).toBe(true);
    if (withOverride.ok !== true) throw new Error('expected success');
    expect(withOverride.data.nextActionDueKind).toBe('timestamp');
    expect(withOverride.data.nextActionDue).toBe('2026-08-15T18:00:00');
  });
});

describe('buildImportPreview', () => {
  it('marks blank and invalid rows distinctly from valid ones', () => {
    const rows = [
      { Company: 'Acme', Role: 'SWE', URL: 'https://acme.com/apply' },
      {},
      { Company: 'Bad Co', Role: 'SWE', URL: 'not-a-url' },
    ];
    const preview = buildImportPreview(rows, BASE_MAP, [], []);
    expect(preview[0].status).toBe('valid');
    expect(preview[0].suggestedAction).toBe('create');
    expect(preview[1].status).toBe('blank');
    expect(preview[2].status).toBe('invalid');
    expect(preview[2].suggestedAction).toBe('error');
  });

  it('flags a row as a duplicate against an existing database record by company+role', () => {
    const rows = [{ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply-2026' }];
    const preview = buildImportPreview(rows, BASE_MAP, [{ id: 'existing-1', company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply-2025' } as ExistingApplicationRecord], []);
    expect(preview[0].duplicate).toEqual({ source: 'database', applicationId: 'existing-1', matchedOn: 'company+role' });
    expect(preview[0].suggestedAction).toBe('skip');
  });

  it('flags a row as a duplicate against an existing database record by applicationUrl', () => {
    const rows = [{ Company: 'Different Name Inc', Role: 'Different Role', URL: 'https://acme.com/apply' }];
    const preview = buildImportPreview(rows, BASE_MAP, [{ id: 'existing-1', company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply' } as ExistingApplicationRecord], []);
    expect(preview[0].duplicate).toEqual({ source: 'database', applicationId: 'existing-1', matchedOn: 'applicationUrl' });
  });

  it('flags a later row as a duplicate of an earlier row within the same workbook', () => {
    const rows = [
      { Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply-1' },
      { Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply-2' },
    ];
    const preview = buildImportPreview(rows, BASE_MAP, [], []);
    expect(preview[0].duplicate).toBeNull();
    expect(preview[1].duplicate).toEqual({ source: 'workbook', rowNumber: 2, matchedOn: 'company+role' });
    expect(preview[1].suggestedAction).toBe('skip');
  });

  it('does not flag two distinct rows as duplicates of each other', () => {
    const rows = [
      { Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply' },
      { Company: 'Beta', Role: 'Data Scientist', URL: 'https://beta.com/apply' },
    ];
    const preview = buildImportPreview(rows, BASE_MAP, [], []);
    expect(preview[0].duplicate).toBeNull();
    expect(preview[1].duplicate).toBeNull();
  });

  it('computes a field diff only for rows matching an existing database record', () => {
    const rows = [
      { Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Notes: 'Updated note' },
      { Company: 'Fresh Co', Role: 'SWE', URL: 'https://fresh.example.com/apply' },
    ];
    const existing: ExistingApplicationRecord[] = [{
      id: 'existing-1', company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply',
      priority: 'P2', status: 'Not Applied', location: null, applicationDeadline: null, dateFound: null,
      dateApplied: null, notes: 'Old note', resumeVersionName: null,
    }];
    const preview = buildImportPreview(rows, BASE_MAP, existing, []);
    expect(preview[0].diff).not.toBeNull();
    const notesDiff = preview[0].diff!.find((d) => d.field === 'notes');
    expect(notesDiff).toEqual({ field: 'notes', presence: 'supplied', previousValue: 'Old note', newValue: 'Updated note', kind: 'changed' });
    expect(preview[1].diff).toBeNull();
  });

  it('flags a supplied resume version name that has no match as a warning, and matches case-insensitively when it exists', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Resume Version']);
    const rows = [
      { Company: 'Acme', Role: 'SWE', URL: 'https://acme.com/apply', 'Resume Version': 'unknown resume' },
      { Company: 'Beta', Role: 'SWE', URL: 'https://beta.com/apply', 'Resume Version': 'SWE RESUME 2026' },
    ];
    const preview = buildImportPreview(rows, map, [], [{ id: 'resume-1', name: 'SWE Resume 2026' }]);
    expect(preview[0].resumeMatch).toBeNull();
    expect(preview[0].warnings.some((w) => w.includes('not found'))).toBe(true);
    expect(preview[1].resumeMatch).toEqual({ id: 'resume-1', name: 'SWE Resume 2026' });
  });
});

describe('computeImportRowDiff', () => {
  const existing: ExistingApplicationRecord = {
    id: 'existing-1', company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply',
    priority: 'P1', status: 'Applied', location: 'NYC', applicationDeadline: null, dateFound: null,
    dateApplied: null, notes: 'Existing note', resumeVersionName: 'Old Resume',
  };

  it('marks an unmapped field as preserved, unchanged regardless of the normalized default', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL']);
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply' }, map);
    if (outcome.ok !== true) throw new Error('expected success');
    const diff = computeImportRowDiff(existing, outcome.data, outcome.fieldPresence);
    // priority/location were never mapped — even though normalization
    // defaulted priority to 'P2', the diff must show the field as
    // preserved (still 'P1'), not "changed to P2".
    expect(diff.find((d) => d.field === 'priority')).toMatchObject({ presence: 'unmapped', previousValue: 'P1', newValue: 'P1', kind: 'preserved' });
    expect(diff.find((d) => d.field === 'location')).toMatchObject({ presence: 'unmapped', previousValue: 'NYC', newValue: 'NYC', kind: 'preserved' });
  });

  it('marks a mapped-but-blank clearable field as a candidate clear', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Notes']);
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Notes: '' }, map);
    if (outcome.ok !== true) throw new Error('expected success');
    const diff = computeImportRowDiff(existing, outcome.data, outcome.fieldPresence);
    expect(diff.find((d) => d.field === 'notes')).toMatchObject({ presence: 'blank', previousValue: 'Existing note', newValue: null, kind: 'clear' });
  });

  it('marks a mapped-but-blank non-clearable field (priority/status) as preserved, not cleared', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Priority']);
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Priority: '' }, map);
    if (outcome.ok !== true) throw new Error('expected success');
    const diff = computeImportRowDiff(existing, outcome.data, outcome.fieldPresence);
    expect(diff.find((d) => d.field === 'priority')).toMatchObject({ kind: 'preserved' });
  });

  it('marks a supplied and differing field as changed', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Priority']);
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Priority: 'P0' }, map);
    if (outcome.ok !== true) throw new Error('expected success');
    const diff = computeImportRowDiff(existing, outcome.data, outcome.fieldPresence);
    expect(diff.find((d) => d.field === 'priority')).toMatchObject({ presence: 'supplied', previousValue: 'P1', newValue: 'P0', kind: 'changed' });
  });

  it('marks a supplied but identical value as unchanged', () => {
    const map = autoDetectColumnMap(['Company', 'Role', 'URL', 'Priority']);
    const outcome = normalizeImportRow({ Company: 'Acme', Role: 'Software Engineer', URL: 'https://acme.com/apply', Priority: 'P1' }, map);
    if (outcome.ok !== true) throw new Error('expected success');
    const diff = computeImportRowDiff(existing, outcome.data, outcome.fieldPresence);
    expect(diff.find((d) => d.field === 'priority')).toMatchObject({ kind: 'unchanged' });
  });
});
