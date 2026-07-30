/**
 * Deterministically picks the "current" record out of a one-to-many set
 * (an application's Assessments, or its Interviews) for display/export
 * purposes where only a single denormalized representative is wanted —
 * never depends on whatever order the database happened to return the
 * relation array in.
 *
 * "Current" is defined as: the record with the LATEST value in
 * `dateField` (dueAt for Assessments, scheduledStart for Interviews) —
 * i.e. the most recent/most-future round a candidate is dealing with, on
 * the theory that later rounds have later scheduled dates. A record with
 * no date at all sorts last. Ties (including "nobody has a date") are
 * broken by `id` — Prisma's default `cuid()` ids are lexicographically
 * increasing with creation order, so the highest id is the most recently
 * created record, giving a stable, well-defined answer even when nothing
 * else distinguishes two rows.
 */
export function selectCurrentRecord<T extends { id: string }>(records: T[], dateField: keyof T): T | null {
  if (!records.length) return null;
  return [...records].sort((a, b) => {
    const aValue = a[dateField] as unknown as Date | null;
    const bValue = b[dateField] as unknown as Date | null;
    const aTime = aValue ? aValue.getTime() : -Infinity;
    const bTime = bValue ? bValue.getTime() : -Infinity;
    if (aTime !== bTime) return bTime - aTime;
    return b.id.localeCompare(a.id);
  })[0];
}

export const selectCurrentAssessment = <T extends { id: string; dueAt: Date | null }>(assessments: T[]): T | null => selectCurrentRecord(assessments, 'dueAt');

export const selectCurrentInterview = <T extends { id: string; scheduledStart: Date | null }>(interviews: T[]): T | null => selectCurrentRecord(interviews, 'scheduledStart');
