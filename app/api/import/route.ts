import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { prisma } from '@/lib/prisma';
import { validateImportRow } from '@/lib/import';
import { createApplicationRecord } from '@/lib/workflows/applications';

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'File required' }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet) as Array<Record<string, unknown>>;

  const existingCodes = (await prisma.application.findMany({ select: { applicationCode: true } })).map((item) => item.applicationCode);
  let imported = 0;
  const errors: Array<{ row: number; company: string; errors: string[] }> = [];

  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 2; // row 1 is the header
    const outcome = validateImportRow(rows[index]);
    if (outcome.ok === 'blank') continue;
    if (!outcome.ok) {
      errors.push({ row: rowNumber, company: String(rows[index]?.Company ?? rows[index]?.company ?? '(no company)'), errors: outcome.errors });
      continue;
    }

    try {
      const created = await createApplicationRecord(prisma, outcome.data, existingCodes);
      existingCodes.push(created.applicationCode);
      imported += 1;
    } catch (error) {
      errors.push({ row: rowNumber, company: outcome.data.company, errors: [error instanceof Error ? error.message : 'Unknown error creating this record'] });
    }
  }

  return NextResponse.json({ imported, errors });
}
