import { isDeadlineOverdue, resolveDeadlineInstant, type DeadlineKind } from '@/lib/dates';

/**
 * Shared personal-deadline ordering, used by both the Dashboard's
 * "Upcoming deadlines" card and the Deadlines tab so they never drift apart:
 * overdue personal actions first, then ascending by the personal
 * `nextActionDue` — the official `applicationDeadline` is context only, never
 * part of the sort key.
 */
export type DeadlineSortable = {
  nextActionDue: string | null;
  nextActionDueKind: DeadlineKind;
};

export const isPersonalDeadlineOverdue = (item: DeadlineSortable, timeZone: string, now: Date = new Date()): boolean =>
  item.nextActionDue ? isDeadlineOverdue(item.nextActionDue, item.nextActionDueKind, timeZone, now) : false;

export function sortByPersonalDeadline<T extends DeadlineSortable>(items: T[], timeZone: string, now: Date = new Date()): T[] {
  return [...items].sort((a, b) => {
    const aOverdue = isPersonalDeadlineOverdue(a, timeZone, now);
    const bOverdue = isPersonalDeadlineOverdue(b, timeZone, now);
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;

    const aInstant = a.nextActionDue ? resolveDeadlineInstant(a.nextActionDue, a.nextActionDueKind, timeZone) : null;
    const bInstant = b.nextActionDue ? resolveDeadlineInstant(b.nextActionDue, b.nextActionDueKind, timeZone) : null;
    if (aInstant && bInstant) return aInstant.getTime() - bInstant.getTime();
    if (aInstant) return -1;
    if (bInstant) return 1;
    return 0;
  });
}
