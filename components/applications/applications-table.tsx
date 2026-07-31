'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, X, Minimize2 } from 'lucide-react';
import { formatByKind, formatDateOnly, formatInZone, formatTimestamp, resolveDeadlineInstant } from '@/lib/dates';
import { isPersonalDeadlineOverdue } from '@/lib/deadline-sort';
import { Timeline } from './timeline';
import { NotesPanel } from './notes-panel';
import { LinksPanel } from './links-panel';
import { TERMINAL_STATUSES, type ApplicationRecord } from './types';

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const isTerminal = (status: string) => (TERMINAL_STATUSES as readonly string[]).includes(status);

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

type SortColumn = 'company' | 'role' | 'priority' | 'status' | 'postingStatus' | 'nextAction' | 'nextActionDue' | 'updatedAt' | null;

function defaultCompare(a: ApplicationRecord, b: ApplicationRecord, timeZone: string): number {
  const aTerminal = isTerminal(a.status);
  const bTerminal = isTerminal(b.status);
  if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;

  const aOverdue = isPersonalDeadlineOverdue(a, timeZone);
  const bOverdue = isPersonalDeadlineOverdue(b, timeZone);
  if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;

  const aInstant = a.nextActionDue ? resolveDeadlineInstant(a.nextActionDue, a.nextActionDueKind, timeZone) : null;
  const bInstant = b.nextActionDue ? resolveDeadlineInstant(b.nextActionDue, b.nextActionDueKind, timeZone) : null;
  if (aInstant && bInstant && aInstant.getTime() !== bInstant.getTime()) return aInstant.getTime() - bInstant.getTime();
  if (aInstant && !bInstant) return -1;
  if (!aInstant && bInstant) return 1;

  const aPriority = PRIORITY_RANK[a.priority] ?? 99;
  const bPriority = PRIORITY_RANK[b.priority] ?? 99;
  if (aPriority !== bPriority) return aPriority - bPriority;

  const aDateFound = a.dateFound ? new Date(a.dateFound).getTime() : Infinity;
  const bDateFound = b.dateFound ? new Date(b.dateFound).getTime() : Infinity;
  if (aDateFound !== bDateFound) return aDateFound - bDateFound;

  return a.company.localeCompare(b.company);
}

function columnCompare(column: SortColumn, a: ApplicationRecord, b: ApplicationRecord, timeZone: string): number {
  switch (column) {
    case 'company': return a.company.localeCompare(b.company);
    case 'role': return a.role.localeCompare(b.role);
    case 'priority': return (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99);
    case 'status': return a.status.localeCompare(b.status);
    case 'postingStatus': return (a.postingStatus ?? '').localeCompare(b.postingStatus ?? '');
    case 'nextAction': return (a.nextAction ?? '').localeCompare(b.nextAction ?? '');
    case 'nextActionDue': {
      const aInstant = a.nextActionDue ? resolveDeadlineInstant(a.nextActionDue, a.nextActionDueKind, timeZone) : null;
      const bInstant = b.nextActionDue ? resolveDeadlineInstant(b.nextActionDue, b.nextActionDueKind, timeZone) : null;
      if (!aInstant && !bInstant) return 0;
      if (!aInstant) return 1;
      if (!bInstant) return -1;
      return aInstant.getTime() - bInstant.getTime();
    }
    case 'updatedAt': return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    default: return 0;
  }
}

const COLUMNS: Array<{ key: SortColumn; label: string }> = [
  { key: 'company', label: 'Company' },
  { key: 'role', label: 'Role' },
  { key: 'priority', label: 'Priority' },
  { key: 'status', label: 'Candidate Status' },
  { key: 'postingStatus', label: 'Posting Status' },
  { key: 'nextAction', label: 'Personal Next Action' },
  { key: 'nextActionDue', label: 'My Due Date' },
  { key: 'updatedAt', label: 'Last Update' },
];

type DrawerTab = 'overview' | 'links' | 'notes' | 'timeline' | 'actions';

