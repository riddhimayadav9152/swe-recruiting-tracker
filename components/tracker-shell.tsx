'use client';

import { useEffect, useMemo, useState } from 'react';
import { format, formatDistanceToNow, isBefore, subDays } from 'date-fns';
import { Activity, BriefcaseBusiness, CalendarDays, ChevronRight, Download, FileText, FolderOpen, LayoutGrid, PlusCircle, Search, Settings, Upload, Users, FileStack, Pencil, MessageSquareText, BookOpen, AlertTriangle } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { generateNextAction, validateApplicationInput } from '@/lib/recruiting';

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
  applicationDeadline: string | null;
  dateFound: string | null;
  dateApplied: string | null;
  notes: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  jobDescription: { fullText: string | null } | null;
  resumeVersion: { id: string; name: string } | null;
  interviews: Array<{ id: string; stage: string; scheduledStart: string | null; completedAt: string | null; notes: string | null }>;
  assessments: Array<{ id: string; type: string; dueAt: string | null; completedAt: string | null; result: string | null }>;
  contacts: Array<{ name: string; email: string | null; notes: string | null }>;
  activities: Array<{ eventType: string; summary: string; createdAt: string }>;
  offers: { offerDate: string | null; decisionDeadline: string | null; compensationSummary: string | null; notes: string | null } | null;
};

type ResumeRecord = { id:string; name:string; targetType:string; fileName:string | null; description:string | null; applications: Array<{ id:string }> };

type ProfileRecord = { id:string; name:string; school:string; major:string; graduation:string; preferredLocation:string; currentExperience:string; targetRoles:string; targetCategories:string };

type QuickAction = 'apply' | 'oaReceived' | 'oaCompleted' | 'interviewReceived' | 'interviewCompleted' | 'reject' | 'offer' | 'note' | 'contact';

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
};

const terminalStatuses = ['Offer', 'Accepted', 'Rejected', 'Withdrawn', 'Closed'];

