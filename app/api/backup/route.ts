import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { prisma, resolvedDatabaseFilePath } from '@/lib/prisma';
import { createDatabaseBackup, resolveBackupPath } from '@/lib/db-backup';

const dataDir = path.resolve(process.cwd(), 'data');
const dbPath = path.resolve(dataDir, 'dev.db');

export async function GET() {
  if (!resolvedDatabaseFilePath) {
    return NextResponse.json({ error: 'File backup download is only available for local SQLite databases. Use the app export flow for Supabase/Postgres.' }, { status: 501 });
  }

  if (!fs.existsSync(dbPath)) {
    return NextResponse.json({ error: 'Database not found' }, { status: 404 });
  }

  // VACUUM INTO — not a raw fs copy — so a download can never miss rows
  // still sitting in the separate -wal file under Prisma's default WAL
  // mode (see lib/db-backup.ts). The downloaded bytes are read back from
  // that consistent snapshot, never from the live file directly.
  let backup: { fileName: string };
  try {
    backup = await createDatabaseBackup(prisma);
  } catch (error) {
    return NextResponse.json({ error: `Backup failed: ${error instanceof Error ? error.message : 'unknown error'}` }, { status: 500 });
  }
  const buffer = fs.readFileSync(resolveBackupPath(backup.fileName));
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="recruiting-tracker.db"',
    },
  });
}

export async function POST(request: Request) {
  if (!resolvedDatabaseFilePath) {
    return NextResponse.json({ error: 'SQLite database restore is only available for local SQLite databases. Use the workbook import/restore flow for Supabase/Postgres.' }, { status: 501 });
  }

  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'File required' }, { status: 400 });

  let backup: { fileName: string };
  try {
    backup = await createDatabaseBackup(prisma);
  } catch (error) {
    return NextResponse.json({ error: `Backup failed, restore aborted: ${error instanceof Error ? error.message : 'unknown error'}` }, { status: 500 });
  }

  // The live connection must be closed before the underlying file is
  // replaced out from under it — otherwise Prisma's open WAL-mode
  // connection can reintroduce stale pages or corrupt the swapped-in file.
  await prisma.$disconnect();

  const tempPath = path.resolve(dataDir, `dev.db.restore-${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, Buffer.from(await file.arrayBuffer()));
  fs.renameSync(tempPath, dbPath);

  for (const suffix of ['-wal', '-shm']) {
    const companionPath = path.resolve(dataDir, `dev.db${suffix}`);
    if (fs.existsSync(companionPath)) fs.unlinkSync(companionPath);
  }

  return NextResponse.json({ restored: true, backup });
}
