'use client';

import { useState } from 'react';
import { toast } from 'react-hot-toast';
import { POSTING_STATUSES, type ApplicationRecord } from './types';

type EditFormState = {
  company: string; role: string; jobId: string; location: string; workModel: string; priority: string;
  postingStatus: string; postingDate: string; applicationDeadline: string; dateFound: string;
  applicationUrl: string; candidatePortalUrl: string; emailUsed: string; portalUsername: string;
  passwordManagerReference: string; confirmationNumber: string; compensationSummary: string;
  eligibility: string; sponsorship: string; whyFit: string; nextAction: string; nextActionDue: string;
  nextActionDueKind: 'date' | 'timestamp'; notes: string;
};

const toFormState = (app: ApplicationRecord): EditFormState => ({
  company: app.company, role: app.role, jobId: app.jobId ?? '', location: app.location ?? '', workModel: app.workModel ?? '',
  priority: app.priority, postingStatus: app.postingStatus ?? '', postingDate: app.postingDate?.slice(0, 10) ?? '',
  applicationDeadline: app.applicationDeadline?.slice(0, 10) ?? '', dateFound: app.dateFound?.slice(0, 10) ?? '',
  applicationUrl: app.applicationUrl ?? '', candidatePortalUrl: app.candidatePortalUrl ?? '', emailUsed: app.emailUsed ?? '',
  portalUsername: app.portalUsername ?? '', passwordManagerReference: app.passwordManagerReference ?? '',
  confirmationNumber: app.confirmationNumber ?? '', compensationSummary: app.compensationSummary ?? '',
  eligibility: app.eligibility ?? '', sponsorship: app.sponsorship ?? '', whyFit: app.whyFit ?? '',
  nextAction: app.nextAction ?? '', nextActionDue: app.nextActionDueKind === 'date' ? (app.nextActionDue?.slice(0, 10) ?? '') : (app.nextActionDue?.slice(0, 16) ?? ''),
  nextActionDueKind: app.nextActionDueKind, notes: app.notes ?? '',
});

const field = 'w-full rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm outline-none focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]';
const label = 'block text-xs font-medium text-slate-600';