const FieldError = ({ errors, name }: { errors: Record<string, string[] | undefined>; name: string }) => {
  const message = errors[name]?.[0];
  return message ? <p className="text-sm text-red-600">{message}</p> : null;
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
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
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
      if (!selectedAppId && appsData[0]) setSelectedAppId(appsData[0].id);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const saved = window.localStorage.getItem('tracker-section');
    if (saved) setActiveSection(saved);
    loadData();
  }, []);

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
    const overdue = applications.filter((app) => app.nextActionDue && isBefore(new Date(app.nextActionDue), new Date())).length;
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

  const deadlines = useMemo(() => applications
    .filter((app) => app.nextActionDue || app.applicationDeadline)
    .map((app) => ({
      id: app.id,
      label: app.nextActionDue ? `Next action • ${app.nextAction}` : `Deadline • ${app.company}`,
      dueDate: app.nextActionDue ?? app.applicationDeadline ?? null,
      company: app.company,
      role: app.role,
    }))
    .sort((a, b) => (a.dueDate && b.dueDate ? new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime() : 0))
    .slice(0, 8), [applications]);

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
    const payload = { action: quickAction, ...quickForm };
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

  const openQuickAction = (action: QuickAction, initialForm: Record<string, string> = {}) => {
    setQuickErrors({});
    setQuickAction(action);
    setQuickForm(initialForm);
    setShowQuickModal(true);
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

  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch('/api/import', { method: 'POST', body: formData });
    const data = await response.json();
    if (response.ok) {
      toast.success(`Imported ${data.imported} rows`);
      loadData();
    } else {
      toast.error('Import failed');
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
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="flex min-h-screen flex-col lg:flex-row">
        <aside className="w-full lg:w-72 border-b lg:border-b-0 lg:border-r border-slate-200 bg-white/80 p-6 backdrop-blur">
          <div className="mb-6">
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Local SWE Tracker</p>
            <h1 className="mt-2 text-xl font-semibold">Riddhima&apos;s Recruiting Command Center</h1>
          </div>
          <button onClick={() => setShowNewModal(true)} className="mb-6 flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white">
            <PlusCircle size={18} /> New Opportunity
          </button>
          <nav className="space-y-1">
            {sections.map((section) => {
              const Icon = section.icon;
              return (
                <button key={section.key} onClick={() => setActiveSection(section.key)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${activeSection === section.key ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}>
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
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
              <Search size={16} />
              <label htmlFor="application-search" className="sr-only">Search applications</label>
              <input id="application-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search applications" className="w-44 bg-transparent outline-none" />
            </div>
          </div>

          {loading ? <div className="rounded-xl border border-slate-200 bg-white p-8 text-slate-500">Loading tracker data…</div> : (
            <>
              {activeSection === 'dashboard' && (
                <div className="space-y-6">
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    {[
                      ['Total tracked opportunities', summary.total],
                      ['Not applied', summary.notApplied],
                      ['Applications submitted', summary.applied],
                      ['Active OAs', summary.oa],
                      ['Active interviews', summary.interviews],
                      ['Offers', summary.offers],
                      ['Rejections', summary.rejections],
                      ['Overdue actions', summary.overdue],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                        <p className="text-sm text-slate-500">{label}</p>
                        <p className="mt-2 text-2xl font-semibold">{value}</p>
                      </div>
                    ))}
                  </div>
                  <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
                    <div className="rounded-xl border border-slate-200 bg-white p-6">
                      <h3 className="text-lg font-semibold">Upcoming deadlines</h3>
                      <div className="mt-4 space-y-3">
                        {deadlines.map((item) => (
                          <button key={item.id} onClick={() => { setSelectedAppId(item.id); setActiveSection('applications'); }} className="flex w-full items-center justify-between rounded-lg border border-slate-200 p-3 text-left hover:border-slate-300">
                            <div>
                              <p className="font-medium">{item.company}</p>
                              <p className="text-sm text-slate-500">{item.label}</p>
                            </div>
                            <div className="text-sm text-slate-600">{item.dueDate ? format(new Date(item.dueDate), 'MMM d') : '—'}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white p-6">
                      <h3 className="text-lg font-semibold">Needs attention</h3>
                      <div className="mt-4 space-y-3">
                        {applications.filter((app) => (app.nextActionDue && isBefore(new Date(app.nextActionDue), new Date())) || !app.jobDescription || !app.resumeVersion || (app.nextActionDue && new Date(app.nextActionDue) < subDays(new Date(), 3))).slice(0, 6).map((app) => (
                          <div key={app.id} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
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
                  <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="mb-4 flex items-center justify-between">
                      <h3 className="text-lg font-semibold">Applications</h3>
                      <button onClick={() => setShowNewModal(true)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">+ New</button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 text-left text-slate-500">
                            <th className="px-3 py-2">Company</th>
                            <th className="px-3 py-2">Role</th>
                            <th className="px-3 py-2">Status</th>
                            <th className="px-3 py-2">Next action</th>
                            <th className="px-3 py-2">Due</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredApplications.map((app) => (
                            <tr key={app.id} onClick={() => setSelectedAppId(app.id)} className={`cursor-pointer border-b border-slate-100 ${selectedAppId === app.id ? 'bg-slate-100' : 'hover:bg-slate-50'}`}>
                              <td className="px-3 py-3 font-medium">{app.company}</td>
                              <td className="px-3 py-3">{app.role}</td>
                              <td className="px-3 py-3"><span className="rounded-full bg-slate-100 px-2 py-1 text-xs">{app.status}</span></td>
                              <td className="px-3 py-3">{app.nextAction}</td>
                              <td className="px-3 py-3">{app.nextActionDue ? format(new Date(app.nextActionDue), 'MMM d') : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-6">
                    {selectedApp ? (
                      <>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm text-slate-500">{selectedApp.applicationCode}</p>
                            <h3 className="text-xl font-semibold">{selectedApp.company}</h3>
                            <p className="text-sm text-slate-600">{selectedApp.role}</p>
                          </div>
                          <span className="rounded-full bg-slate-100 px-2 py-1 text-xs">{selectedApp.priority}</span>
                        </div>
                        <div className="mt-4 space-y-3 text-sm text-slate-600">
                          <div className="rounded-lg border border-slate-200 p-3">Status: <span data-testid="app-status" className="font-medium text-slate-900">{selectedApp.status}</span></div>
                          <div className="rounded-lg border border-slate-200 p-3">Stage: <span className="font-medium text-slate-900">{selectedApp.currentStage}</span></div>
                          <div className="rounded-lg border border-slate-200 p-3">Next action: <span className="font-medium text-slate-900">{selectedApp.nextAction}</span></div>
                          <div className="rounded-lg border border-slate-200 p-3">Last update: <span className="font-medium text-slate-900">{formatDistanceToNow(new Date(selectedApp.updatedAt), { addSuffix: true })}</span></div>
                          {selectedApp.offers && (
                            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                              <p className="font-medium text-emerald-900">Offer details</p>
                              <p>Offer date: <span data-testid="offer-date" className="font-medium text-slate-900">{selectedApp.offers.offerDate ? format(new Date(selectedApp.offers.offerDate), 'MMM d, yyyy') : '—'}</span></p>
                              <p>Decision deadline: <span data-testid="offer-deadline" className="font-medium text-slate-900">{selectedApp.offers.decisionDeadline ? format(new Date(selectedApp.offers.decisionDeadline), 'MMM d, yyyy') : '—'}</span></p>
                              <p>Compensation: <span data-testid="offer-compensation" className="font-medium text-slate-900">{selectedApp.offers.compensationSummary ?? '—'}</span></p>
                              <p>Notes: <span data-testid="offer-notes" className="font-medium text-slate-900">{selectedApp.offers.notes ?? '—'}</span></p>
                            </div>
                          )}
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          {!selectedApp.dateApplied && (
                            <button onClick={() => openQuickAction('apply', { resumeVersionId: selectedApp?.resumeVersion?.id ?? '' })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">Mark Applied</button>
                          )}
                          <button onClick={() => openQuickAction('oaReceived')} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">OA Received</button>
                          {selectedApp.assessments.some((assessment) => assessment.type === 'OA' && !assessment.completedAt) && (
                            <button onClick={() => openQuickAction('oaCompleted', { assessmentId: '' })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">OA Completed</button>
                          )}
                          <button onClick={() => openQuickAction('interviewReceived')} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">Interview Received</button>
                          {selectedApp.interviews.some((interview) => !interview.completedAt) && (
                            <button onClick={() => openQuickAction('interviewCompleted', { interviewId: '' })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">Interview Completed</button>
                          )}
                          <button
                            onClick={() => {
                              if (terminalStatuses.includes(selectedApp.status) && !window.confirm('This application already has a final outcome. Mark it rejected anyway?')) return;
                              openQuickAction('reject');
                            }}
                            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                          >
                            Rejected
                          </button>
                          <button
                            onClick={() => {
                              if (terminalStatuses.includes(selectedApp.status) && !window.confirm('This application already has a final outcome. Record another offer anyway?')) return;
                              openQuickAction('offer');
                            }}
                            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                          >
                            Offer Received
                          </button>
                          <button onClick={() => openQuickAction('note')} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">Add Note</button>
                          <button onClick={() => openQuickAction('contact')} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">Add Contact</button>
                        </div>
                      </>
                    ) : <div className="text-sm text-slate-500">Select an application</div>}
                  </div>
                </div>
              )}

              {activeSection === 'pipeline' && (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {['Not Applied','Preparing','Applied','OA','Recruiter Screen','Technical Interview','Final Round','Offer'].map((status) => (
                    <div key={status} className="rounded-xl border border-slate-200 bg-white p-4">
                      <h3 className="font-semibold">{status}</h3>
                      <div className="mt-3 space-y-2">
                        {applications.filter((app) => app.status === status).slice(0, 4).map((app) => (
                          <div key={app.id} className="rounded-lg border border-slate-200 p-3 text-sm">
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
                <div className="rounded-xl border border-slate-200 bg-white p-6">
                  <h3 className="text-lg font-semibold">Deadlines</h3>
                  <div className="mt-4 space-y-3">
                    {deadlines.map((item) => (
                      <div key={item.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm">
                        <div>
                          <div className="font-medium">{item.company}</div>
                          <div className="text-slate-500">{item.label}</div>
                        </div>
                        <div className="text-slate-600">{item.dueDate ? format(new Date(item.dueDate), 'MMM d, yyyy') : '—'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeSection === 'job-descriptions' && (
                <div className="grid gap-6 xl:grid-cols-[0.8fr_1.2fr]">
                  <div className="rounded-xl border border-slate-200 bg-white p-6">
                    <h3 className="text-lg font-semibold">Saved descriptions</h3>
                    <div className="mt-4 space-y-3">
                      {applications.filter((app) => app.jobDescription?.fullText).map((app) => (
                        <button key={app.id} onClick={() => setSelectedAppId(app.id)} className="w-full rounded-lg border border-slate-200 p-3 text-left text-sm">
                          <div className="font-medium">{app.company}</div>
                          <div className="text-slate-500">{app.jobDescription?.fullText?.slice(0, 90)}...</div>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-6">
                    <h3 className="text-lg font-semibold">Editor</h3>
                    {selectedApp ? (
                      <div className="mt-4 space-y-3">
                        <label className="block text-sm font-medium text-slate-700" htmlFor="jd-full-text">Full job description</label>
                        <textarea id="jd-full-text" value={quickForm.fullText ?? selectedApp.jobDescription?.fullText ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, fullText: e.target.value }))} rows={10} className="w-full rounded-lg border border-slate-300 p-3" placeholder="Paste the full job description" />
                        <label className="block text-sm font-medium text-slate-700" htmlFor="jd-min-quals">Minimum qualifications</label>
                        <textarea id="jd-min-quals" value={quickForm.minimumQualifications ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, minimumQualifications: e.target.value }))} rows={4} className="w-full rounded-lg border border-slate-300 p-3" placeholder="Minimum qualifications" />
                        <label className="block text-sm font-medium text-slate-700" htmlFor="jd-preferred-quals">Preferred qualifications</label>
                        <textarea id="jd-preferred-quals" value={quickForm.preferredQualifications ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, preferredQualifications: e.target.value }))} rows={4} className="w-full rounded-lg border border-slate-300 p-3" placeholder="Preferred qualifications" />
                        <button onClick={saveJobDescription} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white">Save description</button>
                      </div>
                    ) : <div className="text-sm text-slate-500">Select an application</div>}
                  </div>
                </div>
              )}

              {activeSection === 'interviews' && (
                <div className="rounded-xl border border-slate-200 bg-white p-6">
                  <h3 className="text-lg font-semibold">Interviews</h3>
                  <div className="mt-4 space-y-3">
                    {applications.flatMap((app) => app.interviews.map((interview) => ({ ...interview, company: app.company, role: app.role, appId: app.id }))).map((interview) => (
                      <div key={`${interview.appId}-${interview.stage}`} className="rounded-lg border border-slate-200 p-3 text-sm">
                        <div className="font-medium">{interview.company} • {interview.role}</div>
                        <div className="text-slate-500">{interview.stage}</div>
                        <div className="text-slate-500">{interview.notes}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeSection === 'contacts' && (
                <div className="rounded-xl border border-slate-200 bg-white p-6">
                  <h3 className="text-lg font-semibold">Contacts</h3>
                  <div className="mt-4 space-y-3">
                    {applications.flatMap((app) => app.contacts.map((contact) => ({ ...contact, company: app.company, appId: app.id }))).map((contact) => (
                      <div key={`${contact.appId}-${contact.name}`} className="rounded-lg border border-slate-200 p-3 text-sm">
                        <div className="font-medium">{contact.name}</div>
                        <div className="text-slate-500">{contact.email}</div>
                        <div className="text-slate-500">{contact.notes}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeSection === 'resumes' && (
                <div className="rounded-xl border border-slate-200 bg-white p-6">
                  <h3 className="text-lg font-semibold">Resume versions</h3>
                  <div className="mt-4 space-y-3">
                    <button onClick={() => { setResumeErrors({}); setShowResumeModal(true); }} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white">Create Resume</button>
                    {resumes.map((resume) => (
                      <div key={resume.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                        <div className="font-medium">{resume.name}</div>
                        <div className="text-slate-500">{resume.targetType} • {resume.fileName}</div>
                        <div className="text-slate-500">Used by {resume.applications.length} application(s)</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeSection === 'activity' && (
                <div className="rounded-xl border border-slate-200 bg-white p-6">
                  <h3 className="text-lg font-semibold">Activity history</h3>
                  <div className="mt-4 space-y-3">
                    {applications.flatMap((app) => app.activities.map((activity) => ({ ...activity, company: app.company }))).sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map((activity) => (
                      <div key={`${activity.company}-${activity.createdAt}`} className="rounded-lg border border-slate-200 p-3 text-sm">
                        <div className="font-medium">{activity.company}</div>
                        <div className="text-slate-500">{activity.eventType}</div>
                        <div className="text-slate-500">{activity.summary}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeSection === 'import-export' && (
                <div className="grid gap-6 xl:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-white p-6">
                    <h3 className="text-lg font-semibold">Export</h3>
                    <div className="mt-4 space-y-3">
                      <button onClick={exportWorkbook} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white">Export Excel workbook</button>
                      <button onClick={backupDatabase} className="rounded-lg border border-slate-200 px-4 py-2 text-sm">Download SQLite backup</button>
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-6">
                    <h3 className="text-lg font-semibold">Import</h3>
                    <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="import-file">Tracker workbook file</label>
                    <input id="import-file" type="file" accept=".xlsx,.xls" onChange={importFile} className="mt-2 block w-full text-sm" />
                    <p className="mt-3 text-sm text-slate-500">Upload an existing tracker workbook to import applications.</p>
                  </div>
                </div>
              )}

              {activeSection === 'settings' && profile && (
                <div className="rounded-xl border border-slate-200 bg-white p-6">
                  <h3 className="text-lg font-semibold">Profile and settings</h3>
                  <form onSubmit={saveProfile} className="mt-4 grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="block text-sm font-medium text-slate-700" htmlFor="profile-name">Name</label>
                      <input id="profile-name" className="w-full rounded-lg border border-slate-300 p-3" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} placeholder="Name" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700" htmlFor="profile-school">School</label>
                      <input id="profile-school" className="w-full rounded-lg border border-slate-300 p-3" value={profile.school} onChange={(e) => setProfile({ ...profile, school: e.target.value })} placeholder="School" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700" htmlFor="profile-major">Major</label>
                      <input id="profile-major" className="w-full rounded-lg border border-slate-300 p-3" value={profile.major} onChange={(e) => setProfile({ ...profile, major: e.target.value })} placeholder="Major" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700" htmlFor="profile-graduation">Graduation</label>
                      <input id="profile-graduation" className="w-full rounded-lg border border-slate-300 p-3" value={profile.graduation} onChange={(e) => setProfile({ ...profile, graduation: e.target.value })} placeholder="Graduation" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700" htmlFor="profile-preferred-location">Preferred location</label>
                      <input id="profile-preferred-location" className="w-full rounded-lg border border-slate-300 p-3" value={profile.preferredLocation} onChange={(e) => setProfile({ ...profile, preferredLocation: e.target.value })} placeholder="Preferred location" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700" htmlFor="profile-current-experience">Current experience</label>
                      <input id="profile-current-experience" className="w-full rounded-lg border border-slate-300 p-3" value={profile.currentExperience} onChange={(e) => setProfile({ ...profile, currentExperience: e.target.value })} placeholder="Current experience" />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-medium text-slate-700" htmlFor="profile-target-categories">Target categories</label>
                      <textarea id="profile-target-categories" className="w-full rounded-lg border border-slate-300 p-3" rows={3} value={profile.targetCategories} onChange={(e) => setProfile({ ...profile, targetCategories: e.target.value })} placeholder="Target categories" />
                    </div>
                    <button className="md:col-span-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white" type="submit">Save settings</button>
                  </form>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {showNewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">New Opportunity</h3>
              <button onClick={() => setShowNewModal(false)}>✕</button>
            </div>
            <form onSubmit={createApp} className="mt-4 space-y-3">
              <label className="block text-sm font-medium text-slate-700" htmlFor="company">Company</label>
              <input id="company" required className="w-full rounded-lg border border-slate-300 p-3" placeholder="Company" value={newForm.company} onChange={(e) => setNewForm({ ...newForm, company: e.target.value })} />
              <label className="block text-sm font-medium text-slate-700" htmlFor="role">Role</label>
              <input id="role" required className="w-full rounded-lg border border-slate-300 p-3" placeholder="Role" value={newForm.role} onChange={(e) => setNewForm({ ...newForm, role: e.target.value })} />
              <label className="block text-sm font-medium text-slate-700" htmlFor="application-url">Application URL</label>
              <input id="application-url" required className="w-full rounded-lg border border-slate-300 p-3" placeholder="Application URL" value={newForm.applicationUrl} onChange={(e) => setNewForm({ ...newForm, applicationUrl: e.target.value })} />
              <label className="block text-sm font-medium text-slate-700" htmlFor="priority">Priority</label>
              <select id="priority" className="w-full rounded-lg border border-slate-300 p-3" value={newForm.priority} onChange={(e) => setNewForm({ ...newForm, priority: e.target.value })}>
                <option value="P0">P0 — Dream</option><option value="P1">P1 — High</option><option value="P2">P2 — Strong</option><option value="P3">P3 — Backup</option>
              </select>
              <label className="block text-sm font-medium text-slate-700" htmlFor="status">Status</label>
              <select id="status" className="w-full rounded-lg border border-slate-300 p-3" value={newForm.status} onChange={(e) => setNewForm({ ...newForm, status: e.target.value })}>
                <option value="Not Applied">Not Applied</option><option value="Preparing">Preparing</option>
              </select>
              <label className="block text-sm font-medium text-slate-700" htmlFor="location">Location</label>
              <input id="location" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Location" value={newForm.location} onChange={(e) => setNewForm({ ...newForm, location: e.target.value })} />
              <label className="block text-sm font-medium text-slate-700" htmlFor="notes">Notes</label>
              <textarea id="notes" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Notes" rows={3} value={newForm.notes} onChange={(e) => setNewForm({ ...newForm, notes: e.target.value })} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowNewModal(false)} className="rounded-lg border border-slate-200 px-4 py-2">Cancel</button>
                <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-white">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showQuickModal && selectedApp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">{quickActionTitles[quickAction]}</h3>
              <button onClick={() => setShowQuickModal(false)}>✕</button>
            </div>
            <form onSubmit={runQuickAction} className="mt-4 space-y-3">
              {quickAction === 'apply' && (
                <>
                  <label className="block text-sm font-medium text-slate-700" htmlFor="date-applied">Date applied</label>
                  <input id="date-applied" type="date" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.dateApplied ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, dateApplied: e.target.value }))} />
                  <FieldError errors={quickErrors} name="dateApplied" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="resume-version">Resume version</label>
                  <select id="resume-version" required className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.resumeVersionId ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, resumeVersionId: e.target.value }))}>
                    <option value="">Select a resume version</option>
                    {resumes.map((resume) => (
                      <option key={resume.id} value={resume.id}>{resume.name}</option>
                    ))}
                  </select>
                  <FieldError errors={quickErrors} name="resumeVersionId" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="email-used">Email used</label>
                  <input id="email-used" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Email used" value={quickForm.emailUsed ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, emailUsed: e.target.value }))} />
                  <FieldError errors={quickErrors} name="emailUsed" />
                </>
              )}
              {quickAction === 'oaReceived' && (
                <>
                  <label className="block text-sm font-medium text-slate-700" htmlFor="received-at">Received at</label>
                  <input id="received-at" type="datetime-local" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.receivedAt ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, receivedAt: e.target.value }))} />
                  <FieldError errors={quickErrors} name="receivedAt" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="oa-due-at">Due at</label>
                  <input id="oa-due-at" required type="datetime-local" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.dueAt ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, dueAt: e.target.value }))} />
                  <FieldError errors={quickErrors} name="dueAt" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="oa-platform">Platform</label>
                  <input id="oa-platform" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Platform" value={quickForm.platform ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, platform: e.target.value }))} />
                  <FieldError errors={quickErrors} name="platform" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="oa-notes">Notes</label>
                  <textarea id="oa-notes" className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="notes" />
                </>
              )}
              {quickAction === 'interviewReceived' && (
                <>
                  <label className="block text-sm font-medium text-slate-700" htmlFor="interview-stage">Interview stage</label>
                  <select id="interview-stage" required className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.stage ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, stage: e.target.value }))}>
                    <option value="">Select a stage</option>
                    <option value="Recruiter Screen">Recruiter Screen</option>
                    <option value="Technical Interview">Technical Interview</option>
                    <option value="Final Round">Final Round</option>
                  </select>
                  <FieldError errors={quickErrors} name="stage" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="scheduled-start">Scheduled start</label>
                  <input id="scheduled-start" required type="datetime-local" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.scheduledStart ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, scheduledStart: e.target.value }))} />
                  <FieldError errors={quickErrors} name="scheduledStart" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="scheduled-end">Scheduled end</label>
                  <input id="scheduled-end" type="datetime-local" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.scheduledEnd ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, scheduledEnd: e.target.value }))} />
                  <FieldError errors={quickErrors} name="scheduledEnd" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="duration-minutes">Duration minutes</label>
                  <input id="duration-minutes" type="number" min="1" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.durationMinutes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, durationMinutes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="durationMinutes" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="interview-timezone">Time zone</label>
                  <input id="interview-timezone" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Time zone" value={quickForm.timezone ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, timezone: e.target.value }))} />
                  <FieldError errors={quickErrors} name="timezone" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="interview-format">Format</label>
                  <input id="interview-format" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Format" value={quickForm.format ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, format: e.target.value }))} />
                  <FieldError errors={quickErrors} name="format" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="interview-location">Location</label>
                  <input id="interview-location" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Location" value={quickForm.location ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, location: e.target.value }))} />
                  <FieldError errors={quickErrors} name="location" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="meeting-url">Meeting URL</label>
                  <input id="meeting-url" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Meeting URL" value={quickForm.meetingUrl ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, meetingUrl: e.target.value }))} />
                  <FieldError errors={quickErrors} name="meetingUrl" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="recruiter">Recruiter</label>
                  <input id="recruiter" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Recruiter" value={quickForm.recruiter ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, recruiter: e.target.value }))} />
                  <FieldError errors={quickErrors} name="recruiter" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="interviewer">Interviewer</label>
                  <input id="interviewer" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Interviewer" value={quickForm.interviewer ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, interviewer: e.target.value }))} />
                  <FieldError errors={quickErrors} name="interviewer" />
                </>
              )}
              {quickAction === 'reject' && (
                <>
                  <label className="block text-sm font-medium text-slate-700" htmlFor="rejection-reason">Rejection reason</label>
                  <input id="rejection-reason" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Rejection reason" value={quickForm.rejectionReason ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, rejectionReason: e.target.value }))} />
                  <FieldError errors={quickErrors} name="rejectionReason" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="rejection-notes">Rejection notes</label>
                  <textarea id="rejection-notes" className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Rejection notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="notes" />
                </>
              )}
              {quickAction === 'offer' && (
                <>
                  <label className="block text-sm font-medium text-slate-700" htmlFor="offer-date">Offer date</label>
                  <input id="offer-date" type="date" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.offerDate ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, offerDate: e.target.value }))} />
                  <FieldError errors={quickErrors} name="offerDate" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="decision-deadline">Decision deadline</label>
                  <input id="decision-deadline" required type="date" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.decisionDeadline ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, decisionDeadline: e.target.value }))} />
                  <FieldError errors={quickErrors} name="decisionDeadline" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="compensation-summary">Compensation</label>
                  <input id="compensation-summary" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Compensation" value={quickForm.compensationSummary ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, compensationSummary: e.target.value }))} />
                  <FieldError errors={quickErrors} name="compensationSummary" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="offer-notes">Notes</label>
                  <textarea id="offer-notes" className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="notes" />
                </>
              )}
              {quickAction === 'oaCompleted' && (
                <>
                  <label className="block text-sm font-medium text-slate-700" htmlFor="assessment-id">Assessment</label>
                  <select id="assessment-id" required className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.assessmentId ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, assessmentId: e.target.value }))}>
                    <option value="">Select an assessment</option>
                    {selectedApp.assessments.filter((assessment) => !assessment.completedAt).map((assessment) => (
                      <option key={assessment.id} value={assessment.id}>
                        {assessment.type} • due {assessment.dueAt ? format(new Date(assessment.dueAt), 'MMM d, yyyy') : 'unknown'}
                      </option>
                    ))}
                  </select>
                  <FieldError errors={quickErrors} name="assessmentId" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="oa-completed-at">Completed at</label>
                  <input id="oa-completed-at" type="datetime-local" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.completedAt ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, completedAt: e.target.value }))} />
                  <FieldError errors={quickErrors} name="completedAt" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="oa-difficulty">Difficulty</label>
                  <input id="oa-difficulty" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Difficulty" value={quickForm.difficulty ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, difficulty: e.target.value }))} />
                  <FieldError errors={quickErrors} name="difficulty" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="oa-confidence">Confidence</label>
                  <input id="oa-confidence" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Confidence" value={quickForm.confidence ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, confidence: e.target.value }))} />
                  <FieldError errors={quickErrors} name="confidence" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="oa-result">Result</label>
                  <input id="oa-result" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Result" value={quickForm.result ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, result: e.target.value }))} />
                  <FieldError errors={quickErrors} name="result" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="encountered-questions">Encountered questions</label>
                  <textarea id="encountered-questions" className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Encountered questions" value={quickForm.encounteredQuestions ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, encounteredQuestions: e.target.value }))} />
                  <FieldError errors={quickErrors} name="encounteredQuestions" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="oa-topics">Topics</label>
                  <textarea id="oa-topics" className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Topics" value={quickForm.topics ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, topics: e.target.value }))} />
                  <FieldError errors={quickErrors} name="topics" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="oa-completed-notes">Notes</label>
                  <textarea id="oa-completed-notes" className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="notes" />
                </>
              )}
              {quickAction === 'interviewCompleted' && (
                <>
                  <label className="block text-sm font-medium text-slate-700" htmlFor="interview-id">Interview</label>
                  <select id="interview-id" required className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.interviewId ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, interviewId: e.target.value }))}>
                    <option value="">Select an interview</option>
                    {selectedApp.interviews.filter((interview) => !interview.completedAt).map((interview) => (
                      <option key={interview.id} value={interview.id}>
                        {interview.stage} • {interview.scheduledStart ? format(new Date(interview.scheduledStart), 'MMM d, yyyy h:mm a') : 'unscheduled'}
                      </option>
                    ))}
                  </select>
                  <FieldError errors={quickErrors} name="interviewId" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="interview-completed-at">Completed at</label>
                  <input id="interview-completed-at" type="datetime-local" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.completedAt ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, completedAt: e.target.value }))} />
                  <FieldError errors={quickErrors} name="completedAt" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="interview-result">Result</label>
                  <input id="interview-result" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Result" value={quickForm.result ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, result: e.target.value }))} />
                  <FieldError errors={quickErrors} name="result" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="interview-questions">Questions</label>
                  <textarea id="interview-questions" className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Questions" value={quickForm.questions ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, questions: e.target.value }))} />
                  <FieldError errors={quickErrors} name="questions" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="what-went-well">What went well</label>
                  <textarea id="what-went-well" className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="What went well" value={quickForm.whatWentWell ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, whatWentWell: e.target.value }))} />
                  <FieldError errors={quickErrors} name="whatWentWell" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="improvements">Improvements</label>
                  <textarea id="improvements" className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Improvements" value={quickForm.improvements ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, improvements: e.target.value }))} />
                  <FieldError errors={quickErrors} name="improvements" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="interview-follow-up">Follow-up date</label>
                  <input id="interview-follow-up" type="date" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.followUpDate ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, followUpDate: e.target.value }))} />
                  <FieldError errors={quickErrors} name="followUpDate" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="interview-completed-notes">Notes</label>
                  <textarea id="interview-completed-notes" className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="notes" />
                </>
              )}
              {quickAction === 'note' && (
                <>
                  <label className="block text-sm font-medium text-slate-700" htmlFor="note-content">Note</label>
                  <textarea id="note-content" required className="w-full rounded-lg border border-slate-300 p-3" rows={4} placeholder="Add a note" value={quickForm.content ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, content: e.target.value }))} />
                  <FieldError errors={quickErrors} name="content" />
                </>
              )}
              {quickAction === 'contact' && (
                <>
                  <label className="block text-sm font-medium text-slate-700" htmlFor="contact-name">Name</label>
                  <input id="contact-name" required className="w-full rounded-lg border border-slate-300 p-3" placeholder="Name" value={quickForm.name ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, name: e.target.value }))} />
                  <FieldError errors={quickErrors} name="name" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="contact-title">Title</label>
                  <input id="contact-title" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Title" value={quickForm.title ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, title: e.target.value }))} />
                  <FieldError errors={quickErrors} name="title" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="contact-email">Email</label>
                  <input id="contact-email" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Email" value={quickForm.email ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, email: e.target.value }))} />
                  <FieldError errors={quickErrors} name="email" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="contact-relationship">Relationship</label>
                  <input id="contact-relationship" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Relationship" value={quickForm.relationship ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, relationship: e.target.value }))} />
                  <FieldError errors={quickErrors} name="relationship" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="contact-referral-status">Referral status</label>
                  <input id="contact-referral-status" className="w-full rounded-lg border border-slate-300 p-3" placeholder="Referral status" value={quickForm.referralStatus ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, referralStatus: e.target.value }))} />
                  <FieldError errors={quickErrors} name="referralStatus" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="contact-next-follow-up">Next follow-up date</label>
                  <input id="contact-next-follow-up" type="date" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.nextFollowUp ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, nextFollowUp: e.target.value }))} />
                  <FieldError errors={quickErrors} name="nextFollowUp" />
                  <label className="block text-sm font-medium text-slate-700" htmlFor="contact-notes">Notes</label>
                  <textarea id="contact-notes" className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                  <FieldError errors={quickErrors} name="notes" />
                </>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowQuickModal(false)} className="rounded-lg border border-slate-200 px-4 py-2">Cancel</button>
                <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-white">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showResumeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Create Resume</h3>
              <button onClick={() => setShowResumeModal(false)}>✕</button>
            </div>
            <form onSubmit={createResume} className="mt-4 space-y-3">
              <label className="block text-sm font-medium text-slate-700" htmlFor="resume-name">Resume name</label>
              <input id="resume-name" required className="w-full rounded-lg border border-slate-300 p-3" placeholder="Resume name" value={resumeForm.name} onChange={(e) => setResumeForm({ ...resumeForm, name: e.target.value })} />
              {resumeErrors.name && <p className="text-sm text-red-600">{resumeErrors.name[0]}</p>}

              <label className="block text-sm font-medium text-slate-700" htmlFor="resume-target-type">Target type</label>
              <input id="resume-target-type" required className="w-full rounded-lg border border-slate-300 p-3" placeholder="Target role" value={resumeForm.targetType} onChange={(e) => setResumeForm({ ...resumeForm, targetType: e.target.value })} />
              {resumeErrors.targetType && <p className="text-sm text-red-600">{resumeErrors.targetType[0]}</p>}

              <label className="block text-sm font-medium text-slate-700" htmlFor="resume-file-name">File name</label>
              <input id="resume-file-name" className="w-full rounded-lg border border-slate-300 p-3" placeholder="File name" value={resumeForm.fileName} onChange={(e) => setResumeForm({ ...resumeForm, fileName: e.target.value })} />
              {resumeErrors.fileName && <p className="text-sm text-red-600">{resumeErrors.fileName[0]}</p>}

              <label className="block text-sm font-medium text-slate-700" htmlFor="resume-description">Description</label>
              <textarea id="resume-description" className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Description" value={resumeForm.description} onChange={(e) => setResumeForm({ ...resumeForm, description: e.target.value })} />
              {resumeErrors.description && <p className="text-sm text-red-600">{resumeErrors.description[0]}</p>}

              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowResumeModal(false)} className="rounded-lg border border-slate-200 px-4 py-2">Cancel</button>
                <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-white">Save resume</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
