import type { PrismaClient } from '@prisma/client';
import { parseDateOnly, parseTimestamp, parseZonedDateTime } from '@/lib/dates';
import { generateApplicationCode } from '@/lib/recruiting';
import { isUniqueConstraintError, readWorkbookSheetRows } from '@/lib/import';

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

const SHEET_NAMES = {
  applications: 'Applications',
  jobDescriptions: 'Job Descriptions',
  assessments: 'Assessments',
  interviews: 'Interviews',
  offers: 'Offers',
  contacts: 'Contacts',
  notes: 'Notes',
  activities: 'Activity History',
  resumeVersions: 'Resume Versions',
  profile: 'Profile',
} as const;

export type MultiSheetWorkbookData = Record<keyof typeof SHEET_NAMES, Array<Record<string, unknown>>>;

export function parseMultiSheetWorkbook(buffer: Buffer): MultiSheetWorkbookData {
  const result = {} as MultiSheetWorkbookData;
  for (const key of Object.keys(SHEET_NAMES) as Array<keyof typeof SHEET_NAMES>) {
    result[key] = readWorkbookSheetRows(buffer, SHEET_NAMES[key]).rows;
  }
  return result;
}

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

export type MultiSheetImportError = { sheet: string; rowNumber: number; message: string };
export type UnmatchedApplicationCode = { sheet: string; rowNumber: number; applicationCode: string };

