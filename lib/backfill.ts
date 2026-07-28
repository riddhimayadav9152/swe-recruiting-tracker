import type { PrismaClient } from '@prisma/client';

// The only workflows that ever populate `Application.nextActionDue` from a
// date-only source (see lib/workflows/applications.ts) are:
//   - createApplicationRecord / import, which copies it straight from
//     `applicationDeadline`.
//   - offerWorkflow, which copies it straight from the offer's own
//     `decisionDeadline`.
//   - interviewCompletedWorkflow, when a `followUpDate` was supplied, which
//     copies it straight from the interview's own `followUpDate`.
// Every other workflow sets a real timestamp. So a row is only reclassified
// as 'date' when its CURRENT nextActionDue still exactly matches one of
// those three date-only sources — anything else keeps the safe 'timestamp'
// default untouched, rather than guessing.
export type BackfillCategory = 'applicationDeadline' | 'offerDecisionDeadline' | 'interviewFollowUpDate';

export type BackfillResult = {
  updated: number;
  byCategory: Record<BackfillCategory, number>;
};

export async function backfillNextActionDueKind(prisma: PrismaClient): Promise<BackfillResult> {
  const byCategory: Record<BackfillCategory, number> = {
    applicationDeadline: 0,
    offerDecisionDeadline: 0,
    interviewFollowUpDate: 0,
  };

  const candidates = await prisma.application.findMany({
    where: { nextActionDue: { not: null }, nextActionDueKind: { not: 'date' } },
    include: { offers: true, interviews: true },
  });

  let updated = 0;
  for (const application of candidates) {
    const dueTime = application.nextActionDue?.getTime();
    if (dueTime === undefined) continue;

    let category: BackfillCategory | null = null;
    if (application.applicationDeadline && application.applicationDeadline.getTime() === dueTime) {
      category = 'applicationDeadline';
    } else if (application.offers?.decisionDeadline && application.offers.decisionDeadline.getTime() === dueTime) {
      category = 'offerDecisionDeadline';
    } else if (application.interviews.some((interview) => interview.followUpDate && interview.followUpDate.getTime() === dueTime)) {
      category = 'interviewFollowUpDate';
    }

    if (!category) continue;
    await prisma.application.update({ where: { id: application.id }, data: { nextActionDueKind: 'date' } });
    byCategory[category] += 1;
    updated += 1;
  }

  return { updated, byCategory };
}