export function ApplicationsTable({
  applications, selectedAppId, onSelect, onEdit, onChanged, renderActionsTab, timeZone,
}: {
  applications: ApplicationRecord[];
  selectedAppId: string | null;
  onSelect: (id: string | null) => void;
  onEdit: (app: ApplicationRecord) => void;
  onChanged: () => Promise<void> | void;
  renderActionsTab: (app: ApplicationRecord) => React.ReactNode;
  timeZone: string;
}) {
  const [sortColumn, setSortColumn] = useState<SortColumn>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [postingStatusFilter, setPostingStatusFilter] = useState('');
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  // Defaults to "actions" — the workflow buttons (Mark Applied, OA Received,
  // …) are the most common thing done right after selecting a row, so they
  // should be immediately visible without an extra tab click.
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('actions');

  // Selecting a DIFFERENT application always reopens on "Actions" — staying
  // on whatever tab a previous application happened to be left on (e.g.
  // Overview) would silently hide the workflow buttons for the new one.
  useEffect(() => {
    setDrawerTab('actions');
  }, [selectedAppId]);

  const selectedApp = useMemo(() => applications.find((a) => a.id === selectedAppId) ?? null, [applications, selectedAppId]);

  const filtered = useMemo(() => applications.filter((app) =>
    (!priorityFilter || app.priority === priorityFilter)
    && (!statusFilter || app.status === statusFilter)
    && (!postingStatusFilter || app.postingStatus === postingStatusFilter),
  ), [applications, priorityFilter, statusFilter, postingStatusFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const result = sortColumn ? columnCompare(sortColumn, a, b, timeZone) : defaultCompare(a, b, timeZone);
      return sortDirection === 'asc' ? result : -result;
    });
    return copy;
  }, [filtered, sortColumn, sortDirection, timeZone]);

  const toggleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const statusOptions = useMemo(() => [...new Set(applications.map((a) => a.status))].sort(), [applications]);
  const postingStatusOptions = useMemo(() => [...new Set(applications.map((a) => a.postingStatus).filter((v): v is string => !!v))].sort(), [applications]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} className="rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm">
          <option value="">All priorities</option>
          {['P0', 'P1', 'P2', 'P3'].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm">
          <option value="">All candidate statuses</option>
          {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={postingStatusFilter} onChange={(e) => setPostingStatusFilter(e.target.value)} className="rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm">
          <option value="">All posting statuses</option>
          {postingStatusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {selectedApp && (
        <div className="rounded-xl border border-[#ffcad4] bg-white shadow-sm" data-testid="application-detail-drawer">
          <div className="flex items-center justify-between border-b border-[#ffcad4] p-4">
            <div>
              <h3 className="text-lg font-semibold">{selectedApp.company} — {selectedApp.role}</h3>
              <p className="text-sm text-slate-500">
                <span data-testid="app-status" className={`rounded-full px-2 py-0.5 font-medium ${statusToneClass(selectedApp.status)}`}>{selectedApp.status}</span>
                {selectedApp.currentStage ? ` • ${selectedApp.currentStage}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setDrawerCollapsed((v) => !v)} title="Collapse" className="rounded-lg p-2 text-slate-400 hover:bg-[#fadde1]"><Minimize2 size={16} /></button>
              <button onClick={() => onSelect(null)} title="Close" data-testid="close-drawer" className="rounded-lg p-2 text-slate-400 hover:bg-[#fadde1]"><X size={16} /></button>
            </div>
          </div>

          {!drawerCollapsed && (
            <div className="p-4">
              <div className="mb-4 flex flex-wrap gap-2 border-b border-[#ffcad4] pb-3">
                {(['overview', 'links', 'notes', 'timeline', 'actions'] as DrawerTab[]).map((tab) => (
                  <button
                    key={tab}
                    data-testid={`drawer-tab-${tab}`}
                    onClick={() => setDrawerTab(tab)}
                    className={`rounded-lg px-3 py-1.5 text-sm capitalize transition ${drawerTab === tab ? 'bg-[#ff87ab] text-slate-900' : 'text-slate-500 hover:bg-[#fadde1]'}`}
                  >
                    {tab === 'links' ? 'Links & Login' : tab}
                  </button>
                ))}
              </div>

              {drawerTab === 'overview' && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => onEdit(selectedApp)} className="rounded-lg bg-[#ff87ab] px-4 py-2 text-sm font-medium text-slate-900 shadow-sm" data-testid="open-edit-application">
                      Edit Application
                    </button>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                    <div><dt className="text-slate-500">Priority</dt><dd>{selectedApp.priority}</dd></div>
                    <div><dt className="text-slate-500">Location</dt><dd>{selectedApp.location ?? '—'}</dd></div>
                    <div><dt className="text-slate-500">Work model</dt><dd>{selectedApp.workModel ?? '—'}</dd></div>
                    <div><dt className="text-slate-500">Posting status</dt><dd>{selectedApp.postingStatus ?? '—'}</dd></div>
                    <div><dt className="text-slate-500">Date found</dt><dd>{formatDateOnly(selectedApp.dateFound)}</dd></div>
                    <div><dt className="text-slate-500">Official deadline</dt><dd>{formatDateOnly(selectedApp.applicationDeadline)}</dd></div>
                    <div><dt className="text-slate-500">My personal next action</dt><dd>{selectedApp.nextAction ?? '—'}</dd></div>
                    <div><dt className="text-slate-500">My due date</dt><dd>{selectedApp.nextActionDue ? formatByKind(selectedApp.nextActionDue, selectedApp.nextActionDueKind) : '—'}</dd></div>
                    <div><dt className="text-slate-500">Compensation</dt><dd>{selectedApp.compensationSummary ?? '—'}</dd></div>
                    {selectedApp.dateApplied && (
                      <div><dt className="text-slate-500">Date applied</dt><dd data-testid="date-applied">{formatDateOnly(selectedApp.dateApplied)}</dd></div>
                    )}
                    <div className="col-span-2 sm:col-span-3"><dt className="text-slate-500">Eligibility</dt><dd>{selectedApp.eligibility ?? '—'}</dd></div>
                    <div className="col-span-2 sm:col-span-3"><dt className="text-slate-500">Sponsorship</dt><dd>{selectedApp.sponsorship ?? '—'}</dd></div>
                    <div className="col-span-2 sm:col-span-3"><dt className="text-slate-500">Why this fits</dt><dd>{selectedApp.whyFit ?? '—'}</dd></div>
                    <div className="col-span-2 sm:col-span-3"><dt className="text-slate-500">Notes</dt><dd className="whitespace-pre-wrap">{selectedApp.notes ?? '—'}</dd></div>
                  </dl>

                  {selectedApp.offers && (
                    <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-sm">
                      <p className="font-medium text-emerald-900">Offer details</p>
                      <p>Offer date: <span data-testid="offer-date" className="font-medium text-slate-900">{formatDateOnly(selectedApp.offers.offerDate)}</span></p>
                      <p>Decision deadline: <span data-testid="offer-deadline" className="font-medium text-slate-900">{formatDateOnly(selectedApp.offers.decisionDeadline)}</span></p>
                      <p>Compensation: <span data-testid="offer-compensation" className="font-medium text-slate-900">{selectedApp.offers.compensationSummary ?? '—'}</span></p>
                      <p>Notes: <span data-testid="offer-notes" className="font-medium text-slate-900">{selectedApp.offers.notes ?? '—'}</span></p>
                    </div>
                  )}
                  {selectedApp.assessments.map((assessment) => (
                    <div key={assessment.id} data-testid="assessment-detail" className="rounded-lg border border-sky-100 bg-sky-50 p-3 text-sm">
                      <p className="font-medium text-sky-900">{assessment.type} assessment</p>
                      {assessment.dueAt && (
                        <p>Due: <span className="font-medium text-slate-900">
                          {formatInZone(assessment.dueAt, assessment.timezone, 'MMM d, yyyy h:mm a zzz')}
                          {assessment.timezone && assessment.timezone !== timeZone && (
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
              )}
              {drawerTab === 'links' && <LinksPanel application={selectedApp} onChanged={onChanged} />}
              {drawerTab === 'notes' && <NotesPanel applicationId={selectedApp.id} notes={selectedApp.notesRelation} onChanged={onChanged} />}
              {drawerTab === 'timeline' && <Timeline activities={selectedApp.activities} />}
              {drawerTab === 'actions' && <div className="flex flex-wrap gap-2">{renderActionsTab(selectedApp)}</div>}
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-[#ffcad4] bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-[#ffcad4] text-left text-[#ffa6c1]">
              {COLUMNS.map((col) => (
                <th key={col.key} className="cursor-pointer select-none whitespace-nowrap px-3 py-2" onClick={() => toggleSort(col.key)}>
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {sortColumn === col.key && (sortDirection === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((app) => {
              const overdue = isPersonalDeadlineOverdue(app, timeZone);
              return (
                <tr
                  key={app.id}
                  data-testid="application-row"
                  onClick={() => onSelect(app.id === selectedAppId ? null : app.id)}
                  className={`cursor-pointer border-b border-[#fadde1] transition hover:bg-[#fadde1]/40 ${selectedAppId === app.id ? 'bg-[#fadde1]/60' : ''}`}
                >
                  <td className="px-3 py-2 font-medium">{app.company}</td>
                  <td className="px-3 py-2">{app.role}</td>
                  <td className="px-3 py-2">{app.priority}</td>
                  <td className="px-3 py-2">{app.status}</td>
                  <td className="px-3 py-2">{app.postingStatus ?? '—'}</td>
                  <td className="px-3 py-2">{app.nextAction ?? '—'}</td>
                  <td className={`px-3 py-2 ${overdue ? 'font-medium text-rose-600' : ''}`}>
                    {app.nextActionDue ? formatByKind(app.nextActionDue, app.nextActionDueKind, 'MMM d, yyyy') : '—'}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{formatDateOnly(app.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
