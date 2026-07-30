import type { PrismaClient } from '@prisma/client';
import {
  isDateOnlyString, isDateTimeLocalString, isValidIanaTimeZone,
  parseDateOnly, parseTimestamp, parseZonedDateTime,
} from '@/lib/dates';
import { deriveInitialStage, generateApplicationCode, priorities, statuses, type ApplicationStatus, type Priority } from '@/lib/recruiting';
import { isUniqueConstraintError, parseWorkbookSheetNames, readWorkbookSheetRows } from '@/lib/import';
import { EXPORT_FORMAT_VERSION, METADATA_SHEET_NAME, REQUIRED_SHEET_NAMES } from '@/lib/export-format';

// --- Full-workbook ("restore") multi-sheet import ---------------------------
//
// This is a SEPARATE, additive pathway from the single-sheet Applications
// importer in lib/import.ts (preview/diff/duplicate-review, driven by a
// human reviewing one row at a time). That importer is for manually curated
// workbooks with fuzzy column mapping and per-row review — it must not be
// redesigned. This module instead restores a workbook produced by this
// app's OWN export (buildExportWorkbook) — exact known column names, every
// sheet, every historical Assessment/Interview/Offer/Contact/Note/Activity
// round — so a user can recover from a lost database or migrate to a fresh
// one with true round-trip fidelity. Application Code is the stable key
// used to resolve every child sheet's parent Application.
//
// Disaster-recovery shape: validate EVERYTHING (workbook format/version,
// every row's fields, every child-sheet Application Code reference) with
// ZERO writes first; only if that whole pass is clean does a single
// all-or-nothing transaction actually write anything. A malformed workbook,
// an unrecognized status, or an orphaned Application Code aborts the entire
// restore rather than silently skipping a row or partially applying it.

const SHEET_NAMES = {
  metadata: METADATA_SHEET_NAME,
  resumeVersions: 'Resume Versions',
  applications: 'Applications',
  jobDescriptions: 'Job Descriptions',
  assessments: 'Assessments',
  interviews: 'Interviews',
  offers: 'Offers',
  contacts: 'Contacts',
  notes: 'Notes',
  activities: 'Activity History',
  profile: 'Profile',
} as const;

export type MultiSheetWorkbookData = Record<keyof typeof SHEET_NAMES, Array<Record<string, unknown>>>;

export type ParsedMultiSheetWorkbook = {
  sheets: MultiSheetWorkbookData;
  /** Actual sheet names present in the workbook — distinct from an empty-but-present sheet, which readWorkbookSheetRows can't tell apart from a genuinely MISSING one on its own. */
  presentSheetNames: string[];
};

export function parseMultiSheetWorkbook(buffer: Buffer): ParsedMultiSheetWorkbook {
  const { sheetNames: presentSheetNames } = parseWorkbookSheetNames(buffer);
  const sheets = {} as MultiSheetWorkbookData;
  for (const key of Object.keys(SHEET_NAMES) as Array<keyof typeof SHEET_NAMES>) {
    sheets[key] = readWorkbookSheetRows(buffer, SHEET_NAMES[key]).rows;
  }
  return { sheets, presentSheetNames };
}

// --- Cell helpers ------------------------------------------------------------

const str = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const numOrNull = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) return Number(value);
  return null;
};

const isYes = (value: unknown): boolean => str(value)?.toLowerCase() === 'yes';

const isBlankCell = (value: unknown): boolean => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

const isValidUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * A zoned-timestamp column pair (e.g. Assessments' "Due At" + "Timezone")
 * exports as a bare wall-clock string when a timezone is known (see
 * zonedTimestampCell), falling back to a raw UTC instant (with a trailing
 * "Z") only when it isn't — so a trailing "Z" is the exact, reliable signal
 * for which parse path to use, matching export's own fallback exactly.
 */
const parseZonedOrUtc = (raw: unknown, timezone: string | null): Date | null => {
  const value = str(raw);
  if (!value) return null;
  if (value.endsWith('Z')) return parseTimestamp(value);
  return parseZonedDateTime(value, timezone);
};

/** Blank is fine (nothing supplied); a non-blank value that isn't a real calendar date is a validation error, never silently parsed to null. */
const isValidDateOnlyCell = (value: unknown): boolean => isBlankCell(value) || (typeof value === 'string' && isDateOnlyString(value.trim()));

/** Covers both a bare UTC ISO timestamp (Created At/Updated At/Completed At/Saved At) and a wall-clock-plus-timezone pair's date half — isDateTimeLocalString already tolerates a trailing Z/offset. */
const isValidTimestampCell = (value: unknown): boolean => isBlankCell(value) || (typeof value === 'string' && isDateTimeLocalString(value.trim()));

/** Validates a zoned-timestamp column pair together: the date must be real, and if it's a bare wall-clock value (no trailing Z) it needs a real timezone to be resolvable at all. Returns an error suffix, or null if valid. */
const validateZonedPair = (dateValue: unknown, timezoneValue: unknown): string | null => {
  if (isBlankCell(dateValue)) return null;
  if (typeof dateValue !== 'string' || !isDateTimeLocalString(dateValue.trim())) return 'is not a real date and time';
  const isUtc = dateValue.trim().endsWith('Z');
  if (!isUtc && isBlankCell(timezoneValue)) return 'has no timezone to interpret it in';
  if (!isBlankCell(timezoneValue) && (typeof timezoneValue !== 'string' || !isValidIanaTimeZone(timezoneValue.trim()))) return 'has an invalid timezone';
  return null;
};

export type MultiSheetImportError = { sheet: string; rowNumber: number; message: string };
export type UnmatchedApplicationCode = { sheet: string; rowNumber: number; applicationCode: string };

export type RestoreMode = 'empty' | 'replace' | 'merge';

export type MultiSheetImportSummary = {
  ok: boolean;
  mode: RestoreMode;
  metadata: { exportFormatVersion: number | null; applicationVersion: string | null; exportedAt: string | null };
  resumeVersions: { created: number; matched: number };
  applications: { created: number; updated: number };
  jobDescriptions: { created: number };
  assessments: { created: number };
  interviews: { created: number };
  offers: { created: number };
  contacts: { created: number };
  notes: { created: number };
  activities: { created: number };
  profile: { created: boolean; updated: boolean };
  unmatchedApplicationCodes: UnmatchedApplicationCode[];
  errors: MultiSheetImportError[];
};

const zeroedCounts = () => ({
  resumeVersions: { created: 0, matched: 0 },
  applications: { created: 0, updated: 0 },
  jobDescriptions: { created: 0 },
  assessments: { created: 0 },
  interviews: { created: 0 },
  offers: { created: 0 },
  contacts: { created: 0 },
  activities: { created: 0 },
  notes: { created: 0 },
  profile: { created: false, updated: false },
});

/**
 * Restores every sheet of a full-export workbook into the database.
 *
 * Two strict phases, never interleaved:
 *  1. VALIDATE everything — workbook format/version, every required sheet's
 *     presence, every row's required fields and real-date/enum/URL shape,
 *     and every child-sheet Application Code reference — against zero
 *     writes. Any error, including a single unmatched Application Code,
 *     aborts the ENTIRE restore with nothing written.
 *  2. Only if that whole pass comes back clean does a single transaction
 *     actually write anything, atomically.
 *
 * `mode` controls how a MATCHED existing application's one-to-many child
 * records (Assessments/Interviews/Contacts/Notes/Activities) are treated:
 *  - 'empty': the target database must have zero applications already
 *    (validated in phase 1); behaves like 'replace' once confirmed empty.
 *  - 'replace': deletes that application's existing one-to-many child rows
 *    before recreating them from the workbook — so restoring the SAME
 *    workbook twice produces the SAME final row counts (idempotent), rather
 *    than doubling every Assessment/Interview/Contact/Note/Activity.
 *  - 'merge': never deletes — appends the workbook's child rows alongside
 *    whatever already exists. Intentionally NOT idempotent for child
 *    tables; use this only to merge in additional history from another
 *    source, never to repeatedly re-apply the same export.
 */
export async function commitMultiSheetImport(prisma: PrismaClient, parsed: ParsedMultiSheetWorkbook, mode: RestoreMode): Promise<MultiSheetImportSummary> {
  const { sheets: data, presentSheetNames } = parsed;
  const errors: MultiSheetImportError[] = [];
  const unmatchedApplicationCodes: UnmatchedApplicationCode[] = [];

  // --- Phase 1a: workbook format/version -------------------------------
  const metadataRow = data.metadata[0];
  const metadata = {
    exportFormatVersion: metadataRow ? numOrNull(metadataRow['Export Format Version']) : null,
    applicationVersion: metadataRow ? str(metadataRow['Application Version']) : null,
    exportedAt: metadataRow ? str(metadataRow['Export Timestamp']) : null,
  };

  if (!presentSheetNames.includes(METADATA_SHEET_NAME) || !metadataRow) {
    errors.push({ sheet: 'Metadata', rowNumber: 1, message: 'Missing Metadata sheet — this file does not look like a full export from this app.' });
  } else if (metadata.exportFormatVersion !== EXPORT_FORMAT_VERSION) {
    errors.push({ sheet: 'Metadata', rowNumber: 2, message: `Unsupported export format version "${metadata.exportFormatVersion ?? 'unknown'}" (this app supports version ${EXPORT_FORMAT_VERSION}).` });
  }
  for (const requiredSheet of REQUIRED_SHEET_NAMES) {
    if (!presentSheetNames.includes(requiredSheet)) {
      errors.push({ sheet: requiredSheet, rowNumber: 1, message: `Required sheet "${requiredSheet}" is missing from this workbook.` });
    }
  }

  // Don't even bother validating row content of a file that isn't a
  // recognizable export in the first place.
  if (errors.length) {
    return { ok: false, mode, metadata, ...zeroedCounts(), unmatchedApplicationCodes, errors };
  }

  // --- Phase 1b: current database state (read-only) --------------------
  const existingApplications = await prisma.application.findMany({ select: { id: true, applicationCode: true } });
  const existingCodeToId = new Map(existingApplications.map((app) => [app.applicationCode, app.id]));
  const existingResumeNames = new Set(
    (await prisma.resumeVersion.findMany({ select: { name: true } })).map((r) => r.name.trim().toLowerCase()),
  );

  if (mode === 'empty' && existingApplications.length > 0) {
    errors.push({
      sheet: 'Applications', rowNumber: 0,
      message: `Restore mode is "Restore into empty database" but the database already has ${existingApplications.length} application(s). Choose Replace or Merge instead.`,
    });
    return { ok: false, mode, metadata, ...zeroedCounts(), unmatchedApplicationCodes, errors };
  }

  // --- Phase 1c: validate every row, every sheet — no writes yet --------
  const workbookCodes = new Set<string>();

  data.resumeVersions.forEach((row, index) => {
    const rowNumber = index + 2;
    if (!str(row['Name'])) errors.push({ sheet: 'Resume Versions', rowNumber, message: 'Name is required' });
    if (!isValidTimestampCell(row['Created At'])) errors.push({ sheet: 'Resume Versions', rowNumber, message: `Created At "${row['Created At']}" is not a real date and time` });
  });

  data.applications.forEach((row, index) => {
    const rowNumber = index + 2;
    if (!str(row['Company'])) errors.push({ sheet: 'Applications', rowNumber, message: 'Company is required' });
    if (!str(row['Role'])) errors.push({ sheet: 'Applications', rowNumber, message: 'Role is required' });

    const status = str(row['Status']) ?? 'Not Applied';
    if (!(statuses as readonly string[]).includes(status)) errors.push({ sheet: 'Applications', rowNumber, message: `Status "${status}" is not a recognized status` });
    const priority = str(row['Priority']) ?? 'P2';
    if (!(priorities as readonly string[]).includes(priority)) errors.push({ sheet: 'Applications', rowNumber, message: `Priority "${priority}" is not a recognized priority` });

    const applicationUrl = str(row['Application URL']);
    if (applicationUrl && !isValidUrl(applicationUrl)) errors.push({ sheet: 'Applications', rowNumber, message: `Application URL "${applicationUrl}" is not a valid URL` });

    for (const [label, key] of [['Application Deadline', 'Application Deadline'], ['Date Found', 'Date Found'], ['Date Applied', 'Date Applied']] as const) {
      if (!isValidDateOnlyCell(row[key])) errors.push({ sheet: 'Applications', rowNumber, message: `${label} "${row[key]}" is not a real calendar date` });
    }
    if (!isValidTimestampCell(row['Created At'])) errors.push({ sheet: 'Applications', rowNumber, message: `Created At "${row['Created At']}" is not a real date and time` });
    if (!isValidTimestampCell(row['Updated At'])) errors.push({ sheet: 'Applications', rowNumber, message: `Updated At "${row['Updated At']}" is not a real date and time` });

    const nextActionDueKindRaw = str(row['Next Action Due Kind']);
    const nextActionDue = row['Next Action Due'];
    if (!isBlankCell(nextActionDue)) {
      if (nextActionDueKindRaw !== 'date' && nextActionDueKindRaw !== 'timestamp') {
        errors.push({ sheet: 'Applications', rowNumber, message: 'Next Action Due Kind must be "date" or "timestamp" when Next Action Due is supplied' });
      } else if (typeof nextActionDue !== 'string' || (nextActionDueKindRaw === 'date' ? !isDateOnlyString(nextActionDue.trim()) : !isDateTimeLocalString(nextActionDue.trim()))) {
        errors.push({ sheet: 'Applications', rowNumber, message: `Next Action Due "${nextActionDue}" does not match its declared kind "${nextActionDueKindRaw}"` });
      }
    }

    const resumeVersionName = str(row['Resume Version']);
    if (resumeVersionName && !existingResumeNames.has(resumeVersionName.toLowerCase()) && !data.resumeVersions.some((r) => str(r['Name'])?.toLowerCase() === resumeVersionName.toLowerCase())) {
      errors.push({ sheet: 'Applications', rowNumber, message: `Resume Version "${resumeVersionName}" was not found in the Resume Versions sheet or the existing database` });
    }

    const code = str(row['Application Code']);
    if (code) workbookCodes.add(code);
  });

  const codeExists = (code: string) => existingCodeToId.has(code) || workbookCodes.has(code);
  const validateApplicationCodeRef = (sheet: string, rowNumber: number, row: Record<string, unknown>) => {
    const code = str(row['Application Code']);
    if (!code) { errors.push({ sheet, rowNumber, message: 'Application Code is required' }); return; }
    if (!codeExists(code)) unmatchedApplicationCodes.push({ sheet, rowNumber, applicationCode: code });
  };

  data.jobDescriptions.forEach((row, index) => validateApplicationCodeRef('Job Descriptions', index + 2, row));

  data.assessments.forEach((row, index) => {
    const rowNumber = index + 2;
    validateApplicationCodeRef('Assessments', rowNumber, row);
    const dueError = validateZonedPair(row['Due At'], row['Timezone']);
    if (dueError) errors.push({ sheet: 'Assessments', rowNumber, message: `Due At "${row['Due At']}" ${dueError}` });
    const receivedError = validateZonedPair(row['Received At'], row['Timezone']);
    if (receivedError) errors.push({ sheet: 'Assessments', rowNumber, message: `Received At "${row['Received At']}" ${receivedError}` });
    if (!isValidTimestampCell(row['Completed At'])) errors.push({ sheet: 'Assessments', rowNumber, message: `Completed At "${row['Completed At']}" is not a real date and time` });
  });

  data.interviews.forEach((row, index) => {
    const rowNumber = index + 2;
    validateApplicationCodeRef('Interviews', rowNumber, row);
    const startError = validateZonedPair(row['Scheduled Start'], row['Timezone']);
    if (startError) errors.push({ sheet: 'Interviews', rowNumber, message: `Scheduled Start "${row['Scheduled Start']}" ${startError}` });
    const endError = validateZonedPair(row['Scheduled End'], row['Timezone']);
    if (endError) errors.push({ sheet: 'Interviews', rowNumber, message: `Scheduled End "${row['Scheduled End']}" ${endError}` });
    if (!isValidTimestampCell(row['Completed At'])) errors.push({ sheet: 'Interviews', rowNumber, message: `Completed At "${row['Completed At']}" is not a real date and time` });
    if (!isValidDateOnlyCell(row['Follow-Up Date'])) errors.push({ sheet: 'Interviews', rowNumber, message: `Follow-Up Date "${row['Follow-Up Date']}" is not a real calendar date` });
  });

  data.offers.forEach((row, index) => {
    const rowNumber = index + 2;
    validateApplicationCodeRef('Offers', rowNumber, row);
    if (!isValidDateOnlyCell(row['Offer Date'])) errors.push({ sheet: 'Offers', rowNumber, message: `Offer Date "${row['Offer Date']}" is not a real calendar date` });
    if (!isValidDateOnlyCell(row['Decision Deadline'])) errors.push({ sheet: 'Offers', rowNumber, message: `Decision Deadline "${row['Decision Deadline']}" is not a real calendar date` });
  });

  data.contacts.forEach((row, index) => {
    const rowNumber = index + 2;
    validateApplicationCodeRef('Contacts', rowNumber, row);
    if (!str(row['Name'])) errors.push({ sheet: 'Contacts', rowNumber, message: 'Name is required' });
    if (!isValidDateOnlyCell(row['Last Contacted'])) errors.push({ sheet: 'Contacts', rowNumber, message: `Last Contacted "${row['Last Contacted']}" is not a real calendar date` });
    if (!isValidDateOnlyCell(row['Next Follow-Up'])) errors.push({ sheet: 'Contacts', rowNumber, message: `Next Follow-Up "${row['Next Follow-Up']}" is not a real calendar date` });
  });

  data.notes.forEach((row, index) => {
    const rowNumber = index + 2;
    validateApplicationCodeRef('Notes', rowNumber, row);
    if (!str(row['Content'])) errors.push({ sheet: 'Notes', rowNumber, message: 'Content is required' });
    if (!isValidTimestampCell(row['Created At'])) errors.push({ sheet: 'Notes', rowNumber, message: `Created At "${row['Created At']}" is not a real date and time` });
  });

  data.activities.forEach((row, index) => {
    const rowNumber = index + 2;
    validateApplicationCodeRef('Activity History', rowNumber, row);
    if (!str(row['Summary'])) errors.push({ sheet: 'Activity History', rowNumber, message: 'Summary is required' });
    if (!isValidTimestampCell(row['Created At'])) errors.push({ sheet: 'Activity History', rowNumber, message: `Created At "${row['Created At']}" is not a real date and time` });
  });

  // --- Abort with ZERO writes if ANY error or unmatched reference exists. ---
  if (errors.length || unmatchedApplicationCodes.length) {
    return { ok: false, mode, metadata, ...zeroedCounts(), unmatchedApplicationCodes, errors };
  }

  // --- Phase 2: everything validated clean — write it all, atomically. ---
  const summary: MultiSheetImportSummary = { ok: true, mode, metadata, ...zeroedCounts(), unmatchedApplicationCodes: [], errors: [] };

  await prisma.$transaction(async (tx) => {
    // --- Resume Versions ---------------------------------------------
    const resumeNameToId = new Map<string, string>();
    for (const existing of await tx.resumeVersion.findMany({ select: { id: true, name: true } })) {
      resumeNameToId.set(existing.name.trim().toLowerCase(), existing.id);
    }
    for (const row of data.resumeVersions) {
      const name = str(row['Name'])!;
      const key = name.toLowerCase();
      if (resumeNameToId.has(key)) { summary.resumeVersions.matched += 1; continue; }
      const created = await tx.resumeVersion.create({
        data: {
          name,
          targetType: str(row['Target Type']) ?? 'General',
          fileName: str(row['File Name']),
          description: str(row['Description']),
          archived: isYes(row['Archived']),
          createdAt: parseTimestamp(row['Created At']) ?? new Date(),
        },
      });
      resumeNameToId.set(key, created.id);
      summary.resumeVersions.created += 1;
    }

    // --- Applications ---------------------------------------------------
    const codeToId = new Map<string, string>(existingCodeToId);
    const allCodes: string[] = [...existingCodeToId.keys()];
    // Matched applications whose one-to-many child records must be cleared
    // before recreating them from this workbook — only in replace/empty
    // mode; 'merge' never deletes (see the docstring above).
    const applicationsToClear = new Set<string>();

    for (const row of data.applications) {
      const company = str(row['Company'])!;
      const role = str(row['Role'])!;
      const applicationCode = str(row['Application Code']);
      const status = (str(row['Status']) ?? 'Not Applied') as ApplicationStatus;
      const nextActionDueKind = str(row['Next Action Due Kind']) === 'date' ? 'date' : 'timestamp';
      const nextActionDueRaw = str(row['Next Action Due']);
      const nextActionDue = nextActionDueRaw ? (nextActionDueKind === 'date' ? parseDateOnly(nextActionDueRaw) : parseTimestamp(nextActionDueRaw)) : null;
      const resumeVersionName = str(row['Resume Version']);
      const resumeVersionId = resumeVersionName ? resumeNameToId.get(resumeVersionName.toLowerCase()) ?? null : null;
      const createdAt = parseTimestamp(row['Created At']) ?? new Date();

      const applicationData = {
        company, role,
        status,
        // Current Stage is ALWAYS derived from status, never trusted
        // verbatim from the sheet — this is the same invariant the
        // single-sheet importer and every other write path in the app
        // enforce (see deriveInitialStage's own docstring): it must be
        // impossible to end up with e.g. Status: Applied paired with a
        // stale/tampered Stage: Discovered.
        currentStage: deriveInitialStage(status),
        priority: (str(row['Priority']) ?? 'P2') as Priority,
        applicationUrl: str(row['Application URL']),
        location: str(row['Location']),
        nextAction: str(row['Next Action']),
        nextActionDue,
        nextActionDueKind,
        applicationDeadline: parseDateOnly(row['Application Deadline']),
        dateFound: parseDateOnly(row['Date Found']),
        dateApplied: parseDateOnly(row['Date Applied']),
        resumeVersionId,
        outcome: str(row['Outcome']),
        notes: str(row['Notes']),
        archived: isYes(row['Archived']),
        updatedAt: parseTimestamp(row['Updated At']) ?? new Date(),
      };

      const matchedId = applicationCode ? codeToId.get(applicationCode) : undefined;
      if (matchedId) {
        await tx.application.update({ where: { id: matchedId }, data: applicationData });
        summary.applications.updated += 1;
        if (mode !== 'merge') applicationsToClear.add(matchedId);
        continue;
      }

      const desiredCode = applicationCode && !allCodes.includes(applicationCode)
        ? applicationCode
        : generateApplicationCode(company, role, createdAt, allCodes);
      let created;
      try {
        created = await tx.application.create({ data: { applicationCode: desiredCode, ...applicationData, createdAt } });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const fallbackCode = generateApplicationCode(company, role, createdAt, allCodes);
        created = await tx.application.create({ data: { applicationCode: fallbackCode, ...applicationData, createdAt } });
      }
      allCodes.push(created.applicationCode);
      codeToId.set(created.applicationCode, created.id);
      if (applicationCode) codeToId.set(applicationCode, created.id);
      summary.applications.created += 1;
    }

    // Clear one-to-many child records for every matched application BEFORE
    // recreating them below, so a repeated restore of the same workbook is
    // idempotent (identical final row counts) instead of doubling every
    // Assessment/Interview/Contact/Note/Activity each time it's re-run.
    for (const applicationId of applicationsToClear) {
      await tx.assessment.deleteMany({ where: { applicationId } });
      await tx.interview.deleteMany({ where: { applicationId } });
      await tx.contact.deleteMany({ where: { applicationId } });
      await tx.note.deleteMany({ where: { applicationId } });
      await tx.activity.deleteMany({ where: { applicationId } });
    }

    const resolveApplicationId = (row: Record<string, unknown>): string => codeToId.get(str(row['Application Code'])!)!;

    // --- Job Descriptions (one per application; upsert — already idempotent) ---
    for (const row of data.jobDescriptions) {
      const applicationId = resolveApplicationId(row);
      const fields = {
        fullText: str(row['Full Text']),
        minimumQualifications: str(row['Minimum Qualifications']),
        preferredQualifications: str(row['Preferred Qualifications']),
        keywords: str(row['Keywords']),
        sourceUrl: str(row['Source URL']),
      };
      await tx.jobDescription.upsert({
        where: { applicationId },
        create: { applicationId, ...fields, savedAt: parseTimestamp(row['Saved At']) ?? new Date() },
        update: fields,
      });
      summary.jobDescriptions.created += 1;
    }

    // --- Assessments (every historical round) -------------------------------
    for (const row of data.assessments) {
      const applicationId = resolveApplicationId(row);
      const timezone = str(row['Timezone']);
      await tx.assessment.create({
        data: {
          applicationId,
          type: str(row['Type']) ?? 'OA',
          platform: str(row['Platform']),
          receivedAt: parseZonedOrUtc(row['Received At'], timezone),
          dueAt: parseZonedOrUtc(row['Due At'], timezone),
          timezone,
          completedAt: parseTimestamp(row['Completed At']),
          durationMinutes: numOrNull(row['Duration Minutes']),
          questionCount: numOrNull(row['Question Count']),
          topics: str(row['Topics']),
          difficulty: str(row['Difficulty']),
          confidence: str(row['Confidence']),
          result: str(row['Result']),
          encounteredQuestions: str(row['Encountered Questions']),
          notes: str(row['Notes']),
        },
      });
      summary.assessments.created += 1;
    }

    // --- Interviews (every historical round) --------------------------------
    for (const row of data.interviews) {
      const applicationId = resolveApplicationId(row);
      const timezone = str(row['Timezone']);
      await tx.interview.create({
        data: {
          applicationId,
          stage: str(row['Stage']) ?? 'Recruiter Screen',
          scheduledStart: parseZonedOrUtc(row['Scheduled Start'], timezone),
          scheduledEnd: parseZonedOrUtc(row['Scheduled End'], timezone),
          timezone,
          format: str(row['Format']),
          location: str(row['Location']),
          meetingUrl: str(row['Meeting URL']),
          interviewer: str(row['Interviewer']),
          recruiter: str(row['Recruiter']),
          completedAt: parseTimestamp(row['Completed At']),
          result: str(row['Result']),
          questions: str(row['Questions']),
          whatWentWell: str(row['What Went Well']),
          improvements: str(row['Improvements']),
          followUpDate: parseDateOnly(row['Follow-Up Date']),
          notes: str(row['Notes']),
        },
      });
      summary.interviews.created += 1;
    }

    // --- Offers (one per application; upsert — already idempotent) ---------
    for (const row of data.offers) {
      const applicationId = resolveApplicationId(row);
      const fields = {
        offerDate: parseDateOnly(row['Offer Date']),
        decisionDeadline: parseDateOnly(row['Decision Deadline']),
        compensationSummary: str(row['Compensation']),
        notes: str(row['Notes']),
      };
      await tx.offer.upsert({ where: { applicationId }, create: { applicationId, ...fields }, update: fields });
      summary.offers.created += 1;
    }

    // --- Contacts ------------------------------------------------------------
    for (const row of data.contacts) {
      const applicationId = resolveApplicationId(row);
      await tx.contact.create({
        data: {
          applicationId,
          name: str(row['Name'])!,
          title: str(row['Title']),
          email: str(row['Email']),
          linkedInUrl: str(row['LinkedIn URL']),
          relationship: str(row['Relationship']),
          referralStatus: str(row['Referral Status']),
          lastContacted: parseDateOnly(row['Last Contacted']),
          nextFollowUp: parseDateOnly(row['Next Follow-Up']),
          notes: str(row['Notes']),
        },
      });
      summary.contacts.created += 1;
    }

    // --- Notes -----------------------------------------------------------------
    for (const row of data.notes) {
      const applicationId = resolveApplicationId(row);
      await tx.note.create({
        data: { applicationId, category: str(row['Category']), content: str(row['Content'])!, createdAt: parseTimestamp(row['Created At']) ?? new Date() },
      });
      summary.notes.created += 1;
    }

    // --- Activity History ----------------------------------------------------
    for (const row of data.activities) {
      const applicationId = resolveApplicationId(row);
      await tx.activity.create({
        data: {
          applicationId,
          eventType: str(row['Event Type']) ?? 'note',
          previousStatus: str(row['Previous Status']),
          newStatus: str(row['New Status']),
          previousStage: str(row['Previous Stage']),
          newStage: str(row['New Stage']),
          summary: str(row['Summary'])!,
          createdAt: parseTimestamp(row['Created At']) ?? new Date(),
        },
      });
      summary.activities.created += 1;
    }

    // --- Profile (singleton) ---------------------------------------------
    const profileRow = data.profile[0];
    if (profileRow) {
      const existingProfile = await tx.userProfile.findFirst({ select: { id: true } });
      const fields = {
        name: str(profileRow['Name']) ?? undefined,
        school: str(profileRow['School']) ?? undefined,
        major: str(profileRow['Major']) ?? undefined,
        graduation: str(profileRow['Graduation']) ?? undefined,
        workAuthorization: str(profileRow['Work Authorization']) ?? undefined,
        preferredLocation: str(profileRow['Preferred Location']) ?? undefined,
        otherLocations: str(profileRow['Other Locations']) ?? undefined,
        currentExperience: str(profileRow['Current Experience']) ?? undefined,
        targetRoles: str(profileRow['Target Roles']) ?? undefined,
        targetCategories: str(profileRow['Target Categories']) ?? undefined,
        defaultFollowUpDays: numOrNull(profileRow['Default Follow-Up Days']) ?? undefined,
        defaultDueDays: numOrNull(profileRow['Default Due Days']) ?? undefined,
      };
      if (existingProfile) {
        await tx.userProfile.update({ where: { id: existingProfile.id }, data: fields });
        summary.profile.updated = true;
      } else {
        await tx.userProfile.create({ data: fields });
        summary.profile.created = true;
      }
    }
  });

  return summary;
}
