import * as XLSX from 'xlsx';
import type { PrismaClient } from '@prisma/client';
import { formatDateOnly, formatInZone } from '@/lib/dates';

const DATE_ONLY_PATTERN = 'yyyy-MM-dd';
const DATETIME_PATTERN = "yyyy-MM-dd'T'HH:mm:ss";

/** A bare calendar date, formatted UTC-safely (reads UTC calendar fields, same as the app's own display code) — never a locale/local-time-shifted value. */
const dateOnlyCell = (value: Date | null): string => (value ? formatDateOnly(value, DATE_ONLY_PATTERN) : '');

/** A real timestamp with NO specific IANA zone of its own (createdAt, completedAt, etc.) — exported as a full UTC instant, date+time+offset, never truncated to a bare date. */
const utcTimestampCell = (value: Date | null): string => (value ? `${value.toISOString().slice(0, 19)}Z` : '');

/** A real timestamp that DOES have its own IANA zone (an interview's scheduledStart, an OA's dueAt) — exported as the wall-clock value in THAT zone, paired with a separate timezone column, so re-importing it through the same "Scheduled Start"/timezone column pair round-trips exactly instead of double-converting through a raw UTC string. */
const zonedTimestampCell = (value: Date | null, timezone: string | null): string => {
  if (!value) return '';
  if (!timezone) return utcTimestampCell(value);
  return formatInZone(value, timezone, DATETIME_PATTERN);
};

/** Applies to Application.nextActionDue specifically — dispatches on its tracked kind so a timestamp is NEVER truncated to yyyy-MM-dd (the bug this export rewrite exists to fix). */
const nextActionDueCell = (value: Date | null, kind: string): string => {
  if (!value) return '';
  return kind === 'date' ? dateOnlyCell(value) : utcTimestampCell(value);
};

export type ExportData = Awaited<ReturnType<typeof loadExportData>>;

