import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { previewJsonImport } from '@/lib/json-import';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('json' in body)) {
    return NextResponse.json({ error: 'Request body must be { json: <parsed or string JSON> }' }, { status: 400 });
  }

  let raw: unknown = (body as { json: unknown }).json;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (error) {
      return NextResponse.json({ error: `Invalid JSON: ${error instanceof Error ? error.message : 'could not parse'}` }, { status: 400 });
    }
  }

  const existingApplications = await prisma.application.findMany({ select: { id: true, company: true, role: true, applicationUrl: true } });
  const result = previewJsonImport(raw, existingApplications);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const summary = {
    total: result.rows.length,
    valid: result.rows.filter((r) => r.status === 'valid').length,
    invalid: result.rows.filter((r) => r.status === 'invalid').length,
    duplicates: result.rows.filter((r) => r.duplicate).length,
  };

  return NextResponse.json({ rows: result.rows, summary });
}
