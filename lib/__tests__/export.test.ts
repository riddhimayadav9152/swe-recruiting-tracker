import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildExportWorkbook, type ExportData } from '../export';

const baseApplication = {
  id: 'app-1',
  applicationCode: 'ACME-SOFT-260101',
  company: 'Acme',
  role: 'Software Engineer',
  jobId: null,
  location: 'NYC',
  workModel: null,
  postingDate: null,
  applicationDeadline: null,
  dateFound: null,
  dateApplied: null,
  status: 'Not Applied',
  currentStage: 'Discovered',
  priority: 'P1',
  applicationUrl: 'https://acme.com/apply',
  candidatePortalUrl: null,
  confirmationNumber: null,
  compensationSummary: null,
  eligibility: null,
  sponsorship: null,
  whyFit: null,
  postingStatus: null,
  portalUsername: null,
  passwordManagerReference: null,
  lastVerifiedAt: null,
  nextAction: 'Review and apply',
  nextActionDue: null,
  nextActionDueKind: 'timestamp',
  emailUsed: null,
  coverLetterStatus: null,
  referralStatus: null,
  notes: '',
  outcome: null,
  archived: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  resumeVersionId: null,
  resumeVersion: null,
  jobDescription: null,
  interviews: [] as never[],
  assessments: [] as never[],
  contacts: [] as never[],
  notesRelation: [] as never[],
  activities: [] as never[],
  links: [] as never[],
  offers: null,
};

const readSheet = (workbook: XLSX.WorkBook, name: string) => XLSX.utils.sheet_to_json(workbook.Sheets[name]) as Array<Record<string, unknown>>;

