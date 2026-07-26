import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { prisma } from '@/lib/prisma';
import { parseExcelDateValue } from '@/lib/recruiting';
import { createApplicationRecord } from '@/lib/workflows/applications';

const toIsoString = (value: unknown) => {
  const parsed = parseExcelDateValue(value);
  return parsed ? parsed.toISOString() : null;
};

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'File required' }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet) as Array<Record<string, unknown>>;

  const existingCodes = await prisma.application.findMany({ select: { applicationCode: true } });
  const existingCodeValues = existingCodes.map((item) => item.applicationCode);
  let imported = 0;

  for (const row of rows) {
    const company = String(row.Company ?? row.company ?? '').trim();
    if (!company) continue;
    const role = String(row.Role ?? row.role ?? '').trim();
    const created = await createApplicationRecord(prisma, {
      company,
      role,
      applicationUrl: String(row.URL ?? row.url ?? ''),
      priority: String(row.Priority ?? row.priority ?? 'P2') as 'P0' | 'P1' | 'P2' | 'P3',
      status: String(row.Status ?? row.status ?? 'Not Applied') as 'Not Applied' | 'Preparing' | 'Applied' | 'OA' | 'Recruiter Screen' | 'Technical Interview' | 'Final Round' | 'Offer' | 'Accepted' | 'Rejected' | 'Withdrawn' | 'Closed',
      currentStage: String(row['Current Stage'] ?? row.currentStage ?? 'Imported'),
      location: String(row.Location ?? row.location ?? '') || null,
      applicationDeadline: toIsoString(row['Application Deadline'] ?? row.applicationDeadline),
      dateFound: toIsoString(row['Date Found'] ?? row.dateFound),
      notes: String(row.Notes ?? row.notes ?? ''),
    }, existingCodeValues);
    existingCodeValues.push(created.applicationCode);
    imported += 1;
  }

  return NextResponse.json({ imported });
}
