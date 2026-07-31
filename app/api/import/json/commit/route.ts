import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { createDatabaseBackup } from '@/lib/db-backup';
import { commitJsonImportBatch, type JsonImportRowDecision } from '@/lib/json-import';

const rowSchema = z.object({
  index: z.number().int().nonnegative(),
  action: z.enum(['create', 'update', 'skip']),
  data: z.record(z.unknown()),
  matchedApplicationId: z.string().trim().min(1).nullable().optional(),
});

const requestSchema = z.object({
  rows: z.array(rowSchema).min(1),
});

/**
 * Commits a "Paste Application Import" batch — see lib/json-import.ts for
 * the full validate-then-write contract. A database backup is always taken
 * first (same policy as every other commit pathway in this app), and the
 * whole batch is written in ONE transaction: any row failure (a stale
 * duplicate, a re-validation failure, a matched application that no longer
 * matches) rolls back everything, so nothing is ever partially imported.
 */
export async function POST(request: Request) {
  const rawBody = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid commit request', issues: parsed.error.issues.map((issue) => issue.message) }, { status: 400 });
  }

  let backup: { fileName: string };
  try {
    backup = await createDatabaseBackup();
  } catch (error) {
    return NextResponse.json({ error: `Backup failed, import aborted: ${error instanceof Error ? error.message : 'unknown error'}` }, { status: 500 });
  }

  try {
    const summary = await commitJsonImportBatch(prisma, parsed.data.rows as JsonImportRowDecision[]);
    return NextResponse.json({ ...summary, backup });
  } catch (error) {
    return NextResponse.json({ error: `Import failed — no rows were written: ${error instanceof Error ? error.message : 'unknown error'}`, backup }, { status: 422 });
  }
}
