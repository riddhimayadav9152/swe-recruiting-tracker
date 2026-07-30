import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { createDatabaseBackup } from '@/lib/db-backup';
import {
  commitImportRow,
  commitImportRowInTransaction,
  validateNormalizedImportRow,
  IMPORT_TARGET_FIELDS,
  type CommittableImportRowAction,
  type FieldPresenceMap,
  type ImportTargetField,
} from '@/lib/import';

const fieldPresenceSchema = z.record(z.enum(['supplied', 'blank', 'unmapped'])) as z.ZodType<Partial<FieldPresenceMap>>;

const resumeVersionDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('existing'), resumeVersionId: z.string().trim().min(1) }),
  z.object({ action: z.literal('create'), name: z.string().trim().min(1), targetType: z.string().trim().min(1) }),
  z.object({ action: z.literal('blank') }),
]);

// The full set of decisions the preview UI can send back; 'skip' is valid
// input but is handled before ever reaching commitImportRow (see below) —
// any OTHER string is rejected outright rather than silently ignored or
// coerced into some default action.
const commitRowSchema = z.object({
  rowNumber: z.number().int().positive(),
  action: z.enum(['create', 'update', 'skip', 'importAnyway']),
  data: z.record(z.unknown()),
  fieldPresence: fieldPresenceSchema.optional(),
  matchedApplicationId: z.string().trim().min(1).nullable().optional(),
  confirmedClears: z.array(z.enum(IMPORT_TARGET_FIELDS)).optional(),
  resumeVersionDecision: resumeVersionDecisionSchema.optional(),
});

const commitRequestSchema = z.object({
  mode: z.enum(['per-row', 'batch']).default('per-row'),
  rows: z.array(commitRowSchema),
});

const normalizeKey = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

/**
 * Re-verifies a client-supplied matchedApplicationId against the CURRENT
 * database, independent of whatever the preview step said — the preview
 * could be stale (another change happened after it ran, or a client simply
 * fabricated an id) by the time commit actually runs. A matched row must
 * still exist and must still match by company+role or applicationUrl;
 * otherwise Update existing is rejected outright rather than silently
 * updating (or worse, being redirected to) the wrong record.
 */
async function verifyMatchedApplication(matchedApplicationId: string, candidateCompany: string, candidateRole: string, candidateUrl: string) {
  const existing = await prisma.application.findUnique({ where: { id: matchedApplicationId }, select: { id: true, company: true, role: true, applicationUrl: true } });
  if (!existing) return { ok: false as const, reason: 'The matched application no longer exists — it may have been deleted since preview.' };

  const sameUrl = existing.applicationUrl && normalizeKey(existing.applicationUrl) === normalizeKey(candidateUrl);
  const sameCompanyRole = normalizeKey(existing.company) === normalizeKey(candidateCompany) && normalizeKey(existing.role) === normalizeKey(candidateRole);
  if (!sameUrl && !sameCompanyRole) {
    return { ok: false as const, reason: 'The matched application no longer matches this row by company+role or application URL — it may have changed since preview.' };
  }
  return { ok: true as const };
}

export async function POST(request: Request) {
  const rawBody = await request.json().catch(() => null);
  const parsedRequest = commitRequestSchema.safeParse(rawBody);
  if (!parsedRequest.success) {
    return NextResponse.json({ error: 'Invalid commit request', issues: parsedRequest.error.issues.map((issue) => issue.message) }, { status: 400 });
  }
  const { mode, rows } = parsedRequest.data;

  // A backup happens before ANY writes, every time, regardless of commit
  // mode — if it fails, the whole import is aborted rather than proceeding
  // without a safety net. Only a bare, safe fileName is ever returned to
  // the client — never the full server-side path (see lib/db-backup.ts).
  let backup: { fileName: string };
  try {
    backup = await createDatabaseBackup();
  } catch (error) {
    return NextResponse.json({ error: `Backup failed, import aborted: ${error instanceof Error ? error.message : 'unknown error'}` }, { status: 500 });
  }

  const existingCodes = (await prisma.application.findMany({ select: { applicationCode: true } })).map((item) => item.applicationCode);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: Array<{ rowNumber: number; errors: string[] }> = [];

  const prepareRow = async (row: (typeof rows)[number]) => {
    const validated = validateNormalizedImportRow(row.data);
    if (!validated.ok) return { ok: false as const, errors: validated.errors };

    if (row.action === 'update') {
      if (!row.matchedApplicationId) return { ok: false as const, errors: ['No matching existing application to update'] };
      const verification = await verifyMatchedApplication(row.matchedApplicationId, validated.data.company, validated.data.role, validated.data.applicationUrl);
      if (!verification.ok) return { ok: false as const, errors: [verification.reason] };
    }

    // Note: 'create' rows are re-checked for a duplicate against the CURRENT
    // database inside commitImportRow/commitImportRowInTransaction itself
    // (see lib/import.ts's writeImportRow) — that check runs against the
    // SAME transaction used to write the row, so it also sees duplicates
    // created earlier in this very batch, not just what existed when this
    // function ran. 'importAnyway' is the only action that intentionally
    // skips it.
    return { ok: true as const, data: validated.data };
  };

  if (mode === 'batch') {
    // Entire-batch mode: one transaction wraps every row's writes — if any
    // row fails (validation OR a database error), the whole batch throws
    // and Prisma rolls back everything, including rows that "succeeded"
    // earlier in this same loop.
    try {
      await prisma.$transaction(async (tx) => {
        for (const row of rows) {
          if (row.action === 'skip') {
            skipped += 1;
            continue;
          }
          const prepared = await prepareRow(row);
          if (!prepared.ok) throw new Error(`Row ${row.rowNumber}: ${prepared.errors.join('; ')}`);

          const outcome = await commitImportRowInTransaction(
            tx,
            row.action as CommittableImportRowAction,
            prepared.data,
            existingCodes,
            row.matchedApplicationId ?? null,
            row.fieldPresence as FieldPresenceMap | undefined,
            { resumeVersionDecision: row.resumeVersionDecision, confirmedClears: row.confirmedClears as ImportTargetField[] | undefined },
          );
          if (outcome.action === 'update') updated += 1;
          else created += 1;
        }
      });
    } catch (error) {
      return NextResponse.json({
        created: 0,
        updated: 0,
        skipped: 0,
        errors: [{ rowNumber: 0, errors: [error instanceof Error ? error.message : 'Batch import failed — no rows were written'] }],
        mode,
        backup,
      }, { status: 200 });
    }
  } else {
    // Per-row mode: each row gets its own transaction — a failure only
    // affects that row; earlier successes stay committed and later rows
    // are still attempted.
    for (const row of rows) {
      if (row.action === 'skip') {
        skipped += 1;
        continue;
      }

      const prepared = await prepareRow(row);
      if (!prepared.ok) {
        errors.push({ rowNumber: row.rowNumber, errors: prepared.errors });
        continue;
      }

      const outcome = await commitImportRow(
        prisma,
        row.action as CommittableImportRowAction,
        prepared.data,
        existingCodes,
        row.matchedApplicationId ?? null,
        row.fieldPresence as FieldPresenceMap | undefined,
        { resumeVersionDecision: row.resumeVersionDecision, confirmedClears: row.confirmedClears as ImportTargetField[] | undefined },
      );
      if (!outcome.ok) {
        errors.push({ rowNumber: row.rowNumber, errors: outcome.errors });
        continue;
      }

      if (outcome.action === 'update') updated += 1;
      else created += 1;
    }
  }

  return NextResponse.json({ created, updated, skipped, errors, mode, backup });
}