export function EditApplicationModal({ application, onClose, onSaved }: { application: ApplicationRecord; onClose: () => void; onSaved: () => Promise<void> | void }) {
  const [form, setForm] = useState<EditFormState>(() => toFormState(application));
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof EditFormState>(key: K, value: EditFormState[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        action: 'editApplication',
        company: form.company, role: form.role, jobId: form.jobId || null, location: form.location || null,
        workModel: form.workModel || null, priority: form.priority, postingStatus: form.postingStatus || null,
        postingDate: form.postingDate || null, applicationDeadline: form.applicationDeadline || null, dateFound: form.dateFound || null,
        applicationUrl: form.applicationUrl || null, candidatePortalUrl: form.candidatePortalUrl || null,
        emailUsed: form.emailUsed || null, portalUsername: form.portalUsername || null,
        passwordManagerReference: form.passwordManagerReference || null, confirmationNumber: form.confirmationNumber || null,
        compensationSummary: form.compensationSummary || null, eligibility: form.eligibility || null,
        sponsorship: form.sponsorship || null, whyFit: form.whyFit || null, nextAction: form.nextAction || null,
        nextActionDue: form.nextActionDue || null, nextActionDueKind: form.nextActionDueKind, notes: form.notes || null,
      };
      const response = await fetch(`/api/applications/${application.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        toast.error(data?.error ?? 'Unable to save changes');
        return;
      }
      toast.success('Application updated');
      onClose();
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold">Edit Application</h3>
        <form onSubmit={save} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className={label}>Company<input className={field} value={form.company} onChange={(e) => set('company', e.target.value)} required /></label>
          <label className={label}>Role<input className={field} value={form.role} onChange={(e) => set('role', e.target.value)} required /></label>
          <label className={label}>Job ID<input className={field} value={form.jobId} onChange={(e) => set('jobId', e.target.value)} /></label>
          <label className={label}>Location<input className={field} value={form.location} onChange={(e) => set('location', e.target.value)} /></label>
          <label className={label}>Work model<input className={field} value={form.workModel} onChange={(e) => set('workModel', e.target.value)} placeholder="Remote / Hybrid / Onsite" /></label>
          <label className={label}>Priority
            <select className={field} value={form.priority} onChange={(e) => set('priority', e.target.value)}>
              <option value="P0">P0</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option>
            </select>
          </label>
          <label className={label}>Posting status
            <select className={field} value={form.postingStatus} onChange={(e) => set('postingStatus', e.target.value)}>
              <option value="">—</option>
              {POSTING_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className={label}>Posting date<input type="date" className={field} value={form.postingDate} onChange={(e) => set('postingDate', e.target.value)} /></label>
          <label className={label}>Official application deadline<input type="date" className={field} value={form.applicationDeadline} onChange={(e) => set('applicationDeadline', e.target.value)} /></label>
          <label className={label}>Date found<input type="date" className={field} value={form.dateFound} onChange={(e) => set('dateFound', e.target.value)} /></label>
          <label className={label}>Job-posting URL<input className={field} value={form.applicationUrl} onChange={(e) => set('applicationUrl', e.target.value)} /></label>
          <label className={label}>Candidate portal URL<input className={field} value={form.candidatePortalUrl} onChange={(e) => set('candidatePortalUrl', e.target.value)} /></label>
          <label className={label}>Login email<input className={field} value={form.emailUsed} onChange={(e) => set('emailUsed', e.target.value)} /></label>
          <label className={label}>Portal username<input className={field} value={form.portalUsername} onChange={(e) => set('portalUsername', e.target.value)} /></label>
          <label className={`${label} sm:col-span-2`}>
            Password-manager reference (never an actual password)
            <input className={field} value={form.passwordManagerReference} onChange={(e) => set('passwordManagerReference', e.target.value)} placeholder="e.g. 1Password &gt; Work &gt; Acme" />
          </label>
          <label className={label}>Confirmation number<input className={field} value={form.confirmationNumber} onChange={(e) => set('confirmationNumber', e.target.value)} /></label>
          <label className={label}>Compensation summary<input className={field} value={form.compensationSummary} onChange={(e) => set('compensationSummary', e.target.value)} /></label>
          <label className={`${label} sm:col-span-2`}>Eligibility<textarea className={field} rows={2} value={form.eligibility} onChange={(e) => set('eligibility', e.target.value)} /></label>
          <label className={`${label} sm:col-span-2`}>Sponsorship<textarea className={field} rows={2} value={form.sponsorship} onChange={(e) => set('sponsorship', e.target.value)} /></label>
          <label className={`${label} sm:col-span-2`}>Why this role fits<textarea className={field} rows={2} value={form.whyFit} onChange={(e) => set('whyFit', e.target.value)} /></label>
          <label className={label}>Personal next action<input className={field} value={form.nextAction} onChange={(e) => set('nextAction', e.target.value)} /></label>
          <div>
            <label className={label}>
              Personal next-action due
              <div className="mt-1 flex gap-2">
                <input
                  type={form.nextActionDueKind === 'date' ? 'date' : 'datetime-local'}
                  className={field}
                  value={form.nextActionDue}
                  onChange={(e) => set('nextActionDue', e.target.value)}
                />
                <select className="rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm" value={form.nextActionDueKind} onChange={(e) => set('nextActionDueKind', e.target.value as 'date' | 'timestamp')}>
                  <option value="date">Date</option>
                  <option value="timestamp">Date + time</option>
                </select>
              </div>
            </label>
          </div>
          <label className={`${label} sm:col-span-2`}>General notes<textarea className={field} rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>

          <div className="mt-2 flex justify-end gap-2 sm:col-span-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-[#ffc4d6] bg-white px-4 py-2 text-sm text-slate-600">Cancel</button>
            <button type="submit" disabled={saving} className="rounded-lg bg-[#ff87ab] px-4 py-2 text-sm font-medium text-slate-900 shadow-sm disabled:opacity-50">
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
