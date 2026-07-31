'use client';

import { useState } from 'react';
import { toast } from 'react-hot-toast';
import { ExternalLink, Copy, Trash2, Pencil } from 'lucide-react';
import { LINK_CATEGORIES, type ApplicationRecord, type LinkRecord } from './types';

const copyToClipboard = async (value: string) => {
  try {
    await navigator.clipboard.writeText(value);
    toast.success('Link copied');
  } catch {
    toast.error('Unable to copy link');
  }
};

export function LinksPanel({ application, onChanged }: { application: ApplicationRecord; onChanged: () => Promise<void> | void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ label: '', url: '', category: 'Other', notes: '' });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ label: '', url: '', category: 'Other', notes: '' });

  const addLink = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.label.trim() || !form.url.trim()) {
      toast.error('Label and URL are required');
      return;
    }
    const response = await fetch('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationId: application.id, ...form }),
    });
    if (!response.ok) {
      toast.error('Unable to add link — check the URL is valid');
      return;
    }
    setForm({ label: '', url: '', category: 'Other', notes: '' });
    setShowAdd(false);
    toast.success('Link added');
    await onChanged();
  };

  const startEdit = (link: LinkRecord) => {
    setEditingId(link.id);
    setEditForm({ label: link.label, url: link.url, category: link.category ?? 'Other', notes: link.notes ?? '' });
  };

  const saveEdit = async (linkId: string) => {
    const response = await fetch(`/api/links/${linkId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editForm),
    });
    if (!response.ok) {
      toast.error('Unable to update link');
      return;
    }
    setEditingId(null);
    toast.success('Link updated');
    await onChanged();
  };

  const deleteLink = async (linkId: string) => {
    if (!window.confirm('Delete this link?')) return;
    const response = await fetch(`/api/links/${linkId}`, { method: 'DELETE' });
    if (!response.ok) {
      toast.error('Unable to delete link');
      return;
    }
    toast.success('Link deleted');
    await onChanged();
  };

  return (
    <div className="space-y-6" data-testid="links-panel">
      <div>
        <h4 className="text-sm font-semibold text-slate-700">Primary links</h4>
        <div className="mt-2 flex flex-wrap gap-2">
          {application.applicationUrl && (
            <>
              <a href={application.applicationUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-lg bg-[#ff87ab] px-3 py-2 text-sm font-medium text-slate-900 shadow-sm transition hover:bg-[#ff5d8f]">
                <ExternalLink size={14} /> Open Job Posting
              </a>
              <button onClick={() => copyToClipboard(application.applicationUrl!)} className="flex items-center gap-1.5 rounded-lg border border-[#ffc4d6] bg-white px-3 py-2 text-sm text-slate-600 transition hover:bg-[#fadde1]">
                <Copy size={14} /> Copy Link
              </button>
            </>
          )}
          {application.candidatePortalUrl && (
            <>
              <a href={application.candidatePortalUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-lg border border-[#ffc4d6] bg-white px-3 py-2 text-sm text-slate-600 transition hover:bg-[#fadde1]">
                <ExternalLink size={14} /> Open Candidate Portal
              </a>
              <button onClick={() => copyToClipboard(application.candidatePortalUrl!)} className="flex items-center gap-1.5 rounded-lg border border-[#ffc4d6] bg-white px-3 py-2 text-sm text-slate-600 transition hover:bg-[#fadde1]">
                <Copy size={14} /> Copy Link
              </button>
            </>
          )}
          {!application.applicationUrl && !application.candidatePortalUrl && <p className="text-sm text-slate-500">No primary links on file — add them via Edit Application.</p>}
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-slate-700">Portal / login details</h4>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Login email</dt><dd>{application.emailUsed ?? '—'}</dd>
          <dt className="text-slate-500">Portal username</dt><dd>{application.portalUsername ?? '—'}</dd>
          <dt className="text-slate-500">Password manager reference</dt><dd>{application.passwordManagerReference ?? '—'}</dd>
          <dt className="text-slate-500">Confirmation number</dt><dd>{application.confirmationNumber ?? '—'}</dd>
        </dl>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-slate-700">Additional links</h4>
          <button onClick={() => setShowAdd((v) => !v)} className="text-xs font-medium text-[#ff5d8f] hover:underline">{showAdd ? 'Cancel' : '+ Add link'}</button>
        </div>

        {showAdd && (
          <form onSubmit={addLink} className="mt-2 space-y-2 rounded-lg border border-[#ffcad4] bg-[#fadde1]/30 p-3">
            <input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="Label" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm" />
            <input value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://…" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm" />
            <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} className="w-full rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm">
              {LINK_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Notes (optional)" className="w-full rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm" />
            <button type="submit" className="rounded-lg bg-[#ff87ab] px-4 py-2 text-sm font-medium text-slate-900">Save Link</button>
          </form>
        )}

        <div className="mt-2 space-y-2">
          {application.links.length === 0 && !showAdd && <p className="text-sm text-slate-500">No additional links yet.</p>}
          {application.links.map((link) => (
            <div key={link.id} data-testid="application-link" className="rounded-lg border border-[#ffcad4] bg-white p-3 text-sm shadow-sm">
              {editingId === link.id ? (
                <div className="space-y-2">
                  <input value={editForm.label} onChange={(e) => setEditForm((f) => ({ ...f, label: e.target.value }))} className="w-full rounded-lg border border-[#ffc4d6] p-2 text-sm" />
                  <input value={editForm.url} onChange={(e) => setEditForm((f) => ({ ...f, url: e.target.value }))} className="w-full rounded-lg border border-[#ffc4d6] p-2 text-sm" />
                  <select value={editForm.category} onChange={(e) => setEditForm((f) => ({ ...f, category: e.target.value }))} className="w-full rounded-lg border border-[#ffc4d6] p-2 text-sm">
                    {LINK_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <div className="flex gap-2">
                    <button onClick={() => saveEdit(link.id)} className="rounded-lg bg-[#ff87ab] px-3 py-1.5 text-xs font-medium text-slate-900">Save</button>
                    <button onClick={() => setEditingId(null)} className="rounded-lg border border-[#ffc4d6] px-3 py-1.5 text-xs text-slate-600">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <a href={link.url} target="_blank" rel="noreferrer" className="font-medium text-[#ff5d8f] hover:underline">{link.label}</a>
                      {link.category && <span className="rounded-full bg-[#fadde1] px-2 py-0.5 text-xs text-[#ff5d8f]">{link.category}</span>}
                    </div>
                    {link.notes && <p className="mt-1 text-slate-500">{link.notes}</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => copyToClipboard(link.url)} title="Copy link" className="text-slate-400 hover:text-[#ff5d8f]"><Copy size={14} /></button>
                    <button onClick={() => startEdit(link)} title="Edit link" className="text-slate-400 hover:text-[#ff5d8f]"><Pencil size={14} /></button>
                    <button onClick={() => deleteLink(link.id)} title="Delete link" className="text-slate-400 hover:text-rose-600"><Trash2 size={14} /></button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