export type MultiSheetImportSummary = {
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

/**
 * Restores every sheet of a full-export workbook into the database, in a
 * single atomic transaction — Resume Versions first (so Applications can
 * resolve resumeVersionId), then Applications (matched to an existing row
 * by Application Code, else created and reusing the supplied code — with a
 * defense-in-depth retry-on-collision, same pattern as the single-sheet
 * importer's createImportedApplication), then every child sheet resolved
 * against the Applications sheet's own Application Code. A child row whose
 * Application Code doesn't resolve to any application (in this workbook OR
 * the existing database) is skipped and reported in `unmatchedApplicationCodes`
 * rather than silently dropped or crashing the whole restore.
 */
export async function commitMultiSheetImport(prisma: PrismaClient, data: MultiSheetWorkbookData): Promise<MultiSheetImportSummary> {
  const summary: MultiSheetImportSummary = {
    resumeVersions: { created: 0, matched: 0 },
    applications: { created: 0, updated: 0 },
    jobDescriptions: { created: 0 },
    assessments: { created: 0 },
    interviews: { created: 0 },
    offers: { created: 0 },
    contacts: { created: 0 },
    notes: { created: 0 },
    activities: { created: 0 },
    profile: { created: false, updated: false },
    unmatchedApplicationCodes: [],
    errors: [],
  };

  await prisma.$transaction(async (tx) => {
    // --- 1. Resume Versions ---------------------------------------------
    const resumeNameToId = new Map<string, string>();
    for (const existing of await tx.resumeVersion.findMany({ select: { id: true, name: true } })) {
      resumeNameToId.set(existing.name.trim().toLowerCase(), existing.id);
    }
    for (const [index, row] of data.resumeVersions.entries()) {
      const rowNumber = index + 2;
      const name = str(row['Name']);
      if (!name) { summary.errors.push({ sheet: 'Resume Versions', rowNumber, message: 'Name is required' }); continue; }
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

    // --- 2. Applications --------------------------------------------------
    const codeToId = new Map<string, string>();
    const existingCodes: string[] = [];
    for (const existing of await tx.application.findMany({ select: { id: true, applicationCode: true } })) {
      codeToId.set(existing.applicationCode, existing.id);
      existingCodes.push(existing.applicationCode);
    }

    for (const [index, row] of data.applications.entries()) {
      const rowNumber = index + 2;
      const company = str(row['Company']);
      const role = str(row['Role']);
      if (!company || !role) { summary.errors.push({ sheet: 'Applications', rowNumber, message: 'Company and Role are required' }); continue; }

      const applicationCode = str(row['Application Code']);
      const nextActionDueKind = str(row['Next Action Due Kind']) === 'date' ? 'date' : 'timestamp';
      const nextActionDueRaw = str(row['Next Action Due']);
      const nextActionDue = nextActionDueKind === 'date' ? parseDateOnly(nextActionDueRaw) : parseTimestamp(nextActionDueRaw);
      const resumeVersionName = str(row['Resume Version']);
      const resumeVersionId = resumeVersionName ? resumeNameToId.get(resumeVersionName.toLowerCase()) ?? null : null;
      const createdAt = parseTimestamp(row['Created At']) ?? new Date();

      const applicationData = {
        company, role,
        status: str(row['Status']) ?? 'Not Applied',
        currentStage: str(row['Current Stage']),
        priority: str(row['Priority']) ?? 'P2',
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
        continue;
      }

      const desiredCode = applicationCode && !existingCodes.includes(applicationCode)
        ? applicationCode
        : generateApplicationCode(company, role, createdAt, existingCodes);
      let created;
      try {
        created = await tx.application.create({ data: { applicationCode: desiredCode, ...applicationData, createdAt } });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const fallbackCode = generateApplicationCode(company, role, createdAt, existingCodes);
        created = await tx.application.create({ data: { applicationCode: fallbackCode, ...applicationData, createdAt } });
      }
      existingCodes.push(created.applicationCode);
      codeToId.set(created.applicationCode, created.id);
      if (applicationCode) codeToId.set(applicationCode, created.id);
      summary.applications.created += 1;
    }

    const resolveApplicationId = (sheet: string, rowNumber: number, row: Record<string, unknown>): string | null => {
      const code = str(row['Application Code']);
      if (!code) { summary.errors.push({ sheet, rowNumber, message: 'Application Code is required' }); return null; }
      const id = codeToId.get(code);
      if (!id) { summary.unmatchedApplicationCodes.push({ sheet, rowNumber, applicationCode: code }); return null; }
      return id;
    };

    // --- 3. Job Descriptions (one per application; upsert) -----------------
    for (const [index, row] of data.jobDescriptions.entries()) {
      const rowNumber = index + 2;
      const applicationId = resolveApplicationId('Job Descriptions', rowNumber, row);
      if (!applicationId) continue;
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

    // --- 4. Assessments (every historical round — always create) ----------
    for (const [index, row] of data.assessments.entries()) {
      const rowNumber = index + 2;
      const applicationId = resolveApplicationId('Assessments', rowNumber, row);
      if (!applicationId) continue;
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

    // --- 5. Interviews (every historical round — always create) -----------
    for (const [index, row] of data.interviews.entries()) {
      const rowNumber = index + 2;
      const applicationId = resolveApplicationId('Interviews', rowNumber, row);
      if (!applicationId) continue;
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

    // --- 6. Offers (one per application; upsert) ---------------------------
    for (const [index, row] of data.offers.entries()) {
      const rowNumber = index + 2;
      const applicationId = resolveApplicationId('Offers', rowNumber, row);
      if (!applicationId) continue;
      const fields = {
        offerDate: parseDateOnly(row['Offer Date']),
        decisionDeadline: parseDateOnly(row['Decision Deadline']),
        compensationSummary: str(row['Compensation']),
        notes: str(row['Notes']),
      };
      await tx.offer.upsert({ where: { applicationId }, create: { applicationId, ...fields }, update: fields });
      summary.offers.created += 1;
    }

    // --- 7. Contacts (always create) ---------------------------------------
    for (const [index, row] of data.contacts.entries()) {
      const rowNumber = index + 2;
      const applicationId = resolveApplicationId('Contacts', rowNumber, row);
      if (!applicationId) continue;
      const name = str(row['Name']);
      if (!name) { summary.errors.push({ sheet: 'Contacts', rowNumber, message: 'Name is required' }); continue; }
      await tx.contact.create({
        data: {
          applicationId,
          name,
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

    // --- 8. Notes (always create) ------------------------------------------
    for (const [index, row] of data.notes.entries()) {
      const rowNumber = index + 2;
      const applicationId = resolveApplicationId('Notes', rowNumber, row);
      if (!applicationId) continue;
      const content = str(row['Content']);
      if (!content) { summary.errors.push({ sheet: 'Notes', rowNumber, message: 'Content is required' }); continue; }
      await tx.note.create({
        data: { applicationId, category: str(row['Category']), content, createdAt: parseTimestamp(row['Created At']) ?? new Date() },
      });
      summary.notes.created += 1;
    }

    // --- 9. Activity History (always create) --------------------------------
    for (const [index, row] of data.activities.entries()) {
      const rowNumber = index + 2;
      const applicationId = resolveApplicationId('Activity History', rowNumber, row);
      if (!applicationId) continue;
      const summaryText = str(row['Summary']);
      if (!summaryText) { summary.errors.push({ sheet: 'Activity History', rowNumber, message: 'Summary is required' }); continue; }
      await tx.activity.create({
        data: {
          applicationId,
          eventType: str(row['Event Type']) ?? 'note',
          previousStatus: str(row['Previous Status']),
          newStatus: str(row['New Status']),
          previousStage: str(row['Previous Stage']),
          newStage: str(row['New Stage']),
          summary: summaryText,
          createdAt: parseTimestamp(row['Created At']) ?? new Date(),
        },
      });
      summary.activities.created += 1;
    }

    // --- 10. Profile (singleton) ---------------------------------------------
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
