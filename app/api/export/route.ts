import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { format } from 'date-fns';
import { prisma } from '@/lib/prisma';
import { buildExportWorkbook, loadExportData } from '@/lib/export';

export async function GET() {
  const data = await loadExportData(prisma);
  const workbook = buildExportWorkbook(data);
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Riddhima_2027_SWE_Tracker_${format(new Date(), 'yyyy-MM-dd')}.xlsx"`,
    },
  });
}
