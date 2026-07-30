import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createDatabaseBackup } from '@/lib/db-backup';
import { commitMultiSheetImport, parseMultiSheetWorkbook } from '@/lib/multi-sheet-import';

/**
 * Restores a FULL export workbook (every sheet — Applications, Job
 * Descriptions, Assessments, Interviews, Offers, Contacts, Notes, Activity
 * History, Resume Versions, Profile) in one atomic transaction, keyed by
 * Application Code. This is a separate, additive pathway from
 * /api/import/preview + /api/import/commit (the manually-reviewed,
 * Applications-only importer) — it's meant for disaster recovery / moving
 * to a fresh database from this app's own export, not for reviewing rows
 * one at a time. See lib/multi-sheet-import.ts.
 */
export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'File required' }, { status: 400 });

  // A backup happens before ANY writes, same as the row-by-row importer —
  // only a bare, safe fileName is ever returned to the client (see
  // lib/db-backup.ts); the full server-side path never leaves the server.
  let backup: { fileName: string };
  try {
    backup = await createDatabaseBackup();
  } catch (error) {
    return NextResponse.json({ error: `Backup failed, restore aborted: ${error instanceof Error ? error.message : 'unknown error'}` }, { status: 500 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let parsed;
  try {
    parsed = parseMultiSheetWorkbook(buffer);
  } catch (error) {
    return NextResponse.json({ error: `Could not read workbook: ${error instanceof Error ? error.message : 'unknown error'}`, backup }, { status: 400 });
  }

  const summary = await commitMultiSheetImport(prisma, parsed);
  return NextResponse.json({ ...summary, mode: 'atomic-batch', backup });
}
