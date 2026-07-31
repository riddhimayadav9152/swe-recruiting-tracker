import packageJson from '../package.json';

/**
 * Bumped whenever buildExportWorkbook's sheet shape changes in a way that
 * would break an older restore (renamed/removed column, changed semantics).
 * The restore path (lib/multi-sheet-import.ts) refuses to write anything
 * from a workbook whose Metadata sheet declares a different version, rather
 * than guessing at how to interpret unfamiliar columns.
 */
export const EXPORT_FORMAT_VERSION = 2;

/** The app version that produced an export — informational (surfaced in the Metadata sheet and in restore error messages), not itself a compatibility gate. */
export const APPLICATION_VERSION: string = packageJson.version;

export const METADATA_SHEET_NAME = 'Metadata';

/** Every sheet a full export always includes, in the order they're written — the restore path verifies each one is actually present (not just non-empty) before writing anything. */
export const REQUIRED_SHEET_NAMES = [
  'Applications',
  'Job Descriptions',
  'Assessments',
  'Interviews',
  'Offers',
  'Contacts',
  'Notes',
  'Activity History',
  'Resume Versions',
  'Profile',
  'Application Links',
] as const;
