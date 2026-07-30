'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { formatByKind, formatDateOnly, formatInZone, formatTimestamp, isDeadlineOverdue, resolveDeadlineInstant, type DeadlineKind } from '@/lib/dates';
import { getActionVisibility, isMissingApplicationDate, type TransitionAction } from '@/lib/workflow-policy';
import { Activity, BriefcaseBusiness, CalendarDays, Download, FileText, FolderOpen, LayoutGrid, PlusCircle, Search, Settings, Users, FileStack, MessageSquareText } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { validateApplicationInput } from '@/lib/recruiting';

type ApplicationRecord = {
  id: string;
  applicationCode: string;
  company: string;
  role: string;
  status: string;
  currentStage: string | null;
  priority: string;
  applicationUrl: string | null;
  location: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  nextActionDueKind: 'date' | 'timestamp';
  applicationDeadline: string | null;
  dateFound: string | null;
  dateApplied: string | null;
  notes: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  jobDescription: { fullText: string | null } | null;
  resumeVersion: { id: string; name: string } | null;
  interviews: Array<{ id: string; stage: string; scheduledStart: string | null; timezone: string | null; completedAt: string | null; notes: string | null }>;
  assessments: Array<{ id: string; type: string; dueAt: string | null; timezone: string | null; platform: string | null; durationMinutes: number | null; questionCount: number | null; topics: string | null; completedAt: string | null; result: string | null }>;
  contacts: Array<{ name: string; email: string | null; notes: string | null }>;
  activities: Array<{ eventType: string; summary: string; createdAt: string }>;
  offers: { offerDate: string | null; decisionDeadline: string | null; compensationSummary: string | null; notes: string | null } | null;
};

type ResumeRecord = { id:string; name:string; targetType:string; fileName:string | null; description:string | null; applications: Array<{ id:string }> };

type ProfileRecord = { id:string; name:string; school:string; major:string; graduation:string; preferredLocation:string; currentExperience:string; targetRoles:string; targetCategories:string };

// --- Import wizard client-side types ----------------------------------------
// Deliberately NOT imported from lib/import.ts — that module pulls in
// '@prisma/client' and 'xlsx', which have no place in a client bundle. These
// mirror its shapes just closely enough for this component to render them;
// the server is always the source of truth for validation.
const IMPORT_TARGET_FIELDS = [
  'company', 'role', 'applicationUrl', 'priority', 'status', 'location',
  'applicationDeadline', 'dateFound', 'notes', 'dateApplied', 'resumeVersionName',
  'assessmentDueAt', 'assessmentTimezone', 'assessmentPlatform',
  'interviewScheduledStart', 'interviewTimezone',
  'offerDecisionDeadline', 'offerCompensationSummary', 'outcome',
  'nextAction', 'nextActionDue',
] as const;
type ImportTargetField = (typeof IMPORT_TARGET_FIELDS)[number];
const IMPORT_FIELD_LABELS: Record<ImportTargetField, string> = {
  company: 'Company', role: 'Role', applicationUrl: 'Application URL', priority: 'Priority', status: 'Status',
  location: 'Location', applicationDeadline: 'Application Deadline', dateFound: 'Date Found', notes: 'Notes',
  dateApplied: 'Date Applied', resumeVersionName: 'Resume Version (by name)',
  assessmentDueAt: 'OA Due At', assessmentTimezone: 'OA Timezone', assessmentPlatform: 'OA Platform',
  interviewScheduledStart: 'Interview Scheduled Start', interviewTimezone: 'Interview Timezone',
  offerDecisionDeadline: 'Decision Deadline', offerCompensationSummary: 'Compensation',
  outcome: 'Outcome / Rejection Reason', nextAction: 'Next Action (override)', nextActionDue: 'Next Action Due (override)',
};
type ImportColumnMap = Record<ImportTargetField, string | null>;
type ImportRowDecision = 'create' | 'update' | 'skip' | 'importAnyway';
type ImportDuplicateInfo = { source: 'database' | 'workbook'; applicationId?: string; rowNumber?: number; matchedOn: string } | null;
type ImportFieldDiff = { field: ImportTargetField; presence: 'supplied' | 'blank' | 'unmapped'; previousValue: string | null; newValue: string | null; kind: 'preserved' | 'unchanged' | 'changed' | 'clear' };
type ImportResumeMatch = { id: string; name: string } | null;
type ImportRelatedRecordEffect = { record: 'stage' | 'nextAction' | 'assessment' | 'interview' | 'offer' | 'outcome'; kind: 'create' | 'update' | 'retain' | 'change'; description: string };
type ImportPreviewRow = {
  rowNumber: number;
  status: 'valid' | 'invalid' | 'blank';
  data: Record<string, unknown> | null;
  errors: string[];
  warnings: string[];
  downgradedFrom: string | null;
  duplicate: ImportDuplicateInfo;
  suggestedAction: ImportRowDecision | 'error' | 'blank';
  diff: ImportFieldDiff[] | null;
  effects: ImportRelatedRecordEffect[] | null;
  resumeMatch: ImportResumeMatch;
};
type ImportPreviewResponse = {
  sheetNames: string[];
  sheetName: string;
  headers: string[];
  columnMap: ImportColumnMap;
  nextActionDueKindOverride: 'date' | 'timestamp' | null;
  rows: ImportPreviewRow[];
  summary: { total: number; valid: number; invalid: number; blank: number; duplicatesDatabase: number; duplicatesWorkbook: number; warnings: number };
};
type ImportResumeDecision = { action: 'existing'; resumeVersionId: string } | { action: 'create'; name: string; targetType: string } | { action: 'blank' };

type QuickAction = 'apply' | 'oaReceived' | 'oaCompleted' | 'interviewReceived' | 'interviewCompleted' | 'reject' | 'offer' | 'note' | 'contact' | 'setApplicationDate';

const quickActionTitles: Record<QuickAction, string> = {
  apply: 'Mark Applied',
  oaReceived: 'OA Received',
  oaCompleted: 'OA Completed',
  interviewReceived: 'Interview Received',
  interviewCompleted: 'Interview Completed',
  reject: 'Rejected',
  offer: 'Offer Received',
  note: 'Add Note',
  contact: 'Add Contact',
  setApplicationDate: 'Set Application Date',
};

const statusToneClass = (status: string) => {
  switch (status) {
    case 'Offer':
    case 'Accepted':
      return 'bg-emerald-50 text-emerald-600';
    case 'Rejected':
    case 'Withdrawn':
    case 'Closed':
      return 'bg-rose-50 text-rose-600';
    case 'OA':
      return 'bg-amber-50 text-amber-600';
    case 'Recruiter Screen':
    case 'Technical Interview':
    case 'Final Round':
      return 'bg-sky-50 text-sky-600';
    case 'Applied':
      return 'bg-indigo-50 text-indigo-600';
    default:
      return 'bg-[#fadde1] text-[#ff97b7]';
  }
};

const FieldError = ({ errors, name }: { errors: Record<string, string[] | undefined>; name: string }) => {
  const message = errors[name]?.[0];
  return message ? <p className="text-sm text-rose-600">{message}</p> : null;
};

// Interview times must be interpreted in whichever IANA zone the user
// actually picks, not wherever the server happens to be running — offer the
// full list the runtime knows about rather than a curated (and inevitably
// incomplete) subset.
const IANA_TIME_ZONES: string[] = (() => {
  // `Intl.supportedValuesOf('timeZone')` omits the plain "UTC" identifier
  // even in a runtime whose OWN resolved timezone is exactly "UTC" (e.g. any
  // CI runner/container defaulting to UTC) — so a <select> built from it
  // can't represent the very value `browserTimeZone()` defaults to there,
  // silently failing to select anything. Always include it explicitly.
  try {
    const zones = Intl.supportedValuesOf('timeZone');
    return zones.includes('UTC') ? zones : ['UTC', ...zones];
  } catch {
    return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];
  }
})();

const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
};

const sections = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutGrid },
  { key: 'applications', label: 'Applications', icon: BriefcaseBusiness },
  { key: 'pipeline', label: 'Pipeline', icon: FolderOpen },
  { key: 'deadlines', label: 'Deadlines', icon: CalendarDays },
  { key: 'job-descriptions', label: 'Job Descriptions', icon: FileText },
  { key: 'interviews', label: 'Interviews', icon: MessageSquareText },
  { key: 'contacts', label: 'Contacts', icon: Users },
  { key: 'resumes', label: 'Resume Versions', icon: FileStack },
  { key: 'activity', label: 'Activity', icon: Activity },
  { key: 'import-export', label: 'Import / Export', icon: Download },
  { key: 'settings', label: 'Settings', icon: Settings },
];

