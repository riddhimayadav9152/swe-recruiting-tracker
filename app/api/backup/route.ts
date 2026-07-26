import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const dataDir = path.resolve(process.cwd(), 'data');
const dbPath = path.resolve(dataDir, 'dev.db');
const backupDir = path.resolve(dataDir, 'backups');

const ensureDirectories = () => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
};

const createBackup = () => {
  if (!fs.existsSync(dbPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.resolve(backupDir, `dev-${stamp}.db`);
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
};

export async function GET() {
  ensureDirectories();
  if (!fs.existsSync(dbPath)) {
    return NextResponse.json({ error: 'Database not found' }, { status: 404 });
  }
  createBackup();
  const buffer = fs.readFileSync(dbPath);
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="recruiting-tracker.db"',
    },
  });
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'File required' }, { status: 400 });

  ensureDirectories();
  const backupPath = createBackup();
  const tempPath = path.resolve(dataDir, `dev.db.restore-${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, Buffer.from(await file.arrayBuffer()));
  fs.renameSync(tempPath, dbPath);

  for (const suffix of ['-wal', '-shm']) {
    const companionPath = path.resolve(dataDir, `dev.db${suffix}`);
    if (fs.existsSync(companionPath)) fs.unlinkSync(companionPath);
  }

  return NextResponse.json({ restored: true, backupPath: backupPath ? path.relative(process.cwd(), backupPath) : null });
}
