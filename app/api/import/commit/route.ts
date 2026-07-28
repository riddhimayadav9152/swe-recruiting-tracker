import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { commitImportRow, validateNormalizedImportRow, type ImportRowDecision } from '@/lib/import';

type CommitRequestRow = {
  rowNumber: number;
  action: ImportRowDecision;
  data: unknown;
  matchedApplicationId?: string | null;
};

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.rows)) {
    return NextResponse.json({ error: 'rows array is required' }, { status: 400 });
  }

  const existingCodes = (await prisma.application.findMany({ select: { applicationCode: true } })).map((item) => item.applicationCode);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: Array<{ rowNumber: number; errors: string[] }> = [];

  for (const row of body.rows as CommitRequestRow[]) {
    if (row.action === 'skip') {
      skipped += 1;
      continue;
    }

    const validated = validateNormalizedImportRow(row.data);
    if (!validated.ok) {
      errors.push({ rowNumber: row.rowNumber, errors: validated.errors });
      continue;
    }

    const outcome = await commitImportRow(prisma, row.action, validated.data, existingCodes, row.matchedApplicationId ?? null);
    if (!outcome.ok) {
      errors.push({ rowNumber: row.rowNumber, errors: outcome.errors });
      continue;
    }

    if (outcome.action === 'update') updated += 1;
    else created += 1;
  }

  return NextResponse.json({ created, updated, skipped, errors });
}
