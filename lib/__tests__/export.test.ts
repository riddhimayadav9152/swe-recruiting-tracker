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
  offers: null,
};

const readSheet = (workbook: XLSX.WorkBook, name: string) => XLSX.utils.sheet_to_json(workbook.Sheets[name]) as Array<Record<string, unknown>>;

describe('buildExportWorkbook', () => {
  it('includes every required sheet, even when empty', () => {
    const data: ExportData = { applications: [], resumeVersions: [], profile: null };
    const workbook = buildExportWorkbook(data);
    expect(workbook.SheetNames).toEqual([
      'Applications', 'Job Descriptions', 'Assessments', 'Interviews', 'Offers',
      'Contacts', 'Notes', 'Activity History', 'Resume Versions', 'Profile',
    ]);
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
