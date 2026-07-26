import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { prisma } from '@/lib/prisma';
import { format } from 'date-fns';

export async function GET() {
  const applications = await prisma.application.findMany({
    include: { jobDescription: true, resumeVersion: true, interviews: true, contacts: true, activities: true },
  });
  const workbook = XLSX.utils.book_new();
  const appRows = applications.map((app: {
    applicationCode: string;
    company: string;
    role: string;
    status: string;
    currentStage: string | null;
    priority: string;
    applicationUrl: string | null;
    location: string | null;
    nextAction: string | null;
    nextActionDue: Date | null;
    dateApplied: Date | null;
    dateFound: Date | null;
    applicationDeadline: Date | null;
    notes: string | null;
  }) => ({
    id: app.applicationCode,
    company: app.company,
    role: app.role,
    status: app.status,
    stage: app.currentStage,
    priority: app.priority,
    applicationUrl: app.applicationUrl ?? '',
    location: app.location ?? '',
    nextAction: app.nextAction,
    nextActionDue: app.nextActionDue ? format(app.nextActionDue, 'yyyy-MM-dd') : '',
    dateApplied: app.dateApplied ? format(app.dateApplied, 'yyyy-MM-dd') : '',
    dateFound: app.dateFound ? format(app.dateFound, 'yyyy-MM-dd') : '',
    applicationDeadline: app.applicationDeadline ? format(app.applicationDeadline, 'yyyy-MM-dd') : '',
    notes: app.notes ?? '',
  }));
  const sheet = XLSX.utils.json_to_sheet(appRows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Applications');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Riddhima_2027_SWE_Tracker_${format(new Date(), 'yyyy-MM-dd')}.xlsx"`,
    },
  });
}