describe('buildExportWorkbook', () => {
  it('includes every required sheet, even when empty', () => {
    const data: ExportData = { applications: [], resumeVersions: [], profile: null };
    const workbook = buildExportWorkbook(data);
    expect(workbook.SheetNames).toEqual([
      'Metadata', 'Applications', 'Job Descriptions', 'Application Links', 'Assessments', 'Interviews', 'Offers',
      'Contacts', 'Notes', 'Activity History', 'Resume Versions', 'Profile',
    ]);
  });

  it('stamps every export with a Metadata sheet declaring the format version, app version, timestamp, and required sheet list', () => {
    const data: ExportData = { applications: [], resumeVersions: [], profile: null };
    const workbook = buildExportWorkbook(data);
    const rows = readSheet(workbook, 'Metadata');
    expect(rows).toHaveLength(1);
    expect(rows[0]['Export Format Version']).toBe(2);
    expect(typeof rows[0]['Application Version']).toBe('string');
    expect(typeof rows[0]['Export Timestamp']).toBe('string');
    expect(rows[0]['Required Sheets']).toContain('Applications');
    expect(rows[0]['Required Sheets']).toContain('Profile');
  });

  it('formats a date-only nextActionDue as a bare calendar date', () => {
    const data: ExportData = {
      applications: [{ ...baseApplication, nextActionDue: new Date('2026-08-15T00:00:00.000Z'), nextActionDueKind: 'date' }],
      resumeVersions: [], profile: null,
    };
    const workbook = buildExportWorkbook(data);
    const rows = readSheet(workbook, 'Applications');
    expect(rows[0]['Next Action Due']).toBe('2026-08-15');
    expect(rows[0]['Next Action Due Kind']).toBe('date');
  });

  it('never truncates a timestamp-kind nextActionDue to yyyy-MM-dd — preserves the full date+time+offset', () => {
    const data: ExportData = {
      applications: [{ ...baseApplication, nextActionDue: new Date('2026-08-15T13:00:00.000Z'), nextActionDueKind: 'timestamp' }],
      resumeVersions: [], profile: null,
    };
    const workbook = buildExportWorkbook(data);
    const rows = readSheet(workbook, 'Applications');
    expect(rows[0]['Next Action Due']).toBe('2026-08-15T13:00:00Z');
    expect(rows[0]['Next Action Due Kind']).toBe('timestamp');
  });

  it('exports an interview scheduled start as wall-clock time in ITS OWN timezone, not a raw UTC instant', () => {
    const data: ExportData = {
      applications: [{
        ...baseApplication,
        interviews: [{
          id: 'int-1', applicationId: 'app-1', stage: 'Recruiter Screen',
          // 21:00 UTC = 2:00 PM PDT (UTC-7).
          scheduledStart: new Date('2026-08-20T21:00:00.000Z'), scheduledEnd: null, timezone: 'America/Los_Angeles',
          format: null, location: null, meetingUrl: null, interviewer: null, recruiter: null,
          completedAt: null, result: null, questions: null, whatWentWell: null, improvements: null,
          followUpDate: null, notes: null,
        }],
      }],
      resumeVersions: [], profile: null,
    };
    const workbook = buildExportWorkbook(data);
    const rows = readSheet(workbook, 'Interviews');
    expect(rows[0]['Scheduled Start']).toBe('2026-08-20T14:00:00');
    expect(rows[0]['Timezone']).toBe('America/Los_Angeles');
  });

  it('formats a UTC-safe date-only field regardless of the field type (offer decision deadline)', () => {
    const data: ExportData = {
      applications: [{ ...baseApplication, offers: { id: 'offer-1', applicationId: 'app-1', offerDate: null, decisionDeadline: new Date('2026-09-01T00:00:00.000Z'), compensationSummary: '$180k', notes: null, createdAt: new Date(), updatedAt: new Date() } }],
      resumeVersions: [], profile: null,
    };
    const workbook = buildExportWorkbook(data);
    const rows = readSheet(workbook, 'Offers');
    expect(rows[0]['Decision Deadline']).toBe('2026-09-01');
  });

  it('denormalizes the current OA schedule onto the Applications sheet so it round-trips through the single-sheet importer', () => {
    const data: ExportData = {
      applications: [{
        ...baseApplication,
        status: 'OA',
        assessments: [{
          id: 'assess-1', applicationId: 'app-1', type: 'OA', platform: 'Coderbyte',
          receivedAt: null, dueAt: new Date('2026-08-15T13:00:00.000Z'), timezone: 'America/New_York',
          completedAt: null, durationMinutes: null, questionCount: null, topics: null,
          difficulty: null, confidence: null, result: null, encounteredQuestions: null, notes: null,
        }],
      }],
      resumeVersions: [], profile: null,
    };
    const workbook = buildExportWorkbook(data);
    const rows = readSheet(workbook, 'Applications');
    expect(rows[0]['OA Due At']).toBe('2026-08-15T09:00:00');
    expect(rows[0]['OA Timezone']).toBe('America/New_York');
    expect(rows[0]['OA Platform']).toBe('Coderbyte');
  });

  it('picks the assessment with the LATEST due date as "current" — regardless of relation-array order', () => {
    const earlier = {
      id: 'assess-earlier', applicationId: 'app-1', type: 'OA', platform: 'HackerRank',
      receivedAt: null, dueAt: new Date('2026-06-01T13:00:00.000Z'), timezone: 'America/New_York',
      completedAt: null, durationMinutes: null, questionCount: null, topics: null,
      difficulty: null, confidence: null, result: null, encounteredQuestions: null, notes: null,
    };
    const later = {
      id: 'assess-later', applicationId: 'app-1', type: 'OA', platform: 'Coderbyte',
      receivedAt: null, dueAt: new Date('2026-08-15T13:00:00.000Z'), timezone: 'America/Chicago',
      completedAt: null, durationMinutes: null, questionCount: null, topics: null,
      difficulty: null, confidence: null, result: null, encounteredQuestions: null, notes: null,
    };
    const data: ExportData = {
      // The LATER-due assessment is placed FIRST in the array — if export
      // logic depended on array order (e.g. last-in-array or first-in-array)
      // rather than the due date, this would pick the wrong one.
      applications: [{ ...baseApplication, status: 'OA', assessments: [later, earlier] }],
      resumeVersions: [], profile: null,
    };
    const workbook = buildExportWorkbook(data);
    const rows = readSheet(workbook, 'Applications');
    expect(rows[0]['OA Platform']).toBe('Coderbyte');
    expect(rows[0]['OA Timezone']).toBe('America/Chicago');
  });

  it('picks the interview with the LATEST scheduled start (within the current stage) as "current" — regardless of relation-array order', () => {
    const earlier = {
      id: 'int-earlier', applicationId: 'app-1', stage: 'Technical Interview',
      scheduledStart: new Date('2026-07-01T18:00:00.000Z'), scheduledEnd: null, timezone: 'America/New_York',
      format: null, location: null, meetingUrl: null, interviewer: 'Round 1 panel', recruiter: null,
      completedAt: null, result: null, questions: null, whatWentWell: null, improvements: null,
      followUpDate: null, notes: null,
    };
    const later = {
      id: 'int-later', applicationId: 'app-1', stage: 'Technical Interview',
      scheduledStart: new Date('2026-08-20T21:00:00.000Z'), scheduledEnd: null, timezone: 'America/Los_Angeles',
      format: null, location: null, meetingUrl: null, interviewer: 'Round 2 panel', recruiter: null,
      completedAt: null, result: null, questions: null, whatWentWell: null, improvements: null,
      followUpDate: null, notes: null,
    };
    const data: ExportData = {
      applications: [{
        ...baseApplication,
        status: 'Technical Interview',
        // Array order deliberately does NOT match chronological order.
        interviews: [later, earlier],
      }],
      resumeVersions: [], profile: null,
    };
    const workbook = buildExportWorkbook(data);
    const rows = readSheet(workbook, 'Interviews');
    // Both interview records still appear as their own Interviews-sheet rows...
    expect(rows).toHaveLength(2);
    // ...but the denormalized "current" schedule on the Applications sheet
    // must reflect the LATER (2:00 PM PDT), not whichever came first in the array.
    const appRows = readSheet(workbook, 'Applications');
    expect(appRows[0]['Interview Scheduled Start']).toBe('2026-08-20T14:00:00');
    expect(appRows[0]['Interview Timezone']).toBe('America/Los_Angeles');
  });

  it('ignores an earlier-stage interview when picking the current interview for a later stage', () => {
    const recruiterScreen = {
      id: 'int-rs', applicationId: 'app-1', stage: 'Recruiter Screen',
      scheduledStart: new Date('2026-09-01T18:00:00.000Z'), scheduledEnd: null, timezone: 'America/New_York',
      format: null, location: null, meetingUrl: null, interviewer: null, recruiter: null,
      completedAt: null, result: null, questions: null, whatWentWell: null, improvements: null,
      followUpDate: null, notes: null,
    };
    const technicalInterview = {
      id: 'int-tech', applicationId: 'app-1', stage: 'Technical Interview',
      scheduledStart: new Date('2026-07-01T18:00:00.000Z'), scheduledEnd: null, timezone: 'America/Chicago',
      format: null, location: null, meetingUrl: null, interviewer: null, recruiter: null,
      completedAt: null, result: null, questions: null, whatWentWell: null, improvements: null,
      followUpDate: null, notes: null,
    };
    const data: ExportData = {
      applications: [{
        ...baseApplication,
        status: 'Technical Interview',
        // The recruiter-screen interview has a LATER scheduledStart than the
        // technical-interview one, but the application's CURRENT stage is
        // Technical Interview — the recruiter screen must never be picked,
        // even though it's chronologically later.
        interviews: [recruiterScreen, technicalInterview],
      }],
      resumeVersions: [], profile: null,
    };
    const workbook = buildExportWorkbook(data);
    const appRows = readSheet(workbook, 'Applications');
    expect(appRows[0]['Interview Timezone']).toBe('America/Chicago');
  });

  it('tie-breaks two assessments with the identical due date deterministically by id, regardless of array order', () => {
    const sameDueA = {
      id: 'assess-aaa', applicationId: 'app-1', type: 'OA', platform: 'Platform A',
      receivedAt: null, dueAt: new Date('2026-08-15T13:00:00.000Z'), timezone: 'America/New_York',
      completedAt: null, durationMinutes: null, questionCount: null, topics: null,
      difficulty: null, confidence: null, result: null, encounteredQuestions: null, notes: null,
    };
    const sameDueB = {
      id: 'assess-zzz', applicationId: 'app-1', type: 'OA', platform: 'Platform B',
      receivedAt: null, dueAt: new Date('2026-08-15T13:00:00.000Z'), timezone: 'America/New_York',
      completedAt: null, durationMinutes: null, questionCount: null, topics: null,
      difficulty: null, confidence: null, result: null, encounteredQuestions: null, notes: null,
    };
    const forward: ExportData = { applications: [{ ...baseApplication, status: 'OA', assessments: [sameDueA, sameDueB] }], resumeVersions: [], profile: null };
    const reversed: ExportData = { applications: [{ ...baseApplication, status: 'OA', assessments: [sameDueB, sameDueA] }], resumeVersions: [], profile: null };

    const forwardPlatform = readSheet(buildExportWorkbook(forward), 'Applications')[0]['OA Platform'];
    const reversedPlatform = readSheet(buildExportWorkbook(reversed), 'Applications')[0]['OA Platform'];
    // Whichever one wins the tie-break, it must be the SAME one regardless of array order.
    expect(forwardPlatform).toBe(reversedPlatform);
    expect(forwardPlatform).toBe('Platform B'); // 'assess-zzz' sorts after 'assess-aaa' lexicographically
  });

  it('includes the resume version name on the Applications sheet when associated', () => {
    const data: ExportData = {
      applications: [{ ...baseApplication, resumeVersion: { id: 'resume-1', name: 'SWE Resume 2026', fileName: null, description: null, targetType: 'SWE', filePath: null, createdAt: new Date(), archived: false } }],
      resumeVersions: [], profile: null,
    };
    const workbook = buildExportWorkbook(data);
    const rows = readSheet(workbook, 'Applications');
    expect(rows[0]['Resume Version']).toBe('SWE Resume 2026');
  });
});
