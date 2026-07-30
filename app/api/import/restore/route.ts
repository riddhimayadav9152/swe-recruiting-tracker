import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createDatabaseBackup } from '@/lib/db-backup';
import { commitMultiSheetImport, parseMultiSheetWorkbook, type RestoreMode } from '@/lib/multi-sheet-import';

const RESTORE_MODES: readonly RestoreMode[] = ['empty', 'replace', 'merge'];

/**
 * Restores a FULL export workbook (every sheet — Applications, Job
 * Descriptions, Assessments, Interviews, Offers, Contacts, Notes, Activity
 * History, Resume Versions, Profile) keyed by Application Code. This is a
 * separate, additive pathway from /api/import/preview + /api/import/commit
 * (the manually-reviewed, Applications-only importer) — it's meant for
 * disaster recovery / moving to a fresh database from this app's own
 * export, not for reviewing rows one at a time. See lib/multi-sheet-import.ts
 * for the strict validate-everything-then-write-atomically behavior and
 * what each `mode` does.
 */
export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'File required' }, { status: 400 });

  const modeRaw = formData.get('mode');
  if (typeof modeRaw !== 'string' || !RESTORE_MODES.includes(modeRaw as RestoreMode)) {
    return NextResponse.json({ error: `mode is required and must be one of: ${RESTORE_MODES.join(', ')}` }, { status: 400 });
  }
  const mode = modeRaw as RestoreMode;

  // A backup happens before ANY write attempt, same as the row-by-row
  // importer — only a bare, safe fileName is ever returned to the client
  // (see lib/db-backup.ts); the full server-side path never leaves the
  // server. commitMultiSheetImport itself performs zero writes if
  // validation fails, but the backup is taken unconditionally regardless,
  // matching this app's established "always back up before attempting any
  // commit" policy.
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

  const summary = await commitMultiSheetImport(prisma, parsed, mode);
  // 422 (Unprocessable Entity) — a well-formed request that failed
  // validation, distinct from 400 (malformed request) and 200 (success) —
  // the response body still carries the full structured sheet/row/message
  // detail (and the backup filename) either way.
  return NextResponse.json({ ...summary, backup }, { status: summary.ok ? 200 : 422 });
}
