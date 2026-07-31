'use client';

import { formatDistanceToNow } from 'date-fns';
import type { ActivityRecord } from './types';

/**
 * A chronological record of everything that's happened to an application —
 * status transitions, OA/interview milestones, offers, notes, contacts, and
 * general edits are ALL captured as Activity rows by the workflow layer
 * (see lib/workflows/applications.ts), so this is just a straightforward
 * newest-first render of that history — no separate reconstruction logic.
 */
export function Timeline({ activities }: { activities: ActivityRecord[] }) {
  const sorted = [...activities].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (!sorted.length) {
    return <p className="text-sm text-slate-500">No activity recorded yet.</p>;
  }

  return (
    <ol className="space-y-3" data-testid="application-timeline">
      {sorted.map((activity) => (
        <li key={activity.id} className="relative rounded-lg border border-[#ffcad4] bg-white p-3 pl-4 text-sm shadow-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium text-slate-800">{activity.eventType}</span>
            <span className="text-xs text-slate-400" title={new Date(activity.createdAt).toLocaleString()}>
              {formatDistanceToNow(new Date(activity.createdAt), { addSuffix: true })}
            </span>
          </div>
          <p className="mt-1 text-slate-600">{activity.summary}</p>
          {(activity.previousStatus || activity.newStatus) && activity.previousStatus !== activity.newStatus && (
            <p className="mt-1 text-xs text-slate-400">
              {activity.previousStatus ?? '—'} → {activity.newStatus ?? '—'}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
