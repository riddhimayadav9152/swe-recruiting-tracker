import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { prisma } from '@/lib/prisma';
import { generateApplicationCode, generateNextAction } from '@/lib/recruiting';

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'File required' }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet) as Array<Record<string, unknown>>;

  for (const row of rows.slice(0, 20)) {
    const company = String(row.Company ?? row.company ?? '').trim();
    if (!company) continue;
    const role = String(row.Role ?? row.role ?? '').trim();
    await prisma.application.create({
      data: {
        applicationCode: generateApplicationCode(company, role),
        company,
        role,
        status: String(row.Status ?? row.status ?? 'Not Applied'),
        currentStage: String(row['Current Stage'] ?? row.currentStage ?? 'Imported'),
        priority: String(row.Priority ?? row.priority ?? 'P2'),
        applicationUrl: String(row.URL ?? row.url ?? ''),
        notes: String(row.Notes ?? row.notes ?? ''),
        nextAction: generateNextAction('Not Applied' as never),
        nextActionDue: new Date(Date.now() + 2 * 86400000),
      },
    });
  }

  return NextResponse.json({ imported: rows.length });
}
