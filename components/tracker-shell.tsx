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
  interviews: Array<{ stage: string; scheduledStart: string | null; notes: string | null }>;
  contacts: Array<{ name: string; email: string | null; notes: string | null }>;
  activities: Array<{ eventType: string; summary: string; createdAt: string }>;
};

type ResumeRecord = { id:string; name:string; targetType:string; fileName:string | null; description:string | null; applications: Array<{ id:string }> };

type ProfileRecord = { id:string; name:string; school:string; major:string; graduation:string; preferredLocation:string; currentExperience:string; targetRoles:string; targetCategories:string };

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
  const [quickAction, setQuickAction] = useState<'apply' | 'oa' | 'interview' | 'reject' | 'offer' | 'note'>('apply');
  const [newForm, setNewForm] = useState({ company:'', role:'', applicationUrl:'', priority:'P2', status:'Not Applied', location:'', notes:'' });
  const [quickForm, setQuickForm] = useState<Record<string, string>>({});
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
      toast.success('Opportunity created');
      setShowNewModal(false);
      setNewForm({ company:'', role:'', applicationUrl:'', priority:'P2', status:'Not Applied', location:'', notes:'' });
      loadData();
    } else {
      const data = await response.json();
      toast.error(data.duplicate ? 'Likely duplicate detected' : 'Unable to create application');
    }
  };

  const runQuickAction = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedApp) return;
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
      loadData();
    } else {
      toast.error('Unable to update workflow');
    }
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
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search applications" className="w-44 bg-transparent outline-none" />
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
                          <div className="rounded-lg border border-slate-200 p-3">Status: <span className="font-medium text-slate-900">{selectedApp.status}</span></div>
                          <div className="rounded-lg border border-slate-200 p-3">Stage: <span className="font-medium text-slate-900">{selectedApp.currentStage}</span></div>
                          <div className="rounded-lg border border-slate-200 p-3">Next action: <span className="font-medium text-slate-900">{selectedApp.nextAction}</span></div>
                          <div className="rounded-lg border border-slate-200 p-3">Last update: <span className="font-medium text-slate-900">{formatDistanceToNow(new Date(selectedApp.updatedAt), { addSuffix: true })}</span></div>
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button onClick={() => { setQuickAction('apply'); setQuickForm({ resumeVersionId: selectedApp?.resumeVersion?.id ?? '' }); setShowQuickModal(true); }} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">Mark Applied</button>
                          <button onClick={() => { setQuickAction('oa'); setQuickForm({}); setShowQuickModal(true); }} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">OA Received</button>
                          <button onClick={() => { setQuickAction('interview'); setQuickForm({}); setShowQuickModal(true); }} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">Interview Received</button>
                          <button onClick={() => { setQuickAction('reject'); setQuickForm({}); setShowQuickModal(true); }} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">Rejected</button>
                          <button onClick={() => { setQuickAction('offer'); setQuickForm({}); setShowQuickModal(true); }} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">Offer Received</button>
                          <button onClick={() => { setQuickAction('note'); setQuickForm({}); setShowQuickModal(true); }} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">Add Note</button>
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
                        <textarea value={quickForm.fullText ?? selectedApp.jobDescription?.fullText ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, fullText: e.target.value }))} rows={10} className="w-full rounded-lg border border-slate-300 p-3" placeholder="Paste the full job description" />
                        <textarea value={quickForm.minimumQualifications ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, minimumQualifications: e.target.value }))} rows={4} className="w-full rounded-lg border border-slate-300 p-3" placeholder="Minimum qualifications" />
                        <textarea value={quickForm.preferredQualifications ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, preferredQualifications: e.target.value }))} rows={4} className="w-full rounded-lg border border-slate-300 p-3" placeholder="Preferred qualifications" />
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
                    <input type="file" accept=".xlsx,.xls" onChange={importFile} className="mt-4 block w-full text-sm" />
                    <p className="mt-3 text-sm text-slate-500">Upload an existing tracker workbook to import applications.</p>
                  </div>
                </div>
              )}

              {activeSection === 'settings' && profile && (
                <div className="rounded-xl border border-slate-200 bg-white p-6">
                  <h3 className="text-lg font-semibold">Profile and settings</h3>
                  <form onSubmit={saveProfile} className="mt-4 grid gap-4 md:grid-cols-2">
                    <input className="rounded-lg border border-slate-300 p-3" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} placeholder="Name" />
                    <input className="rounded-lg border border-slate-300 p-3" value={profile.school} onChange={(e) => setProfile({ ...profile, school: e.target.value })} placeholder="School" />
                    <input className="rounded-lg border border-slate-300 p-3" value={profile.major} onChange={(e) => setProfile({ ...profile, major: e.target.value })} placeholder="Major" />
                    <input className="rounded-lg border border-slate-300 p-3" value={profile.graduation} onChange={(e) => setProfile({ ...profile, graduation: e.target.value })} placeholder="Graduation" />
                    <input className="rounded-lg border border-slate-300 p-3" value={profile.preferredLocation} onChange={(e) => setProfile({ ...profile, preferredLocation: e.target.value })} placeholder="Preferred location" />
                    <input className="rounded-lg border border-slate-300 p-3" value={profile.currentExperience} onChange={(e) => setProfile({ ...profile, currentExperience: e.target.value })} placeholder="Current experience" />
                    <textarea className="md:col-span-2 rounded-lg border border-slate-300 p-3" rows={3} value={profile.targetCategories} onChange={(e) => setProfile({ ...profile, targetCategories: e.target.value })} placeholder="Target categories" />
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
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">New Opportunity</h3>
              <button onClick={() => setShowNewModal(false)}>✕</button>
            </div>
            <form onSubmit={createApp} className="mt-4 space-y-3">
              <input required className="w-full rounded-lg border border-slate-300 p-3" placeholder="Company" value={newForm.company} onChange={(e) => setNewForm({ ...newForm, company: e.target.value })} />
              <input required className="w-full rounded-lg border border-slate-300 p-3" placeholder="Role" value={newForm.role} onChange={(e) => setNewForm({ ...newForm, role: e.target.value })} />
              <input required className="w-full rounded-lg border border-slate-300 p-3" placeholder="Application URL" value={newForm.applicationUrl} onChange={(e) => setNewForm({ ...newForm, applicationUrl: e.target.value })} />
              <select className="w-full rounded-lg border border-slate-300 p-3" value={newForm.priority} onChange={(e) => setNewForm({ ...newForm, priority: e.target.value })}>
                <option value="P0">P0 — Dream</option><option value="P1">P1 — High</option><option value="P2">P2 — Strong</option><option value="P3">P3 — Backup</option>
              </select>
              <select className="w-full rounded-lg border border-slate-300 p-3" value={newForm.status} onChange={(e) => setNewForm({ ...newForm, status: e.target.value })}>
                <option value="Not Applied">Not Applied</option><option value="Preparing">Preparing</option>
              </select>
              <input className="w-full rounded-lg border border-slate-300 p-3" placeholder="Location" value={newForm.location} onChange={(e) => setNewForm({ ...newForm, location: e.target.value })} />
              <textarea className="w-full rounded-lg border border-slate-300 p-3" placeholder="Notes" rows={3} value={newForm.notes} onChange={(e) => setNewForm({ ...newForm, notes: e.target.value })} />
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
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">{quickAction === 'apply' ? 'Mark Applied' : quickAction === 'oa' ? 'OA Received' : quickAction === 'interview' ? 'Interview Received' : quickAction === 'reject' ? 'Rejected' : quickAction === 'offer' ? 'Offer Received' : 'Add Note'}</h3>
              <button onClick={() => setShowQuickModal(false)}>✕</button>
            </div>
            <form onSubmit={runQuickAction} className="mt-4 space-y-3">
              {quickAction === 'apply' && (
                <>
                  <input type="date" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.dateApplied ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, dateApplied: e.target.value }))} />
                  <select className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.resumeVersionId ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, resumeVersionId: e.target.value }))}>
                    <option value="">Select a resume version</option>
                    {resumes.map((resume) => (
                      <option key={resume.id} value={resume.id}>{resume.name}</option>
                    ))}
                  </select>
                  <input className="w-full rounded-lg border border-slate-300 p-3" placeholder="Email used" value={quickForm.emailUsed ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, emailUsed: e.target.value }))} />
                </>
              )}
              {quickAction === 'oa' && (
                <>
                  <input type="date" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.nextActionDue ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, nextActionDue: e.target.value }))} />
                  <input className="w-full rounded-lg border border-slate-300 p-3" placeholder="Platform" value={quickForm.platform ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, platform: e.target.value }))} />
                  <textarea className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                </>
              )}
              {quickAction === 'interview' && (
                <>
                  <input className="w-full rounded-lg border border-slate-300 p-3" placeholder="Interview stage" value={quickForm.currentStage ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, currentStage: e.target.value }))} />
                  <input type="datetime-local" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.scheduledStart ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, scheduledStart: e.target.value }))} />
                  <input className="w-full rounded-lg border border-slate-300 p-3" placeholder="Location" value={quickForm.location ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, location: e.target.value }))} />
                </>
              )}
              {quickAction === 'reject' && (
                <textarea className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Rejection notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
              )}
              {quickAction === 'offer' && (
                <>
                  <input type="date" className="w-full rounded-lg border border-slate-300 p-3" value={quickForm.nextActionDue ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, nextActionDue: e.target.value }))} />
                  <input className="w-full rounded-lg border border-slate-300 p-3" placeholder="Compensation" value={quickForm.compensationSummary ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, compensationSummary: e.target.value }))} />
                  <textarea className="w-full rounded-lg border border-slate-300 p-3" rows={3} placeholder="Notes" value={quickForm.notes ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, notes: e.target.value }))} />
                </>
              )}
              {quickAction === 'note' && (
                <textarea className="w-full rounded-lg border border-slate-300 p-3" rows={4} placeholder="Add a note" value={quickForm.content ?? ''} onChange={(e) => setQuickForm((prev) => ({ ...prev, content: e.target.value }))} />
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowQuickModal(false)} className="rounded-lg border border-slate-200 px-4 py-2">Cancel</button>
                <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-white">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
