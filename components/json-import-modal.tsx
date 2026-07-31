'use client';

import { useRef, useState } from 'react';
import { toast } from 'react-hot-toast';

const FORMAT_EXAMPLE = {
  format: 'swe-recruiting-tracker.application-import.v1',
  applications: [
    {
      company: 'Example Company',
      role: 'Software Engineering Intern',
      jobId: null,
      applicationUrl: 'https://company.com/jobs/123',
      candidatePortalUrl: null,
      priority: 'P0',
      status: 'Not Applied',
      postingStatus: 'Open',
      location: 'New York, NY',
      workModel: 'Hybrid',
      postingDate: '2026-07-29',
      applicationDeadline: null,
      dateFound: '2026-07-29',
      nextAction: 'Tailor and submit application',
      nextActionDue: '2026-07-31',
      nextActionDueKind: 'date',
      loginEmail: null,
      portalUsername: null,
      passwordManagerReference: null,
      confirmationNumber: null,
      compensationSummary: null,
      eligibility: 'December 2027 graduates eligible',
      sponsorship: 'U.S. work authorization required',
      whyFit: 'Strong backend and distributed-systems fit.',
      notes: 'Application information verified July 29, 2026.',
      links: [
        { label: 'Company careers page', url: 'https://company.com/careers', category: 'Company', notes: null },
      ],
    },
  ],
};

type PreviewRow = {
  index: number;
  status: 'valid' | 'invalid';
  data: Record<string, unknown> | null;
  errors: Array<{ field: string; message: string }>;
  duplicate: { source: string; matchedOn: string; applicationId?: string; index?: number } | null;
  suggestedAction: 'create' | 'update' | 'skip' | 'error';
  generatedNextActionDue: { value: string; kind: string } | null;
};

export function JsonImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => Promise<void> | void }) {
  const [raw, setRaw] = useState('');
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [decisions, setDecisions] = useState<Record<number, 'create' | 'update' | 'skip'>>({});
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const copyExample = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(FORMAT_EXAMPLE, null, 2));
      toast.success('Format example copied');
    } catch {
      toast.error('Unable to copy — select and copy the example manually');
    }
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRaw(text);
    event.target.value = '';
  };

  const previewImport = async () => {
    setLoading(true);
    setRows(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        toast.error(`Invalid JSON: ${error instanceof Error ? error.message : 'could not parse'}`);
        return;
      }
      const response = await fetch('/api/import/json/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: parsed }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data.error ?? 'Preview failed');
        return;
      }
      setRows(data.rows);
      const initialDecisions: Record<number, 'create' | 'update' | 'skip'> = {};
      for (const row of data.rows as PreviewRow[]) {
        if (row.status === 'valid') initialDecisions[row.index] = row.suggestedAction === 'skip' ? 'skip' : 'create';
      }
      setDecisions(initialDecisions);
    } finally {
      setLoading(false);
    }
  };

  const confirmImport = async () => {
    if (!rows) return;
    setLoading(true);
    try {
      const payload = rows
        .filter((row) => row.status === 'valid')
        .map((row) => ({
          index: row.index,
          action: decisions[row.index] ?? 'skip',
          data: row.data,
          matchedApplicationId: row.duplicate?.source === 'database' ? row.duplicate.applicationId ?? null : null,
        }));
      const response = await fetch('/api/import/json/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: payload }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data.error ?? 'Import failed');
        return;
      }
      toast.success(`Imported: ${data.created} created, ${data.updated} updated, ${data.skipped} skipped`);
      onClose();
      await onImported();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold">Paste Application Import</h3>
        <p className="mt-1 text-sm text-slate-500">
          Paste a JSON document describing one or more applications (the exact structure future ChatGPT recommendations will use), or upload a .json file.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={copyExample} className="rounded-lg border border-[#ffc4d6] bg-white px-3 py-2 text-sm text-slate-600 transition hover:bg-[#fadde1]">Copy format example</button>
          <button onClick={() => fileInputRef.current?.click()} className="rounded-lg border border-[#ffc4d6] bg-white px-3 py-2 text-sm text-slate-600 transition hover:bg-[#fadde1]">Upload .json file</button>
          <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={handleUpload} className="hidden" />
        </div>

        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={10}
          placeholder="Paste JSON here…"
          className="mt-3 w-full rounded-lg border border-[#ffc4d6] bg-white p-3 font-mono text-xs outline-none focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]"
        />

        <div className="mt-3 flex justify-end">
          <button onClick={previewImport} disabled={loading || !raw.trim()} className="rounded-lg bg-[#ff87ab] px-4 py-2 text-sm font-medium text-slate-900 shadow-sm disabled:opacity-50">
            {loading ? 'Validating…' : 'Validate and Preview'}
          </button>
        </div>

        {rows && (
          <div className="mt-4 space-y-3" data-testid="json-import-preview">
            <p className="text-sm text-slate-600">{rows.filter((r) => r.status === 'valid').length} valid, {rows.filter((r) => r.status === 'invalid').length} invalid</p>
            {rows.map((row) => (
              <div key={row.index} className="rounded-lg border border-[#ffcad4] p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    Row {row.index + 1}: {row.data ? `${row.data.company as string} — ${row.data.role as string}` : '(invalid)'}
                  </span>
                  {row.status === 'valid' && (
                    <select
                      data-testid="json-import-row-action"
                      value={decisions[row.index] ?? 'skip'}
                      onChange={(e) => setDecisions((prev) => ({ ...prev, [row.index]: e.target.value as 'create' | 'update' | 'skip' }))}
                      className="rounded-lg border border-[#ffc4d6] bg-white p-1.5 text-xs"
                    >
                      <option value="skip">Skip</option>
                      <option value="create">Create</option>
                      {row.duplicate?.source === 'database' && <option value="update">Update existing</option>}
                    </select>
                  )}
                </div>
                {row.status === 'invalid' && (
                  <div className="mt-2 space-y-1" data-testid="json-import-row-errors">
                    {row.errors.map((error, index) => (
                      <p key={index} className="text-xs text-rose-600">{error.field}: {error.message}</p>
                    ))}
                  </div>
                )}
                {row.duplicate && (
                  <p className="mt-2 text-xs text-amber-700" data-testid="json-import-duplicate-warning">
                    Possible duplicate ({row.duplicate.matchedOn}) — {row.duplicate.source === 'database' ? 'matches an existing application' : `matches row ${(row.duplicate.index ?? 0) + 1} in this import`}.
                  </p>
                )}
                {row.generatedNextActionDue && (
                  <p className="mt-2 text-xs text-slate-500">Personal next-action due will default to {row.generatedNextActionDue.value} (no date was supplied).</p>
                )}
              </div>
            ))}

            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="rounded-lg border border-[#ffc4d6] bg-white px-4 py-2 text-sm text-slate-600">Cancel</button>
              <button onClick={confirmImport} disabled={loading} className="rounded-lg bg-[#ff87ab] px-4 py-2 text-sm font-medium text-slate-900 shadow-sm disabled:opacity-50">
                {loading ? 'Importing…' : 'Confirm Import'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
