import { z } from 'zod';
import { parseExcelDateOnlyValue, priorities, statuses } from '@/lib/recruiting';

// Reads the first non-empty value found under any of `keys` from a raw
// spreadsheet row, tolerating the header variations the exporter and a
// hand-edited workbook might both use (e.g. "Application Deadline" vs
// "applicationDeadline").
const readString = (row: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
};

const hasAnyValue = (row: Record<string, unknown>, ...keys: string[]): boolean =>
  keys.some((key) => row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '');

// Status and priority must be one of the app's real, known values — never an
// arbitrary spreadsheet string silently type-cast into the column. Anything
// else is a validation error on that row, not a coercion.
const importRowSchema = z.object({
  company: z.string().trim().min(1, 'Company is required'),
  role: z.string().trim().min(1, 'Role is required'),
  applicationUrl: z.string().trim().url('Application URL must be a valid URL'),
  priority: z.enum(priorities, { errorMap: () => ({ message: `Priority must be one of ${priorities.join(', ')}` }) }),
  status: z.enum(statuses, { errorMap: () => ({ message: `Status must be one of ${statuses.join(', ')}` }) }),
  location: z.string().trim().optional(),
  applicationDeadline: z.string().nullable(),
  dateFound: z.string().nullable(),
  notes: z.string().optional(),
});

export type ValidatedImportRow = z.infer<typeof importRowSchema>;

export type ImportRowOutcome =
  | { ok: true; data: ValidatedImportRow }
  | { ok: false; errors: string[] }
  | { ok: 'blank' };

/**
 * Validates and normalizes a single raw spreadsheet row. Never throws — a
 * bad row comes back as a list of human-readable errors so the caller can
 * report it and keep processing the rest of the file, rather than aborting
 * the whole import or silently coercing garbage into a valid-looking record.
 */
export const validateImportRow = (row: Record<string, unknown>): ImportRowOutcome => {
  const company = readString(row, 'Company', 'company');
  const role = readString(row, 'Role', 'role');

  // A fully blank row (common as spreadsheet trailing padding) is silently
  // skipped — that's not a data error, just an empty line.
  if (!company && !role && !hasAnyValue(row, 'URL', 'url', 'Application URL', 'applicationUrl')) {
    return { ok: 'blank' };
  }

  const errors: string[] = [];

  const applicationDeadlineRaw = row['Application Deadline'] ?? row.applicationDeadline;
  const dateFoundRaw = row['Date Found'] ?? row.dateFound;
  const hasApplicationDeadline = applicationDeadlineRaw !== undefined && applicationDeadlineRaw !== null && String(applicationDeadlineRaw).trim() !== '';
  const hasDateFound = dateFoundRaw !== undefined && dateFoundRaw !== null && String(dateFoundRaw).trim() !== '';
  const applicationDeadline = hasApplicationDeadline ? parseExcelDateOnlyValue(applicationDeadlineRaw) : null;
  const dateFound = hasDateFound ? parseExcelDateOnlyValue(dateFoundRaw) : null;
  if (hasApplicationDeadline && !applicationDeadline) errors.push('Application Deadline is not a recognizable calendar date');
  if (hasDateFound && !dateFound) errors.push('Date Found is not a recognizable calendar date');

  const candidate = {
    company,
    role,
    applicationUrl: readString(row, 'URL', 'url', 'Application URL', 'applicationUrl'),
    priority: readString(row, 'Priority', 'priority') || 'P2',
    status: readString(row, 'Status', 'status') || 'Not Applied',
    location: readString(row, 'Location', 'location') || undefined,
    applicationDeadline,
    dateFound,
    notes: readString(row, 'Notes', 'notes') || undefined,
  };

  const parsed = importRowSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, errors: [...errors, ...parsed.error.issues.map((issue) => issue.message)] };
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, data: parsed.data };
};
