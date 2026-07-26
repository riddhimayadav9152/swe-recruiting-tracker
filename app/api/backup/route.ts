import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'data/dev.db');

export async function GET() {
  if (!fs.existsSync(dbPath)) {
    return NextResponse.json({ error: 'Database not found' }, { status: 404 });
  }
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
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ restored: true });
}