export default function TrackerShell() {
  const [activeSection, setActiveSection] = useState('dashboard');
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [profile, setProfile] = useState<ProfileRecord | null>(null);
  const [resumes, setResumes] = useState<ResumeRecord[]>([]);
  const [search, setSearch] = useState('');
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [showQuickModal, setShowQuickModal] = useState(false);
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [quickAction, setQuickAction] = useState<QuickAction>('apply');
  const [newForm, setNewForm] = useState({ company:'', role:'', applicationUrl:'', priority:'P2', status:'Not Applied', location:'', notes:'' });
  const [resumeForm, setResumeForm] = useState({ name:'', targetType:'', fileName:'', description:'' });
  const [resumeErrors, setResumeErrors] = useState<Record<string, string[] | undefined>>({});
  const [quickForm, setQuickForm] = useState<Record<string, string>>({});
  const [quickErrors, setQuickErrors] = useState<Record<string, string[] | undefined>>({});
  const [pendingOverride, setPendingOverride] = useState(false);
  const [importFileHandle, setImportFileHandle] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreviewResponse | null>(null);
  const [importRowActions, setImportRowActions] = useState<Record<number, ImportRowDecision>>({});
  const [importResumeDecisions, setImportResumeDecisions] = useState<Record<number, ImportResumeDecision>>({});
  const [importConfirmedClears, setImportConfirmedClears] = useState<Record<number, Set<ImportTargetField>>>({});
  const [importCommitMode, setImportCommitMode] = useState<'per-row' | 'batch'>('per-row');
  const [importNextActionDueKindOverride, setImportNextActionDueKindOverride] = useState<'date' | 'timestamp' | ''>('');
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<{ created: number; updated: number; skipped: number; errors: Array<{ rowNumber: number; errors: string[] }>; mode: string; backup: { fileName: string } } | null>(null);
  const [restoreFileHandle, setRestoreFileHandle] = useState<File | null>(null);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{
    backup: { fileName: string };
    applications: { created: number; updated: number };
    assessments: { created: number };
    interviews: { created: number };
    offers: { created: number };
    contacts: { created: number };
    notes: { created: number };
    activities: { created: number };
    jobDescriptions: { created: number };
    resumeVersions: { created: number; matched: number };
    profile: { created: boolean; updated: boolean };
    unmatchedApplicationCodes: Array<{ sheet: string; rowNumber: number; applicationCode: string }>;
    errors: Array<{ sheet: string; rowNumber: number; message: string }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [appsRes, profileRes, resumesRes] = await Promise.all([
        fetch('/api/applications'),
        fetch('/api/profile'),
        fetch('/api/resumes'),
      ]);
      const [appsData, profileData, resumesData] = await Promise.all([appsRes.json(), profileRes.json(), resumesRes.json()]);
      setApplications(appsData);
      setProfile(profileData);
      setResumes(resumesData);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem('tracker-section');
    if (saved) setActiveSection(saved);
    loadData();
  }, [loadData]);

  useEffect(() => { window.localStorage.setItem('tracker-section', activeSection); }, [activeSection]);

  useEffect(() => {
    if (applications.length && !selectedAppId) setSelectedAppId(applications[0].id);
  }, [applications, selectedAppId]);

  const selectedApp = useMemo(() => applications.find((app) => app.id === selectedAppId) ?? null, [applications, selectedAppId]);

  const filteredApplications = useMemo(() => {
    const term = search.toLowerCase();
    return applications.filter((app) => {
      const haystack = `${app.company} ${app.role} ${app.location ?? ''} ${app.notes ?? ''}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [applications, search]);

  const summary = useMemo(() => {
    const userTimeZone = browserTimeZone();
    const overdue = applications.filter((app) => isDeadlineOverdue(app.nextActionDue, app.nextActionDueKind, userTimeZone)).length;
    return {
      total: applications.length,
      notApplied: applications.filter((app) => app.status === 'Not Applied').length,
      applied: applications.filter((app) => app.status === 'Applied').length,
      oa: applications.filter((app) => app.status === 'OA').length,
      interviews: applications.filter((app) => ['Recruiter Screen','Technical Interview','Final Round'].includes(app.status)).length,
      offers: applications.filter((app) => app.status === 'Offer').length,
      rejections: applications.filter((app) => app.status === 'Rejected').length,
      overdue,
    };
  }, [applications]);

  const deadlineTimeZone = browserTimeZone();

  const deadlines = useMemo(() => applications
    .filter((app) => app.nextActionDue || app.applicationDeadline)
    .map((app) => ({
      id: app.id,
      label: app.nextActionDue ? `Next action • ${app.nextAction}` : `Deadline • ${app.company}`,
      dueDate: app.nextActionDue ?? app.applicationDeadline ?? null,
      // applicationDeadline (the fallback when there's no nextActionDue) is
      // always a calendar date; nextActionDue's kind is tracked explicitly
      // per-application since it can be either, depending on which workflow
      // last set it (see nextActionDueKind on the Application model).
      dueDateKind: (app.nextActionDue ? app.nextActionDueKind : 'date') as DeadlineKind,
      company: app.company,
      role: app.role,
    }))
    .sort((a, b) => {
      const aInstant = resolveDeadlineInstant(a.dueDate, a.dueDateKind, deadlineTimeZone);
      const bInstant = resolveDeadlineInstant(b.dueDate, b.dueDateKind, deadlineTimeZone);
      if (!aInstant || !bInstant) return 0;
      return aInstant.getTime() - bInstant.getTime();
    })
    .slice(0, 8), [applications, deadlineTimeZone]);

  const createApp = async (event: React.FormEvent) => {
    event.preventDefault();
    const errors = validateApplicationInput({
      company: newForm.company,
      role: newForm.role,
      applicationUrl: newForm.applicationUrl,
      priority: newForm.priority as 'P0' | 'P1' | 'P2' | 'P3',
      status: newForm.status as 'Not Applied' | 'Preparing' | 'Applied' | 'OA' | 'Recruiter Screen' | 'Technical Interview' | 'Final Round' | 'Offer' | 'Accepted' | 'Rejected' | 'Withdrawn' | 'Closed',
    });
    if (Object.keys(errors).length) {
      toast.error('Please complete the required fields');
      return;
    }
    const response = await fetch('/api/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newForm),
    });
    if (response.ok) {
      const created = await response.json();
      toast.success('Opportunity created');
      setShowNewModal(false);
      setNewForm({ company:'', role:'', applicationUrl:'', priority:'P2', status:'Not Applied', location:'', notes:'' });
      await loadData();
      setSelectedAppId(created.id);
    } else {
      const data = await response.json();
      toast.error(data.duplicate ? 'Likely duplicate detected' : 'Unable to create application');
    }
  };

  const runQuickAction = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedApp) return;
    setQuickErrors({});
    const payload = { action: quickAction, ...quickForm, ...(pendingOverride ? { override: true } : {}) };
    const response = await fetch(`/api/applications/${selectedApp.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.ok) {
      toast.success('Workflow updated');
      setShowQuickModal(false);
      setQuickForm({});
      setQuickErrors({});
      setPendingOverride(false);
      await loadData();
    } else {
      const data = await response.json();
      if (data?.errors) {
        setQuickErrors(data.errors);
        toast.error('Please fix the highlighted fields');
      } else {
        toast.error(data?.error ?? 'Unable to update workflow');
      }
    }
  };

  const openQuickAction = (action: QuickAction, initialForm: Record<string, string> = {}, override = false) => {
    setQuickErrors({});
    setQuickAction(action);
    setQuickForm(initialForm);
    setPendingOverride(override);
    setShowQuickModal(true);
  };

  const renderWorkflowButton = (
    app: ApplicationRecord,
    action: TransitionAction,
    label: string,
    initialForm: Record<string, string> = {},
  ) => {
    const visibility = getActionVisibility(app.status, action);
    if (visibility === 'hidden') return null;
    if (visibility === 'requiresOverride') {
      return (
        <button
          key={action}
          onClick={() => {
            if (!window.confirm(`This application is already "${app.status}", a final outcome. Continue with "${label}" anyway?`)) return;
            openQuickAction(action, initialForm, true);
          }}
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 transition hover:border-amber-300 hover:bg-amber-100"
        >
          {label} ⚠
        </button>
      );
    }
    return (
      <button key={action} onClick={() => openQuickAction(action, initialForm)} className="rounded-lg border border-[#ffc4d6] bg-white px-3 py-2 text-sm text-slate-600 transition hover:border-[#ffacc5] hover:bg-[#fadde1] hover:text-[#ff5d8f]">
        {label}
      </button>
    );
  };

  const saveJobDescription = async () => {
    if (!selectedApp) return;
    const response = await fetch(`/api/applications/${selectedApp.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'description', fullText: quickForm.fullText ?? '', minimumQualifications: quickForm.minimumQualifications ?? '', preferredQualifications: quickForm.preferredQualifications ?? '', keywords: quickForm.keywords ?? '' }),
    });
    if (response.ok) {
      toast.success('Job description saved');
      loadData();
    }
  };

  const exportWorkbook = async () => {
    const response = await fetch('/api/export');
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Riddhima_2027_SWE_Tracker_${format(new Date(), 'yyyy-MM-dd')}.xlsx`;
    link.click();
    window.URL.revokeObjectURL(url);
    toast.success('Excel export downloaded');
  };

  const fetchImportPreview = async (file: File, sheetName?: string, columnMapOverrides?: Partial<ImportColumnMap>, nextActionDueKindOverride?: 'date' | 'timestamp' | '') => {
    setImportLoading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (sheetName) formData.append('sheetName', sheetName);
      if (columnMapOverrides) formData.append('columnMapOverrides', JSON.stringify(columnMapOverrides));
      if (nextActionDueKindOverride) formData.append('nextActionDueKindOverride', nextActionDueKindOverride);
      const response = await fetch('/api/import/preview', { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data.error ?? 'Unable to preview this workbook');
        return;
      }
      setImportPreview(data);
      const initialActions: Record<number, ImportRowDecision> = {};
      const initialResumeDecisions: Record<number, ImportResumeDecision> = {};
      for (const row of data.rows as ImportPreviewRow[]) {
        if (row.status !== 'valid') continue;
        initialActions[row.rowNumber] = (row.suggestedAction as ImportRowDecision) ?? 'create';
        initialResumeDecisions[row.rowNumber] = row.resumeMatch ? { action: 'existing', resumeVersionId: row.resumeMatch.id } : { action: 'blank' };
      }
      setImportRowActions(initialActions);
      setImportResumeDecisions(initialResumeDecisions);
      setImportConfirmedClears({});
    } finally {
      setImportLoading(false);
    }
  };

  const handleImportFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportResult(null);
    setImportFileHandle(file);
    await fetchImportPreview(file);
    event.target.value = '';
  };

  const handleImportSheetChange = async (sheetName: string) => {
    if (!importFileHandle) return;
    await fetchImportPreview(importFileHandle, sheetName);
  };

  const handleImportColumnMapChange = async (field: ImportTargetField, header: string) => {
    if (!importFileHandle || !importPreview) return;
    await fetchImportPreview(importFileHandle, importPreview.sheetName, { ...importPreview.columnMap, [field]: header || null }, importNextActionDueKindOverride);
  };

  const handleImportNextActionDueKindChange = async (value: 'date' | 'timestamp' | '') => {
    setImportNextActionDueKindOverride(value);
    if (!importFileHandle || !importPreview) return;
    await fetchImportPreview(importFileHandle, importPreview.sheetName, importPreview.columnMap, value);
  };

  const toggleConfirmedClear = (rowNumber: number, field: ImportTargetField) => {
    setImportConfirmedClears((prev) => {
      const current = new Set(prev[rowNumber] ?? []);
      if (current.has(field)) current.delete(field);
      else current.add(field);
      return { ...prev, [rowNumber]: current };
    });
  };

  const resetImportWizard = () => {
    setImportFileHandle(null);
    setImportPreview(null);
    setImportRowActions({});
    setImportResumeDecisions({});
    setImportConfirmedClears({});
  };

  const confirmImport = async () => {
    if (!importPreview) return;
    setImportLoading(true);
    try {
      const rows = importPreview.rows
        .filter((row) => row.status === 'valid')
        .map((row) => ({
          rowNumber: row.rowNumber,
          action: importRowActions[row.rowNumber] ?? 'create',
          data: row.data,
          matchedApplicationId: row.duplicate?.source === 'database' ? row.duplicate.applicationId ?? null : null,
          resumeVersionDecision: importResumeDecisions[row.rowNumber],
          confirmedClears: Array.from(importConfirmedClears[row.rowNumber] ?? []),
        }));

      const response = await fetch('/api/import/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: importCommitMode, rows }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data.error ?? 'Import failed');
        return;
      }
      setImportResult(data);
      if (data.errors.length && importCommitMode === 'batch') {
        toast.error(`Batch import aborted — nothing was written: ${data.errors[0]?.errors?.[0] ?? 'unknown error'}`);
      } else {
        toast.success(`Imported: ${data.created} created, ${data.updated} updated, ${data.skipped} skipped${data.errors.length ? `, ${data.errors.length} failed` : ''} (backup: ${data.backup?.fileName})`);
      }
      resetImportWizard();
      await loadData();
    } finally {
      setImportLoading(false);
    }
  };

  const backupDatabase = async () => {
    const response = await fetch('/api/backup');
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'recruiting-tracker.db';
    link.click();
    window.URL.revokeObjectURL(url);
    toast.success('Database backup downloaded');
  };

  // Restores a raw SQLite .db file (e.g. one downloaded via "Download SQLite
  // backup" above, or a file recovered from data/backups/) — this REPLACES
  // the entire live database, so it's confirmed explicitly before running.
  const restoreDatabaseFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!window.confirm('This will REPLACE the entire current database with the uploaded file. A safety backup of the current database is taken first. Continue?')) return;
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch('/api/backup', { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok) {
      toast.error(data.error ?? 'Restore failed');
      return;
    }
    toast.success(`Database restored (safety backup: ${data.backup?.fileName ?? 'n/a'})`);
    await loadData();
  };

  const handleRestoreFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setRestoreResult(null);
    setRestoreFileHandle(file ?? null);
  };

  // Restores a FULL export workbook (every sheet, keyed by Application Code)
  // into the CURRENT database — additive/updating by Application Code, not
  // a wholesale file replacement (see restoreDatabaseFile above for that).
  const confirmMultiSheetRestore = async () => {
    if (!restoreFileHandle) return;
    setRestoreLoading(true);
    try {
      const formData = new FormData();
      formData.append('file', restoreFileHandle);
      const response = await fetch('/api/import/restore', { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data.error ?? 'Restore failed');
        return;
      }
      setRestoreResult(data);
      setRestoreFileHandle(null);
      toast.success(`Restored: ${data.applications.created} applications created, ${data.applications.updated} updated (backup: ${data.backup?.fileName})`);
      await loadData();
    } finally {
      setRestoreLoading(false);
    }
  };

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile) return;
    const response = await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) });
    if (response.ok) toast.success('Profile saved');
  };

  const createResume = async (event: React.FormEvent) => {
    event.preventDefault();
    setResumeErrors({});
    const response = await fetch('/api/resumes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: resumeForm.name,
        targetType: resumeForm.targetType,
        fileName: resumeForm.fileName || null,
        description: resumeForm.description || null,
      }),
    });
    if (response.ok) {
      toast.success('Resume created');
      setShowResumeModal(false);
      setResumeForm({ name:'', targetType:'', fileName:'', description:'' });
      setResumeErrors({});
      await loadData();
    } else {
      const data = await response.json();
      if (data?.errors) {
        setResumeErrors(data.errors);
        toast.error('Please fix the highlighted fields');
      } else {
        toast.error(data?.error ?? 'Unable to create resume');
      }
    }
  };

  return (
    <div className="min-h-screen bg-[#fadde1] text-slate-800">
      <div className="flex min-h-screen flex-col lg:flex-row">
        <aside className="w-full border-b border-[#ffcad4] bg-white p-6 lg:w-72 lg:border-b-0 lg:border-r">
          <div className="mb-6">
            <p className="text-xs uppercase tracking-[0.3em] text-[#ffa6c1]">Recruiting Workspace</p>
            <h1 className="mt-2 text-xl font-semibold text-slate-900">Pipeline</h1>
          </div>
          <button onClick={() => setShowNewModal(true)} className="mb-6 flex w-full items-center justify-center gap-2 rounded-lg bg-[#ff87ab] px-4 py-3 text-sm font-medium text-slate-900 shadow-sm transition hover:bg-[#ff5d8f]">
            <PlusCircle size={18} /> New Opportunity
          </button>
          <nav className="space-y-1">
            {sections.map((section) => {
              const Icon = section.icon;
              return (
                <button key={section.key} onClick={() => setActiveSection(section.key)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${activeSection === section.key ? 'bg-[#ff87ab] text-slate-900' : 'text-slate-600 hover:bg-[#fadde1] hover:text-[#ff5d8f]'}`}>
                  <Icon size={16} /> {section.label}
                </button>
              );
            })}
          </nav>
        </aside>
        <main className="flex-1 p-6 lg:p-8">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">{profile?.name ?? 'Riddhima Yadav'}</p>
              <h2 className="text-2xl font-semibold">{sections.find((section) => section.key === activeSection)?.label ?? 'Dashboard'}</h2>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-[#ffc4d6] bg-white px-4 py-2 text-sm text-slate-600 shadow-sm transition focus-within:border-[#ffa6c1] focus-within:ring-2 focus-within:ring-[#ffcad4]">
              <Search size={16} className="text-[#ffa6c1]" />
              <label htmlFor="application-search" className="sr-only">Search applications</label>
              <input id="application-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search applications" className="w-44 bg-transparent outline-none placeholder:text-slate-400" />
            </div>
          </div>

          {loading ? <div className="rounded-xl border border-[#ffcad4] bg-white p-8 text-slate-500 shadow-sm">Loading tracker data…</div> : (
            <>
              {activeSection === 'dashboard' && (
                <div className="space-y-6">
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    {([
                      ['Total tracked opportunities', summary.total],
                      ['Not applied', summary.notApplied],
                      ['Applications submitted', summary.applied],
                      ['Active OAs', summary.oa],
                      ['Active interviews', summary.interviews],
                      ['Offers', summary.offers],
                      ['Rejections', summary.rejections],
                      ['Overdue actions', summary.overdue],
                    ] as Array<[string, number]>).map(([label, value], index) => {
                      const palette = [
                        'bg-white text-[#ff5d8f]',
                        'bg-sky-50 text-sky-600',
                        'bg-fuchsia-50 text-fuchsia-600',
                        'bg-emerald-50 text-emerald-600',
                        'bg-indigo-50 text-indigo-600',
                        'bg-amber-50 text-amber-600',
                        'bg-rose-50 text-rose-600',
                        'bg-teal-50 text-teal-600',
                      ];
                      const tone = palette[index % palette.length];
                      return (
                        <div key={label} className={`rounded-xl border border-[#ffcad4] p-4 shadow-sm ${tone}`}>
                          <p className="text-sm opacity-80">{label}</p>
                          <p className="mt-2 text-2xl font-semibold">{value}</p>
                        </div>
                      );
                    })}
                  </div>
                  <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
                    <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                      <h3 className="text-lg font-semibold">Upcoming deadlines</h3>
                      <div className="mt-4 space-y-3">
                        {deadlines.map((item) => (
                          <button key={item.id} onClick={() => { setSelectedAppId(item.id); setActiveSection('applications'); }} className="flex w-full items-center justify-between rounded-lg border border-[#ffcad4] bg-white p-3 text-left transition hover:border-[#ffacc5] hover:bg-[#fadde1]/60">
                            <div>
                              <p className="font-medium">{item.company}</p>
                              <p className="text-sm text-slate-500">{item.label}</p>
                            </div>
                            <div className="text-sm text-slate-600">{item.dueDate ? formatByKind(item.dueDate, item.dueDateKind, 'MMM d') : '—'}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                      <h3 className="text-lg font-semibold">Needs attention</h3>
                      <div className="mt-4 space-y-3">
                        {applications.filter((app) => isDeadlineOverdue(app.nextActionDue, app.nextActionDueKind, browserTimeZone()) || !app.jobDescription || !app.resumeVersion).slice(0, 6).map((app) => (
                          <div key={app.id} className="rounded-lg border border-amber-100 bg-amber-50 p-3 text-sm">
                            <div className="font-medium">{app.company}</div>
                            <div className="text-amber-800">{app.nextAction ?? 'Review this opportunity'}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeSection === 'applications' && (
                <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
                  <div className="rounded-xl border border-[#ffcad4] bg-white p-4 shadow-sm">
                    <div className="mb-4 flex items-center justify-between">
                      <h3 className="text-lg font-semibold">Applications</h3>
                      <button onClick={() => setShowNewModal(true)} className="rounded-lg border border-[#ffc4d6] bg-white px-3 py-2 text-sm text-slate-600 transition hover:border-[#ffacc5] hover:bg-[#fadde1] hover:text-[#ff5d8f]">+ New</button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead>
                          <tr className="border-b border-[#ffcad4] text-left text-[#ffa6c1]">
                            <th className="px-3 py-2">Company</th>
                            <th className="px-3 py-2">Role</th>
                            <th className="px-3 py-2">Status</th>
                            <th className="px-3 py-2">Next action</th>
                            <th className="px-3 py-2">Due</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredApplications.map((app) => (
                            <tr key={app.id} onClick={() => setSelectedAppId(app.id)} className={`cursor-pointer border-b border-[#fadde1] transition ${selectedAppId === app.id ? 'bg-[#fadde1]' : 'hover:bg-[#fadde1]/60'}`}>
                              <td className="px-3 py-3 font-medium">{app.company}</td>
                              <td className="px-3 py-3">{app.role}</td>
                              <td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-xs font-medium ${statusToneClass(app.status)}`}>{app.status}</span></td>
                              <td className="px-3 py-3">{app.nextAction}</td>
                              <td className="px-3 py-3">{app.nextActionDue ? formatByKind(app.nextActionDue, app.nextActionDueKind, 'MMM d') : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                    {selectedApp ? (
                      <>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm text-slate-500">{selectedApp.applicationCode}</p>
                            <h3 className="text-xl font-semibold">{selectedApp.company}</h3>
                            <p className="text-sm text-slate-600">{selectedApp.role}</p>
                          </div>
                          <span className="rounded-full bg-[#fadde1] px-2 py-1 text-xs font-medium text-[#ff97b7]">{selectedApp.priority}</span>
                        </div>
                        <div className="mt-4 space-y-3 text-sm text-slate-600">
                          <div className="rounded-lg border border-[#ffcad4] bg-white p-3">Status: <span data-testid="app-status" className={`rounded-full px-2 py-0.5 font-medium ${statusToneClass(selectedApp.status)}`}>{selectedApp.status}</span></div>
                          <div className="rounded-lg border border-[#ffcad4] bg-white p-3">Stage: <span className="font-medium text-slate-900">{selectedApp.currentStage}</span></div>
                          <div className="rounded-lg border border-[#ffcad4] bg-white p-3">Next action: <span className="font-medium text-slate-900">{selectedApp.nextAction}</span></div>
                          <div className="rounded-lg border border-[#ffcad4] bg-white p-3">Last update: <span className="font-medium text-slate-900">{formatDistanceToNow(new Date(selectedApp.updatedAt), { addSuffix: true })}</span></div>
                          {selectedApp.dateApplied && (
                            <div className="rounded-lg border border-[#ffcad4] bg-white p-3">Date applied: <span data-testid="date-applied" className="font-medium text-slate-900">{formatDateOnly(selectedApp.dateApplied)}</span></div>
                          )}
                          {isMissingApplicationDate(selectedApp) && (
                            <div data-testid="missing-date-applied-warning" className="rounded-lg border border-amber-100 bg-amber-50 p-3 text-amber-700">
                              <p>This application is marked &ldquo;{selectedApp.status}&rdquo; but has no application date recorded — likely from an import.</p>
                              <button
                                onClick={() => openQuickAction('setApplicationDate')}
                                className="mt-2 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-800 transition hover:bg-amber-100"
                              >
                                Set Application Date
                              </button>
                            </div>
                          )}
                          {selectedApp.offers && (
                            <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3">
                              <p className="font-medium text-emerald-900">Offer details</p>
                              <p>Offer date: <span data-testid="offer-date" className="font-medium text-slate-900">{formatDateOnly(selectedApp.offers.offerDate)}</span></p>
                              <p>Decision deadline: <span data-testid="offer-deadline" className="font-medium text-slate-900">{formatDateOnly(selectedApp.offers.decisionDeadline)}</span></p>
                              <p>Compensation: <span data-testid="offer-compensation" className="font-medium text-slate-900">{selectedApp.offers.compensationSummary ?? '—'}</span></p>
                              <p>Notes: <span data-testid="offer-notes" className="font-medium text-slate-900">{selectedApp.offers.notes ?? '—'}</span></p>
                            </div>
                          )}
                          {selectedApp.assessments.map((assessment) => (
                            <div key={assessment.id} data-testid="assessment-detail" className="rounded-lg border border-sky-100 bg-sky-50 p-3">
                              <p className="font-medium text-sky-900">{assessment.type} assessment</p>
                              {assessment.dueAt && (
                                <p>Due: <span className="font-medium text-slate-900">
                                  {formatInZone(assessment.dueAt, assessment.timezone, 'MMM d, yyyy h:mm a zzz')}
                                  {assessment.timezone && assessment.timezone !== browserTimeZone() && (
                                    <> ({formatTimestamp(assessment.dueAt, 'MMM d, h:mm a')} your time)</>
                                  )}
                                </span></p>
                              )}
                              <p>Platform: <span className="font-medium text-slate-900">{assessment.platform ?? '—'}</span></p>
                              <p>Duration: <span className="font-medium text-slate-900">{assessment.durationMinutes ? `${assessment.durationMinutes} min` : '—'}</span></p>
                              <p>Questions: <span className="font-medium text-slate-900">{assessment.questionCount ?? '—'}</span></p>
                              <p>Topics: <span className="font-medium text-slate-900">{assessment.topics ?? '—'}</span></p>
                              <p>Status: <span className="font-medium text-slate-900">{assessment.completedAt ? `Completed ${formatTimestamp(assessment.completedAt, 'MMM d, yyyy')}` : 'In progress'}</span></p>
                              {assessment.completedAt && <p>Result: <span className="font-medium text-slate-900">{assessment.result ?? '—'}</span></p>}
                            </div>
                          ))}
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          {renderWorkflowButton(selectedApp, 'apply', 'Mark Applied', { resumeVersionId: selectedApp.resumeVersion?.id ?? '' })}
                          {renderWorkflowButton(selectedApp, 'oaReceived', 'OA Received', { timezone: browserTimeZone() })}
                          {selectedApp.assessments.some((assessment) => assessment.type === 'OA' && !assessment.completedAt) &&
                            renderWorkflowButton(selectedApp, 'oaCompleted', 'OA Completed', { assessmentId: '' })}
                          {renderWorkflowButton(selectedApp, 'interviewReceived', 'Interview Received', { timezone: browserTimeZone() })}
                          {selectedApp.interviews.some((interview) => !interview.completedAt) &&
                            renderWorkflowButton(selectedApp, 'interviewCompleted', 'Interview Completed', { interviewId: '' })}
                          {renderWorkflowButton(selectedApp, 'reject', 'Rejected')}
                          {renderWorkflowButton(selectedApp, 'offer', 'Offer Received')}
                          <button onClick={() => openQuickAction('note')} className="rounded-lg border border-[#ffc4d6] bg-white px-3 py-2 text-sm text-slate-600 transition hover:border-[#ffacc5] hover:bg-[#fadde1] hover:text-[#ff5d8f]">Add Note</button>
                          <button onClick={() => openQuickAction('contact')} className="rounded-lg border border-[#ffc4d6] bg-white px-3 py-2 text-sm text-slate-600 transition hover:border-[#ffacc5] hover:bg-[#fadde1] hover:text-[#ff5d8f]">Add Contact</button>
                        </div>
                      </>
                    ) : <div className="text-sm text-slate-500">Select an application</div>}
                  </div>
                </div>
              )}

              {activeSection === 'pipeline' && (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {['Not Applied','Preparing','Applied','OA','Recruiter Screen','Technical Interview','Final Round','Offer'].map((status) => (
                    <div key={status} className="rounded-xl border border-[#ffcad4] bg-white p-4 shadow-sm">
                      <h3 className="font-semibold">{status}</h3>
                      <div className="mt-3 space-y-2">
                        {applications.filter((app) => app.status === status).slice(0, 4).map((app) => (
                          <div key={app.id} className="rounded-lg border border-[#ffcad4] bg-white p-3 text-sm transition hover:border-[#ffc4d6] hover:bg-[#fadde1]/50">
                            <div className="font-medium">{app.company}</div>
                            <div className="text-slate-500">{app.role}</div>
                            <div className="mt-1 text-xs text-slate-500">{app.nextAction}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeSection === 'deadlines' && (
                <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                  <h3 className="text-lg font-semibold">Deadlines</h3>
                  <div className="mt-4 space-y-3">
                    {deadlines.map((item) => (
                      <div key={item.id} className="flex items-center justify-between rounded-lg border border-[#ffcad4] bg-white p-3 text-sm">
                        <div>
                          <div className="font-medium">{item.company}</div>
                          <div className="text-slate-500">{item.label}</div>
                        </div>
                        <div className="text-slate-600">{item.dueDate ? formatByKind(item.dueDate, item.dueDateKind) : '—'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeSection === 'job-descriptions' && (
                <div className="grid gap-6 xl:grid-cols-[0.8fr_1.2fr]">
                  <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                    <h3 className="text-lg font-semibold">Saved descriptions</h3>
                    <div className="mt-4 space-y-3">
                      {applications.filter((app) => app.jobDescription?.fullText).map((app) => (
                        <button key={app.id} onClick={() => setSelectedAppId(app.id)} className="w-full rounded-lg border border-[#ffcad4] bg-white p-3 text-left text-sm transition hover:border-[#ffacc5] hover:bg-[#fadde1]/60">
                          <div className="font-medium">{app.company}</div>
                          <div className="text-slate-500">{app.jobDescription?.fullText?.slice(0, 90)}...</div>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                    <h3 className="text-lg font-semibold">Editor</h3>
                    {selectedApp ? (
                      <div className="mt-4 space-y-3">
                        <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="jd-full-text">Full job description</label>
                        <textarea id="jd-full-text" value={quickForm.fullText ?? selectedApp.jobDescription?.fullText ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, fullText: e.target.value }))} rows={10} className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Paste the full job description" />
                        <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="jd-min-quals">Minimum qualifications</label>
                        <textarea id="jd-min-quals" value={quickForm.minimumQualifications ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, minimumQualifications: e.target.value }))} rows={4} className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Minimum qualifications" />
                        <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="jd-preferred-quals">Preferred qualifications</label>
                        <textarea id="jd-preferred-quals" value={quickForm.preferredQualifications ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, preferredQualifications: e.target.value }))} rows={4} className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Preferred qualifications" />
                        <button onClick={saveJobDescription} className="rounded-lg bg-[#ff87ab] px-4 py-2 text-sm font-medium text-slate-900 shadow-sm transition hover:bg-[#ff5d8f]">Save description</button>
                      </div>
                    ) : <div className="text-sm text-slate-500">Select an application</div>}
                  </div>
                </div>
              )}

              {activeSection === 'interviews' && (
                <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                  <h3 className="text-lg font-semibold">Interviews</h3>
                  <div className="mt-4 space-y-3">
                    {applications.flatMap((app) => app.interviews.map((interview) => ({ ...interview, company: app.company, role: app.role, appId: app.id }))).map((interview) => (
                      <div key={interview.id} className="rounded-lg border border-[#ffcad4] bg-white p-3 text-sm transition hover:border-[#ffc4d6] hover:bg-[#fadde1]/50">
                        <div className="font-medium">{interview.company} • {interview.role}</div>
                        <div className="text-slate-500">{interview.stage}</div>
                        {interview.scheduledStart && (
                          <div className="text-slate-500">
                            {formatInZone(interview.scheduledStart, interview.timezone)}
                            {interview.timezone && interview.timezone !== browserTimeZone() && (
                              <> ({formatTimestamp(interview.scheduledStart)} your time)</>
                            )}
                          </div>
                        )}
                        <div className="text-slate-500">{interview.notes}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeSection === 'contacts' && (
                <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                  <h3 className="text-lg font-semibold">Contacts</h3>
                  <div className="mt-4 space-y-3">
                    {applications.flatMap((app) => app.contacts.map((contact) => ({ ...contact, company: app.company, appId: app.id }))).map((contact) => (
                      <div key={`${contact.appId}-${contact.name}`} className="rounded-lg border border-[#ffcad4] bg-white p-3 text-sm transition hover:border-[#ffc4d6] hover:bg-[#fadde1]/50">
                        <div className="font-medium">{contact.name}</div>
                        <div className="text-slate-500">{contact.email}</div>
                        <div className="text-slate-500">{contact.notes}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeSection === 'resumes' && (
                <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                  <h3 className="text-lg font-semibold">Resume versions</h3>
                  <div className="mt-4 space-y-3">
                    <button onClick={() => { setResumeErrors({}); setShowResumeModal(true); }} className="rounded-lg bg-[#ff87ab] px-4 py-2 text-sm font-medium text-slate-900 shadow-sm transition hover:bg-[#ff5d8f]">Create Resume</button>
                    {resumes.map((resume) => (
                      <div key={resume.id} className="rounded-lg border border-[#ffcad4] bg-white p-3 text-sm transition hover:border-[#ffc4d6] hover:bg-[#fadde1]/50">
                        <div className="font-medium">{resume.name}</div>
                        <div className="text-slate-500">{resume.targetType} • {resume.fileName}</div>
                        <div className="text-slate-500">Used by {resume.applications.length} application(s)</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeSection === 'activity' && (
                <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                  <h3 className="text-lg font-semibold">Activity history</h3>
                  <div className="mt-4 space-y-3">
                    {applications.flatMap((app) => app.activities.map((activity) => ({ ...activity, company: app.company }))).sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map((activity) => (
                      <div key={`${activity.company}-${activity.createdAt}`} className="rounded-lg border border-[#ffcad4] bg-white p-3 text-sm transition hover:border-[#ffc4d6] hover:bg-[#fadde1]/50">
                        <div className="font-medium">{activity.company}</div>
                        <div className="text-slate-500">{activity.eventType}</div>
                        <div className="text-slate-500">{activity.summary}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeSection === 'import-export' && (
                <div className="space-y-6">
                  <div className="grid gap-6 xl:grid-cols-2">
                    <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                      <h3 className="text-lg font-semibold">Export</h3>
                      <div className="mt-4 space-y-3">
                        <button onClick={exportWorkbook} className="rounded-lg bg-[#ff87ab] px-4 py-2 text-sm font-medium text-slate-900 shadow-sm transition hover:bg-[#ff5d8f]">Export Excel workbook</button>
                        <button onClick={backupDatabase} className="rounded-lg border border-[#ffc4d6] bg-white px-4 py-2 text-sm text-slate-600 transition hover:border-[#ffacc5] hover:bg-[#fadde1]">Download SQLite backup</button>
                      </div>
                      <div className="mt-4 border-t border-[#ffcad4] pt-4">
                        <label className="block text-sm font-medium text-slate-700" htmlFor="restore-db-file">Restore from raw backup file</label>
                        <p className="mt-1 text-xs text-slate-500">Replaces the ENTIRE current database with an uploaded <code>.db</code> file (e.g. one from &ldquo;Download SQLite backup&rdquo; above, or from <code>data/backups/</code>). A safety backup of the current database is always taken first.</p>
                        <input id="restore-db-file" type="file" accept=".db" onChange={restoreDatabaseFile} className="mt-2 block w-full text-sm" />
                      </div>
                    </div>
                    <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                      <h3 className="text-lg font-semibold">Import</h3>
                      <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                        <p className="font-semibold">⚠ Experimental — back up your database first</p>
                        <p className="mt-1">Download a SQLite backup above before importing. Review the preview carefully — nothing is written until you confirm.</p>
                      </div>
                      <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="import-file">Tracker workbook file</label>
                      <input id="import-file" type="file" accept=".xlsx,.xls" onChange={handleImportFileSelected} className="mt-2 block w-full text-sm" />
                      <p className="mt-3 text-sm text-slate-500">Upload a workbook to preview and map its rows before anything is imported.</p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                    <h3 className="text-lg font-semibold">Restore full backup (all sheets)</h3>
                    <p className="mt-2 text-sm text-slate-600">
                      Restores EVERY sheet from a full &ldquo;Export Excel workbook&rdquo; file — Applications, Job Descriptions, Assessments, Interviews, Offers, Contacts, Notes, Activity History, Resume Versions, and Profile — matched by Application Code. This is atomic (one transaction, all-or-nothing) and additive/updating: an Application Code that already exists is updated, a new one is created. Use this to recover from a lost database or migrate to a fresh one, not for reviewing individual rows (use Import above for that).
                    </p>
                    <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="restore-workbook-file">Full export workbook file</label>
                    <input id="restore-workbook-file" type="file" accept=".xlsx,.xls" onChange={handleRestoreFileSelected} className="mt-2 block w-full text-sm" />
                    {restoreFileHandle && (
                      <div className="mt-3 flex items-center gap-3">
                        <span className="text-sm text-slate-600">{restoreFileHandle.name}</span>
                        <button
                          onClick={confirmMultiSheetRestore}
                          disabled={restoreLoading}
                          className="rounded-lg bg-[#ff87ab] px-4 py-2 text-sm font-medium text-slate-900 shadow-sm transition hover:bg-[#ff5d8f] disabled:opacity-50"
                        >
                          {restoreLoading ? 'Restoring…' : 'Confirm Restore'}
                        </button>
                        <button onClick={() => setRestoreFileHandle(null)} className="rounded-lg border border-[#ffc4d6] bg-white px-4 py-2 text-sm text-slate-600 transition hover:border-[#ffacc5] hover:bg-[#fadde1]">Cancel</button>
                      </div>
                    )}
                    {restoreResult && (
                      <div className="mt-4 rounded-lg border border-[#ffcad4] bg-[#fadde1]/30 p-3 text-sm" data-testid="restore-result">
                        <p className="text-xs text-slate-500">
                          Database backed up to <code>{restoreResult.backup.fileName}</code> before any writes.
                        </p>
                        <p className="mt-2 text-slate-600">
                          Applications: {restoreResult.applications.created} created, {restoreResult.applications.updated} updated
                          {' • '}Assessments: {restoreResult.assessments.created}
                          {' • '}Interviews: {restoreResult.interviews.created}
                          {' • '}Offers: {restoreResult.offers.created}
                          {' • '}Contacts: {restoreResult.contacts.created}
                          {' • '}Notes: {restoreResult.notes.created}
                          {' • '}Activities: {restoreResult.activities.created}
                          {' • '}Job Descriptions: {restoreResult.jobDescriptions.created}
                          {' • '}Resume Versions: {restoreResult.resumeVersions.created} created, {restoreResult.resumeVersions.matched} matched
                        </p>
                        {restoreResult.unmatchedApplicationCodes.length > 0 && (
                          <div className="mt-2 space-y-1">
                            <p className="font-medium text-amber-700">Unmatched Application Codes (row skipped):</p>
                            {restoreResult.unmatchedApplicationCodes.map((u, index) => (
                              <div key={index} className="text-xs text-amber-700">{u.sheet} row {u.rowNumber}: &ldquo;{u.applicationCode}&rdquo;</div>
                            ))}
                          </div>
                        )}
                        {restoreResult.errors.length > 0 && (
                          <div className="mt-2 space-y-1">
                            <p className="font-medium text-rose-700">Errors:</p>
                            {restoreResult.errors.map((e, index) => (
                              <div key={index} className="text-xs text-rose-700">{e.sheet} row {e.rowNumber}: {e.message}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {importLoading && !importPreview && <div className="rounded-xl border border-[#ffcad4] bg-white p-6 text-sm text-slate-500 shadow-sm">Reading workbook…</div>}

                  {importPreview && (
                    <div className="space-y-4 rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h3 className="text-lg font-semibold">Preview — {importPreview.sheetName}</h3>
                        {importPreview.sheetNames.length > 1 && (
                          <label className="flex items-center gap-2 text-sm text-slate-600">
                            Sheet
                            <select
                              value={importPreview.sheetName}
                              onChange={(e) => handleImportSheetChange(e.target.value)}
                              className="rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm outline-none focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]"
                            >
                              {importPreview.sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
                            </select>
                          </label>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-3 text-sm">
                        <span className="rounded-full bg-slate-100 px-3 py-1">{importPreview.summary.total} rows</span>
                        <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700">{importPreview.summary.valid} valid</span>
                        <span className="rounded-full bg-rose-50 px-3 py-1 text-rose-700">{importPreview.summary.invalid} invalid</span>
                        <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-500">{importPreview.summary.blank} blank</span>
                        <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">{importPreview.summary.duplicatesDatabase} match existing records</span>
                        <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">{importPreview.summary.duplicatesWorkbook} duplicate within workbook</span>
                        <span className="rounded-full bg-sky-50 px-3 py-1 text-sky-700">{importPreview.summary.warnings} row(s) with warnings</span>
                      </div>

                      <details className="rounded-lg border border-[#ffcad4] p-3">
                        <summary className="cursor-pointer text-sm font-medium text-slate-700">Column mapping</summary>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {IMPORT_TARGET_FIELDS.map((field) => (
                            <label key={field} className="text-xs text-slate-600">
                              {IMPORT_FIELD_LABELS[field]}
                              <select
                                value={importPreview.columnMap[field] ?? ''}
                                onChange={(e) => handleImportColumnMapChange(field, e.target.value)}
                                className="mt-1 block w-full rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm outline-none focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]"
                              >
                                <option value="">Not mapped</option>
                                {importPreview.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                              </select>
                            </label>
                          ))}
                          <label className="text-xs text-slate-600">
                            Next Action Due — ambiguous numeric cells
                            <select
                              value={importNextActionDueKindOverride}
                              onChange={(e) => handleImportNextActionDueKindChange(e.target.value as 'date' | 'timestamp' | '')}
                              className="mt-1 block w-full rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm outline-none focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]"
                            >
                              <option value="">Infer from cell format (default)</option>
                              <option value="date">Treat as Date</option>
                              <option value="timestamp">Treat as Timestamp</option>
                            </select>
                          </label>
                        </div>
                      </details>

                      <div className="overflow-x-auto">
                        <table className="min-w-full text-sm">
                          <thead>
                            <tr className="border-b border-[#ffcad4] text-left text-[#ffa6c1]">
                              <th className="px-2 py-2">Row</th>
                              <th className="px-2 py-2">Company</th>
                              <th className="px-2 py-2">Role</th>
                              <th className="px-2 py-2">Status</th>
                              <th className="px-2 py-2">Issue / duplicate / warnings</th>
                              <th className="px-2 py-2">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {importPreview.rows.filter((row) => row.status !== 'blank').map((row) => {
                              const action = importRowActions[row.rowNumber] ?? 'create';
                              const resumeNameSupplied = typeof row.data?.resumeVersionName === 'string' && row.data.resumeVersionName;
                              return (
                              <tr key={row.rowNumber} data-testid="import-preview-row" className="border-b border-[#fadde1] align-top">
                                <td className="px-2 py-2 text-slate-500">{row.rowNumber}</td>
                                <td className="px-2 py-2">{typeof row.data?.company === 'string' ? row.data.company : '—'}</td>
                                <td className="px-2 py-2">{typeof row.data?.role === 'string' ? row.data.role : '—'}</td>
                                <td className="px-2 py-2">{typeof row.data?.status === 'string' ? row.data.status : '—'}</td>
                                <td className="px-2 py-2 text-xs">
                                  {row.status === 'invalid' && <span data-testid="import-row-error" className="text-rose-600">{row.errors.join('; ')}</span>}
                                  {row.duplicate?.source === 'database' && <div className="text-amber-700">Matches an existing application</div>}
                                  {row.duplicate?.source === 'workbook' && <div className="text-amber-700">Duplicates row {row.duplicate.rowNumber} in this sheet</div>}
                                  {row.downgradedFrom && <div data-testid="import-row-downgraded" className="text-sky-700">Downgraded from {row.downgradedFrom}</div>}
                                  {row.warnings.map((warning) => <div key={warning} data-testid="import-row-warning" className="text-sky-700">{warning}</div>)}

                                  {action === 'update' && row.diff && (
                                    <table className="mt-2 w-full border-collapse text-xs">
                                      <tbody>
                                        {row.diff.filter((d) => d.kind !== 'preserved').map((d) => (
                                          <tr key={d.field} className="border-t border-[#ffcad4]">
                                            <td className="py-1 pr-2 text-slate-500">{IMPORT_FIELD_LABELS[d.field]}</td>
                                            <td className="py-1 pr-2">
                                              {d.kind === 'unchanged' && <span className="text-slate-400">unchanged ({d.previousValue ?? '—'})</span>}
                                              {d.kind === 'changed' && <span className="text-emerald-700">{d.previousValue ?? '—'} → {d.newValue ?? '—'}</span>}
                                              {d.kind === 'clear' && (
                                                <label className="flex items-center gap-1 text-rose-700">
                                                  <input
                                                    type="checkbox"
                                                    checked={importConfirmedClears[row.rowNumber]?.has(d.field) ?? false}
                                                    onChange={() => toggleConfirmedClear(row.rowNumber, d.field)}
                                                  />
                                                  Clear &ldquo;{d.previousValue}&rdquo;? (destructive — requires confirmation)
                                                </label>
                                              )}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}

                                  {action === 'update' && row.effects && row.effects.length > 0 && (
                                    <div className="mt-2 space-y-1" data-testid="import-row-effects">
                                      <p className="text-slate-500">Related records:</p>
                                      {row.effects.map((effect, index) => (
                                        <div
                                          key={`${effect.record}-${index}`}
                                          data-testid="import-row-effect"
                                          className={
                                            effect.kind === 'create' ? 'text-emerald-700'
                                              : effect.kind === 'update' || effect.kind === 'change' ? 'text-sky-700'
                                                : 'text-slate-400'
                                          }
                                        >
                                          {effect.description}
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  {resumeNameSupplied && !row.resumeMatch && (
                                    <div className="mt-2">
                                      <select
                                        data-testid="import-resume-decision"
                                        value={importResumeDecisions[row.rowNumber]?.action ?? 'blank'}
                                        onChange={(e) => {
                                          const value = e.target.value;
                                          setImportResumeDecisions((prev) => ({
                                            ...prev,
                                            [row.rowNumber]: value === 'create'
                                              ? { action: 'create', name: resumeNameSupplied, targetType: 'SWE' }
                                              : { action: 'blank' },
                                          }));
                                        }}
                                        className="rounded-lg border border-[#ffc4d6] bg-white p-1 text-xs outline-none focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]"
                                      >
                                        <option value="blank">Leave resume blank</option>
                                        <option value="create">Create new resume &ldquo;{resumeNameSupplied}&rdquo;</option>
                                      </select>
                                    </div>
                                  )}
                                </td>
                                <td className="px-2 py-2">
                                  {row.status === 'valid' ? (
                                    <select
                                      value={action}
                                      onChange={(e) => setImportRowActions((prev) => ({ ...prev, [row.rowNumber]: e.target.value as ImportRowDecision }))}
                                      className="rounded-lg border border-[#ffc4d6] bg-white p-1.5 text-sm outline-none focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]"
                                    >
                                      {row.duplicate ? (
                                        <>
                                          <option value="skip">Skip</option>
                                          {row.duplicate.source === 'database' && <option value="update">Update existing</option>}
                                          <option value="importAnyway">Import anyway</option>
                                        </>
                                      ) : (
                                        <option value="create">Create</option>
                                      )}
                                    </select>
                                  ) : (
                                    <span className="text-xs text-slate-400">Cannot import</span>
                                  )}
                                </td>
                              </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <div className="rounded-lg border border-[#ffcad4] bg-[#fadde1]/40 p-3 text-sm">
                        <label className="flex items-center gap-2 font-medium text-slate-700">
                          <input type="radio" name="commit-mode" checked={importCommitMode === 'per-row'} onChange={() => setImportCommitMode('per-row')} />
                          Per-row (recommended)
                        </label>
                        <p className="ml-6 text-xs text-slate-500">Each row is written in its own transaction — a failure on one row is reported but does not affect any other row.</p>
                        <label className="mt-2 flex items-center gap-2 font-medium text-slate-700">
                          <input type="radio" name="commit-mode" checked={importCommitMode === 'batch'} onChange={() => setImportCommitMode('batch')} />
                          Entire batch (all-or-nothing)
                        </label>
                        <p className="ml-6 text-xs text-slate-500">Every row is written in a single transaction — if any row fails, the whole import is rolled back and nothing is written.</p>
                      </div>

                      <div className="flex justify-end gap-2">
                        <button onClick={resetImportWizard} className="rounded-lg border border-[#ffc4d6] bg-white px-4 py-2 text-slate-600 transition hover:border-[#ffacc5] hover:bg-[#fadde1]">Cancel</button>
                        <button
                          onClick={confirmImport}
                          disabled={importLoading || importPreview.summary.valid === 0}
                          className="rounded-lg bg-[#ff87ab] px-4 py-2 text-sm font-medium text-slate-900 shadow-sm transition hover:bg-[#ff5d8f] disabled:opacity-50"
                        >
                          Confirm Import
                        </button>
                      </div>
                    </div>
                  )}

                  {importResult && (
                    <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                      <h3 className="text-lg font-semibold">
                        Import result ({importResult.mode === 'batch' ? 'entire batch — all-or-nothing' : 'per-row — independent transactions'})
                      </h3>
                      {importResult.backup && (
                        <div className="mt-1 rounded-lg border border-[#ffcad4] bg-[#fadde1]/30 p-2 text-xs text-slate-600" data-testid="import-backup-path">
                          <p>
                            Database backed up to <code>{importResult.backup.fileName}</code> (in <code>data/backups/</code>) before any writes.
                          </p>
                          <p className="mt-1">
                            To restore: stop the app, copy <code>data/backups/{importResult.backup.fileName}</code> over <code>data/dev.db</code>, then restart. Or use the &ldquo;Restore from raw backup file&rdquo; control below.
                          </p>
                        </div>
                      )}
                      <p className="mt-2 text-sm text-slate-600">
                        {importResult.created} created • {importResult.updated} updated • {importResult.skipped} skipped
                        {importResult.errors.length > 0 && ` • ${importResult.errors.length} failed`}
                      </p>
                      {importResult.errors.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {importResult.errors.map((rowError) => (
                            <div key={rowError.rowNumber} data-testid="import-row-error" className="rounded-lg border border-rose-100 bg-rose-50 p-2 text-xs text-rose-700">
                              Row {rowError.rowNumber}: {rowError.errors.join('; ')}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {activeSection === 'settings' && profile && (
                <div className="rounded-xl border border-[#ffcad4] bg-white p-6 shadow-sm">
                  <h3 className="text-lg font-semibold">Profile and settings</h3>
                  <form onSubmit={saveProfile} className="mt-4 grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="profile-name">Name</label>
                      <input id="profile-name" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} placeholder="Name" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="profile-school">School</label>
                      <input id="profile-school" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={profile.school} onChange={(e) => setProfile({ ...profile, school: e.target.value })} placeholder="School" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="profile-major">Major</label>
                      <input id="profile-major" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={profile.major} onChange={(e) => setProfile({ ...profile, major: e.target.value })} placeholder="Major" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="profile-graduation">Graduation</label>
                      <input id="profile-graduation" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={profile.graduation} onChange={(e) => setProfile({ ...profile, graduation: e.target.value })} placeholder="Graduation" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="profile-preferred-location">Preferred location</label>
                      <input id="profile-preferred-location" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={profile.preferredLocation} onChange={(e) => setProfile({ ...profile, preferredLocation: e.target.value })} placeholder="Preferred location" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="profile-current-experience">Current experience</label>
                      <input id="profile-current-experience" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={profile.currentExperience} onChange={(e) => setProfile({ ...profile, currentExperience: e.target.value })} placeholder="Current experience" />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="profile-target-categories">Target categories</label>
                      <textarea id="profile-target-categories" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={3} value={profile.targetCategories} onChange={(e) => setProfile({ ...profile, targetCategories: e.target.value })} placeholder="Target categories" />
                    </div>
                    <button className="md:col-span-2 rounded-lg bg-[#ff87ab] px-4 py-2 text-sm font-medium text-slate-900 shadow-sm transition hover:bg-[#ff5d8f]" type="submit">Save settings</button>
                  </form>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {showNewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-[#ffcad4] bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold text-slate-900">New Opportunity</h3>
              <button onClick={() => setShowNewModal(false)} className="grid h-8 w-8 place-items-center rounded-full text-slate-400 transition hover:bg-[#fadde1] hover:text-[#ff97b7]">✕</button>
            </div>
            <form onSubmit={createApp} className="mt-4 space-y-3">
              <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="company">Company</label>
              <input id="company" required className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Company" value={newForm.company} onChange={(e) => setNewForm({ ...newForm, company: e.target.value })} />
              <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="role">Role</label>
              <input id="role" required className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Role" value={newForm.role} onChange={(e) => setNewForm({ ...newForm, role: e.target.value })} />
              <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="application-url">Application URL</label>
              <input id="application-url" required className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Application URL" value={newForm.applicationUrl} onChange={(e) => setNewForm({ ...newForm, applicationUrl: e.target.value })} />
              <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="priority">Priority</label>
              <select id="priority" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={newForm.priority} onChange={(e) => setNewForm({ ...newForm, priority: e.target.value })}>
                <option value="P0">P0 — Dream</option><option value="P1">P1 — High</option><option value="P2">P2 — Strong</option><option value="P3">P3 — Backup</option>
              </select>
              <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="status">Status</label>
              <select id="status" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={newForm.status} onChange={(e) => setNewForm({ ...newForm, status: e.target.value })}>
                <option value="Not Applied">Not Applied</option><option value="Preparing">Preparing</option>
              </select>
              <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="location">Location</label>
              <input id="location" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Location" value={newForm.location} onChange={(e) => setNewForm({ ...newForm, location: e.target.value })} />
              <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="notes">Notes</label>
              <textarea id="notes" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Notes" rows={3} value={newForm.notes} onChange={(e) => setNewForm({ ...newForm, notes: e.target.value })} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowNewModal(false)} className="rounded-lg border border-[#ffc4d6] bg-white px-4 py-2 text-slate-600 transition hover:border-[#ffacc5] hover:bg-[#fadde1]">Cancel</button>
                <button type="submit" className="rounded-lg bg-[#ff87ab] px-4 py-2 text-slate-900 shadow-sm transition hover:bg-[#ff5d8f]">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showQuickModal && selectedApp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-[#ffcad4] bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold text-slate-900">{quickActionTitles[quickAction]}</h3>
              <button onClick={() => setShowQuickModal(false)} className="grid h-8 w-8 place-items-center rounded-full text-slate-400 transition hover:bg-[#fadde1] hover:text-[#ff97b7]">✕</button>
            </div>
            <form onSubmit={runQuickAction} className="mt-4 space-y-3">
              {quickAction === 'apply' && (
                <>
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="date-applied">Date applied</label>
                  <input id="date-applied" type="date" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.dateApplied ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, dateApplied: e.target.value }))} />
                  <FieldError errors={quickErrors} name="dateApplied" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="resume-version">Resume version</label>
                  <select id="resume-version" required className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.resumeVersionId ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, resumeVersionId: e.target.value }))}>
                    <option value="">Select a resume version</option>
                    {resumes.map((resume) => (
                      <option key={resume.id} value={resume.id}>{resume.name}</option>
                    ))}
                  </select>
                  <FieldError errors={quickErrors} name="resumeVersionId" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="email-used">Email used</label>
                  <input id="email-used" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Email used" value={quickForm.emailUsed ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, emailUsed: e.target.value }))} />
                  <FieldError errors={quickErrors} name="emailUsed" />
                </>
              )}
              {quickAction === 'oaReceived' && (
                <>
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="received-at">Received at</label>
                  <input id="received-at" type="datetime-local" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.receivedAt ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, receivedAt: e.target.value }))} />
                  <FieldError errors={quickErrors} name="receivedAt" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="oa-due-at">Due at</label>
                  <input id="oa-due-at" required type="datetime-local" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.dueAt ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, dueAt: e.target.value }))} />
                  <FieldError errors={quickErrors} name="dueAt" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="oa-timezone">Time zone</label>
                  <select id="oa-timezone" required className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.timezone ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, timezone: e.target.value }))}>
                    <option value="">Select a time zone</option>
                    {IANA_TIME_ZONES.map((zone) => (
                      <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                  <FieldError errors={quickErrors} name="timezone" />
                  <p className="text-xs text-slate-500">Received at/due at above are interpreted in this time zone — not your device&apos;s time zone.</p>
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="oa-platform">Platform</label>
                  <input id="oa-platform" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Platform" value={quickForm.platform ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, platform: e.target.value }))} />
                  <FieldError errors={quickErrors} name="platform" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="oa-notes">Notes</label>
                  <textarea id="oa-notes" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={3} placeholder="Notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="notes" />
                </>
              )}
              {quickAction === 'interviewReceived' && (
                <>
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="interview-stage">Interview stage</label>
                  <select id="interview-stage" required className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.stage ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, stage: e.target.value }))}>
                    <option value="">Select a stage</option>
                    <option value="Recruiter Screen">Recruiter Screen</option>
                    <option value="Technical Interview">Technical Interview</option>
                    <option value="Final Round">Final Round</option>
                  </select>
                  <FieldError errors={quickErrors} name="stage" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="scheduled-start">Scheduled start</label>
                  <input id="scheduled-start" required type="datetime-local" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.scheduledStart ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, scheduledStart: e.target.value }))} />
                  <FieldError errors={quickErrors} name="scheduledStart" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="scheduled-end">Scheduled end</label>
                  <input id="scheduled-end" type="datetime-local" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.scheduledEnd ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, scheduledEnd: e.target.value }))} />
                  <FieldError errors={quickErrors} name="scheduledEnd" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="duration-minutes">Duration minutes</label>
                  <input id="duration-minutes" type="number" min="1" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.durationMinutes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, durationMinutes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="durationMinutes" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="interview-timezone">Time zone</label>
                  <select id="interview-timezone" required className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.timezone ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, timezone: e.target.value }))}>
                    <option value="">Select a time zone</option>
                    {IANA_TIME_ZONES.map((zone) => (
                      <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                  <FieldError errors={quickErrors} name="timezone" />
                  <p className="text-xs text-slate-500">Scheduled start/end above are interpreted in this time zone — not your device&apos;s time zone.</p>
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="interview-format">Format</label>
                  <input id="interview-format" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Format" value={quickForm.format ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, format: e.target.value }))} />
                  <FieldError errors={quickErrors} name="format" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="interview-location">Location</label>
                  <input id="interview-location" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Location" value={quickForm.location ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, location: e.target.value }))} />
                  <FieldError errors={quickErrors} name="location" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="meeting-url">Meeting URL</label>
                  <input id="meeting-url" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Meeting URL" value={quickForm.meetingUrl ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, meetingUrl: e.target.value }))} />
                  <FieldError errors={quickErrors} name="meetingUrl" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="recruiter">Recruiter</label>
                  <input id="recruiter" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Recruiter" value={quickForm.recruiter ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, recruiter: e.target.value }))} />
                  <FieldError errors={quickErrors} name="recruiter" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="interviewer">Interviewer</label>
                  <input id="interviewer" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Interviewer" value={quickForm.interviewer ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, interviewer: e.target.value }))} />
                  <FieldError errors={quickErrors} name="interviewer" />
                </>
              )}
              {quickAction === 'reject' && (
                <>
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="rejection-reason">Rejection reason</label>
                  <input id="rejection-reason" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Rejection reason" value={quickForm.rejectionReason ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, rejectionReason: e.target.value }))} />
                  <FieldError errors={quickErrors} name="rejectionReason" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="rejection-notes">Rejection notes</label>
                  <textarea id="rejection-notes" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={3} placeholder="Rejection notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="notes" />
                </>
              )}
              {quickAction === 'offer' && (
                <>
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="offer-date">Offer date</label>
                  <input id="offer-date" type="date" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.offerDate ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, offerDate: e.target.value }))} />
                  <FieldError errors={quickErrors} name="offerDate" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="decision-deadline">Decision deadline</label>
                  <input id="decision-deadline" required type="date" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.decisionDeadline ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, decisionDeadline: e.target.value }))} />
                  <FieldError errors={quickErrors} name="decisionDeadline" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="compensation-summary">Compensation</label>
                  <input id="compensation-summary" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Compensation" value={quickForm.compensationSummary ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, compensationSummary: e.target.value }))} />
                  <FieldError errors={quickErrors} name="compensationSummary" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="offer-notes">Notes</label>
                  <textarea id="offer-notes" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={3} placeholder="Notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="notes" />
                </>
              )}
              {quickAction === 'oaCompleted' && (
                <>
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="assessment-id">Assessment</label>
                  <select id="assessment-id" required className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.assessmentId ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, assessmentId: e.target.value }))}>
                    <option value="">Select an assessment</option>
                    {selectedApp.assessments.filter((assessment) => !assessment.completedAt).map((assessment) => (
                      <option key={assessment.id} value={assessment.id}>
                        {assessment.type} • due {assessment.dueAt ? formatInZone(assessment.dueAt, assessment.timezone, 'MMM d, yyyy h:mm a zzz') : 'unknown'}
                        {assessment.dueAt && assessment.timezone && assessment.timezone !== browserTimeZone() ? ` (${formatTimestamp(assessment.dueAt, 'MMM d, h:mm a')} your time)` : ''}
                      </option>
                    ))}
                  </select>
                  <FieldError errors={quickErrors} name="assessmentId" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="oa-completed-at">Completed at</label>
                  <input id="oa-completed-at" type="datetime-local" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.completedAt ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, completedAt: e.target.value }))} />
                  <FieldError errors={quickErrors} name="completedAt" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="oa-difficulty">Difficulty</label>
                  <input id="oa-difficulty" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Difficulty" value={quickForm.difficulty ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, difficulty: e.target.value }))} />
                  <FieldError errors={quickErrors} name="difficulty" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="oa-confidence">Confidence</label>
                  <input id="oa-confidence" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Confidence" value={quickForm.confidence ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, confidence: e.target.value }))} />
                  <FieldError errors={quickErrors} name="confidence" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="oa-result">Result</label>
                  <input id="oa-result" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Result" value={quickForm.result ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, result: e.target.value }))} />
                  <FieldError errors={quickErrors} name="result" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="encountered-questions">Encountered questions</label>
                  <textarea id="encountered-questions" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={3} placeholder="Encountered questions" value={quickForm.encounteredQuestions ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, encounteredQuestions: e.target.value }))} />
                  <FieldError errors={quickErrors} name="encounteredQuestions" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="oa-topics">Topics</label>
                  <textarea id="oa-topics" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={3} placeholder="Topics" value={quickForm.topics ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, topics: e.target.value }))} />
                  <FieldError errors={quickErrors} name="topics" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="oa-completed-notes">Notes</label>
                  <textarea id="oa-completed-notes" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={3} placeholder="Notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="notes" />
                </>
              )}
              {quickAction === 'interviewCompleted' && (
                <>
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="interview-id">Interview</label>
                  <select id="interview-id" required className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.interviewId ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, interviewId: e.target.value }))}>
                    <option value="">Select an interview</option>
                    {selectedApp.interviews.filter((interview) => !interview.completedAt).map((interview) => (
                      <option key={interview.id} value={interview.id}>
                        {interview.stage} • {interview.scheduledStart ? formatInZone(interview.scheduledStart, interview.timezone) : 'unscheduled'}
                      </option>
                    ))}
                  </select>
                  <FieldError errors={quickErrors} name="interviewId" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="interview-completed-at">Completed at</label>
                  <input id="interview-completed-at" type="datetime-local" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.completedAt ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, completedAt: e.target.value }))} />
                  <FieldError errors={quickErrors} name="completedAt" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="interview-result">Result</label>
                  <input id="interview-result" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Result" value={quickForm.result ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, result: e.target.value }))} />
                  <FieldError errors={quickErrors} name="result" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="interview-questions">Questions</label>
                  <textarea id="interview-questions" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={3} placeholder="Questions" value={quickForm.questions ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, questions: e.target.value }))} />
                  <FieldError errors={quickErrors} name="questions" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="what-went-well">What went well</label>
                  <textarea id="what-went-well" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={3} placeholder="What went well" value={quickForm.whatWentWell ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, whatWentWell: e.target.value }))} />
                  <FieldError errors={quickErrors} name="whatWentWell" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="improvements">Improvements</label>
                  <textarea id="improvements" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={3} placeholder="Improvements" value={quickForm.improvements ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, improvements: e.target.value }))} />
                  <FieldError errors={quickErrors} name="improvements" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="interview-follow-up">Follow-up date</label>
                  <input id="interview-follow-up" type="date" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.followUpDate ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, followUpDate: e.target.value }))} />
                  <FieldError errors={quickErrors} name="followUpDate" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="interview-completed-notes">Notes</label>
                  <textarea id="interview-completed-notes" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={3} placeholder="Notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="notes" />
                </>
              )}
              {quickAction === 'note' && (
                <>
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="note-content">Note</label>
                  <textarea id="note-content" required className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={4} placeholder="Add a note" value={quickForm.content ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, content: e.target.value }))} />
                  <FieldError errors={quickErrors} name="content" />
                </>
              )}
              {quickAction === 'setApplicationDate' && (
                <>
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="repair-date-applied">Application date</label>
                  <input id="repair-date-applied" required type="date" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.dateApplied ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, dateApplied: e.target.value }))} />
                  <FieldError errors={quickErrors} name="dateApplied" />
                  <p className="text-xs text-slate-500">Records this as a repair to the application history rather than a new submission.</p>
                </>
              )}
              {quickAction === 'contact' && (
                <>
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="contact-name">Name</label>
                  <input id="contact-name" required className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Name" value={quickForm.name ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, name: e.target.value }))} />
                  <FieldError errors={quickErrors} name="name" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="contact-title">Title</label>
                  <input id="contact-title" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Title" value={quickForm.title ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, title: e.target.value }))} />
                  <FieldError errors={quickErrors} name="title" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="contact-email">Email</label>
                  <input id="contact-email" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Email" value={quickForm.email ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, email: e.target.value }))} />
                  <FieldError errors={quickErrors} name="email" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="contact-relationship">Relationship</label>
                  <input id="contact-relationship" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Relationship" value={quickForm.relationship ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, relationship: e.target.value }))} />
                  <FieldError errors={quickErrors} name="relationship" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="contact-referral-status">Referral status</label>
                  <input id="contact-referral-status" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Referral status" value={quickForm.referralStatus ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, referralStatus: e.target.value }))} />
                  <FieldError errors={quickErrors} name="referralStatus" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="contact-next-follow-up">Next follow-up date</label>
                  <input id="contact-next-follow-up" type="date" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" value={quickForm.nextFollowUp ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, nextFollowUp: e.target.value }))} />
                  <FieldError errors={quickErrors} name="nextFollowUp" />
                  <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="contact-notes">Notes</label>
                  <textarea id="contact-notes" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={3} placeholder="Notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="notes" />
                </>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowQuickModal(false)} className="rounded-lg border border-[#ffc4d6] bg-white px-4 py-2 text-slate-600 transition hover:border-[#ffacc5] hover:bg-[#fadde1]">Cancel</button>
                <button type="submit" className="rounded-lg bg-[#ff87ab] px-4 py-2 text-slate-900 shadow-sm transition hover:bg-[#ff5d8f]">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showResumeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-[#ffcad4] bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold text-slate-900">Create Resume</h3>
              <button onClick={() => setShowResumeModal(false)} className="grid h-8 w-8 place-items-center rounded-full text-slate-400 transition hover:bg-[#fadde1] hover:text-[#ff97b7]">✕</button>
            </div>
            <form onSubmit={createResume} className="mt-4 space-y-3">
              <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="resume-name">Resume name</label>
              <input id="resume-name" required className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Resume name" value={resumeForm.name} onChange={(e) => setResumeForm({ ...resumeForm, name: e.target.value })} />
              {resumeErrors.name && <p className="text-sm text-rose-600">{resumeErrors.name[0]}</p>}

              <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="resume-target-type">Target type</label>
              <input id="resume-target-type" required className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="Target role" value={resumeForm.targetType} onChange={(e) => setResumeForm({ ...resumeForm, targetType: e.target.value })} />
              {resumeErrors.targetType && <p className="text-sm text-rose-600">{resumeErrors.targetType[0]}</p>}

              <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="resume-file-name">File name</label>
              <input id="resume-file-name" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" placeholder="File name" value={resumeForm.fileName} onChange={(e) => setResumeForm({ ...resumeForm, fileName: e.target.value })} />
              {resumeErrors.fileName && <p className="text-sm text-rose-600">{resumeErrors.fileName[0]}</p>}

              <label className="block text-sm font-medium text-[#ff5d8f]/80" htmlFor="resume-description">Description</label>
              <textarea id="resume-description" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]" rows={3} placeholder="Description" value={resumeForm.description} onChange={(e) => setResumeForm({ ...resumeForm, description: e.target.value })} />
              {resumeErrors.description && <p className="text-sm text-rose-600">{resumeErrors.description[0]}</p>}

              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowResumeModal(false)} className="rounded-lg border border-[#ffc4d6] bg-white px-4 py-2 text-slate-600 transition hover:border-[#ffacc5] hover:bg-[#fadde1]">Cancel</button>
                <button type="submit" className="rounded-lg bg-[#ff87ab] px-4 py-2 text-slate-900 shadow-sm transition hover:bg-[#ff5d8f]">Save resume</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