export async function loadExportData(prisma: PrismaClient) {
  const [applications, resumeVersions, profile] = await Promise.all([
    prisma.application.findMany({
      include: {
        jobDescription: true,
        assessments: true,
        interviews: true,
        offers: true,
        contacts: true,
        notesRelation: true,
        activities: true,
        resumeVersion: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.resumeVersion.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.userProfile.findFirst(),
  ]);

  return { applications, resumeVersions, profile };
}

/**
 * Builds the full multi-sheet workbook from already-loaded data (pure, no
 * I/O — see loadExportData for the DB read) covering every record type the
 * app tracks: Applications, Job Descriptions, Assessments, Interviews,
 * Offers, Contacts, Notes, Activity History, Resume Versions, and Profile.
 * Date-only fields are formatted UTC-safely; every real timestamp includes
 * date, time, AND an explicit UTC offset/zone — see the cell helpers above.
 */
export function buildExportWorkbook(data: ExportData): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();

  const applicationRows = data.applications.map((app) => {
    // The Applications sheet also carries a denormalized "current" OA /
    // interview / offer schedule (in addition to the full Assessments /
    // Interviews / Offers sheets below) — specifically so this one sheet
    // stays self-sufficient for re-import through the same column-mapped
    // pipeline that created it (see lib/import.ts), without requiring the
    // importer to stitch together multiple sheets.
    const currentAssessment = app.status === 'OA' ? app.assessments[app.assessments.length - 1] : undefined;
    const currentInterview = app.interviews.filter((interview) => interview.stage === app.status).slice(-1)[0];

    return {
      'Application Code': app.applicationCode,
      Company: app.company,
      Role: app.role,
      Status: app.status,
      'Current Stage': app.currentStage ?? '',
      Priority: app.priority,
      'Application URL': app.applicationUrl ?? '',
      Location: app.location ?? '',
      'Next Action': app.nextAction ?? '',
      'Next Action Due': nextActionDueCell(app.nextActionDue, app.nextActionDueKind),
      'Next Action Due Kind': app.nextActionDueKind,
      'Application Deadline': dateOnlyCell(app.applicationDeadline),
      'Date Found': dateOnlyCell(app.dateFound),
      'Date Applied': dateOnlyCell(app.dateApplied),
      'Resume Version': app.resumeVersion?.name ?? '',
      'OA Due At': currentAssessment ? zonedTimestampCell(currentAssessment.dueAt, currentAssessment.timezone) : '',
      'OA Timezone': currentAssessment?.timezone ?? '',
      'OA Platform': currentAssessment?.platform ?? '',
      'Interview Scheduled Start': currentInterview ? zonedTimestampCell(currentInterview.scheduledStart, currentInterview.timezone) : '',
      'Interview Timezone': currentInterview?.timezone ?? '',
      'Decision Deadline': app.offers ? dateOnlyCell(app.offers.decisionDeadline) : '',
      Compensation: app.offers?.compensationSummary ?? '',
      Outcome: app.outcome ?? '',
      Notes: app.notes ?? '',
      Archived: app.archived ? 'Yes' : 'No',
      'Created At': utcTimestampCell(app.createdAt),
      'Updated At': utcTimestampCell(app.updatedAt),
    };
  });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(applicationRows), 'Applications');

  const jobDescriptionRows = data.applications
    .filter((app) => app.jobDescription)
    .map((app) => ({
      'Application Code': app.applicationCode,
      Company: app.company,
      'Full Text': app.jobDescription?.fullText ?? '',
      'Minimum Qualifications': app.jobDescription?.minimumQualifications ?? '',
      'Preferred Qualifications': app.jobDescription?.preferredQualifications ?? '',
      Keywords: app.jobDescription?.keywords ?? '',
      'Source URL': app.jobDescription?.sourceUrl ?? '',
      'Saved At': utcTimestampCell(app.jobDescription?.savedAt ?? null),
    }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(jobDescriptionRows), 'Job Descriptions');

  const assessmentRows = data.applications.flatMap((app) => app.assessments.map((assessment) => ({
    'Application Code': app.applicationCode,
    Company: app.company,
    Type: assessment.type,
    Platform: assessment.platform ?? '',
    'Received At': zonedTimestampCell(assessment.receivedAt, assessment.timezone),
    'Due At': zonedTimestampCell(assessment.dueAt, assessment.timezone),
    Timezone: assessment.timezone ?? '',
    'Completed At': utcTimestampCell(assessment.completedAt),
    'Duration Minutes': assessment.durationMinutes ?? '',
    'Question Count': assessment.questionCount ?? '',
    Topics: assessment.topics ?? '',
    Difficulty: assessment.difficulty ?? '',
    Confidence: assessment.confidence ?? '',
    Result: assessment.result ?? '',
    'Encountered Questions': assessment.encounteredQuestions ?? '',
    Notes: assessment.notes ?? '',
  })));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(assessmentRows), 'Assessments');

  const interviewRows = data.applications.flatMap((app) => app.interviews.map((interview) => ({
    'Application Code': app.applicationCode,
    Company: app.company,
    Stage: interview.stage,
    'Scheduled Start': zonedTimestampCell(interview.scheduledStart, interview.timezone),
    'Scheduled End': zonedTimestampCell(interview.scheduledEnd, interview.timezone),
    Timezone: interview.timezone ?? '',
    Format: interview.format ?? '',
    Location: interview.location ?? '',
    'Meeting URL': interview.meetingUrl ?? '',
    Interviewer: interview.interviewer ?? '',
    Recruiter: interview.recruiter ?? '',
    'Completed At': utcTimestampCell(interview.completedAt),
    Result: interview.result ?? '',
    Questions: interview.questions ?? '',
    'What Went Well': interview.whatWentWell ?? '',
    Improvements: interview.improvements ?? '',
    'Follow-Up Date': dateOnlyCell(interview.followUpDate),
    Notes: interview.notes ?? '',
  })));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(interviewRows), 'Interviews');

  const offerRows = data.applications
    .filter((app) => app.offers)
    .map((app) => ({
      'Application Code': app.applicationCode,
      Company: app.company,
      'Offer Date': dateOnlyCell(app.offers?.offerDate ?? null),
      'Decision Deadline': dateOnlyCell(app.offers?.decisionDeadline ?? null),
      Compensation: app.offers?.compensationSummary ?? '',
      Notes: app.offers?.notes ?? '',
    }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(offerRows), 'Offers');

  const contactRows = data.applications.flatMap((app) => app.contacts.map((contact) => ({
    'Application Code': app.applicationCode,
    Company: app.company,
    Name: contact.name,
    Title: contact.title ?? '',
    Email: contact.email ?? '',
    'LinkedIn URL': contact.linkedInUrl ?? '',
    Relationship: contact.relationship ?? '',
    'Referral Status': contact.referralStatus ?? '',
    'Last Contacted': dateOnlyCell(contact.lastContacted),
    'Next Follow-Up': dateOnlyCell(contact.nextFollowUp),
    Notes: contact.notes ?? '',
  })));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(contactRows), 'Contacts');

  const noteRows = data.applications.flatMap((app) => app.notesRelation.map((note) => ({
    'Application Code': app.applicationCode,
    Company: app.company,
    Category: note.category ?? '',
    Content: note.content,
    'Created At': utcTimestampCell(note.createdAt),
  })));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(noteRows), 'Notes');

  const activityRows = data.applications.flatMap((app) => app.activities.map((activity) => ({
    'Application Code': app.applicationCode,
    Company: app.company,
    'Event Type': activity.eventType,
    'Previous Status': activity.previousStatus ?? '',
    'New Status': activity.newStatus ?? '',
    'Previous Stage': activity.previousStage ?? '',
    'New Stage': activity.newStage ?? '',
    Summary: activity.summary,
    'Created At': utcTimestampCell(activity.createdAt),
  })));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(activityRows), 'Activity History');

  const resumeVersionRows = data.resumeVersions.map((resume) => ({
    Name: resume.name,
    'Target Type': resume.targetType,
    'File Name': resume.fileName ?? '',
    Description: resume.description ?? '',
    Archived: resume.archived ? 'Yes' : 'No',
    'Created At': utcTimestampCell(resume.createdAt),
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(resumeVersionRows), 'Resume Versions');

  const profileRows = data.profile ? [{
    Name: data.profile.name,
    School: data.profile.school,
    Major: data.profile.major,
    Graduation: data.profile.graduation,
    'Work Authorization': data.profile.workAuthorization,
    'Preferred Location': data.profile.preferredLocation,
    'Other Locations': data.profile.otherLocations,
    'Current Experience': data.profile.currentExperience,
    'Target Roles': data.profile.targetRoles,
    'Target Categories': data.profile.targetCategories,
    'Default Follow-Up Days': data.profile.defaultFollowUpDays,
    'Default Due Days': data.profile.defaultDueDays,
  }] : [];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(profileRows), 'Profile');

  return workbook;
}
