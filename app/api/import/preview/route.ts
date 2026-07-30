import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { selectCurrentAssessment, selectCurrentInterview } from '@/lib/current-record';
import {
  autoDetectColumnMap,
  buildImportPreview,
  detectHeaders,
  IMPORT_TARGET_FIELDS,
  parseWorkbookSheetNames,
  readWorkbookSheetRows,
  type ColumnMap,
  type ExistingApplicationRecord,
  type ImportTargetField,
} from '@/lib/import';

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'File required' }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const { sheetNames } = parseWorkbookSheetNames(buffer);
  if (!sheetNames.length) return NextResponse.json({ error: 'Workbook has no sheets' }, { status: 400 });

  const requestedSheet = formData.get('sheetName');
  const sheetName = typeof requestedSheet === 'string' && sheetNames.includes(requestedSheet) ? requestedSheet : sheetNames[0];

  const { rows, cellFormats } = readWorkbookSheetRows(buffer, sheetName);
  const headers = detectHeaders(rows);

  let columnMap = autoDetectColumnMap(headers);
  const overridesRaw = formData.get('columnMapOverrides');
  if (typeof overridesRaw === 'string' && overridesRaw.trim()) {
    try {
      const overrides = JSON.parse(overridesRaw) as Partial<ColumnMap>;
      columnMap = { ...columnMap, ...overrides };
    } catch {
      return NextResponse.json({ error: 'columnMapOverrides must be valid JSON' }, { status: 400 });
    }
  }
  // Never trust a mapped header name that isn't actually in this sheet.
  for (const field of IMPORT_TARGET_FIELDS as readonly ImportTargetField[]) {
    if (columnMap[field] && !headers.includes(columnMap[field] as string)) columnMap[field] = null;
  }

  const nextActionDueKindRaw = formData.get('nextActionDueKindOverride');
  const nextActionDueKindOverride = nextActionDueKindRaw === 'date' || nextActionDueKindRaw === 'timestamp' ? nextActionDueKindRaw : null;

  const [existingApplicationsRaw, existingResumeVersions] = await Promise.all([
    prisma.application.findMany({
      select: {
        id: true, company: true, role: true, applicationUrl: true, priority: true, status: true, currentStage: true, location: true,
        applicationDeadline: true, dateFound: true, dateApplied: true, notes: true, nextAction: true, nextActionDue: true, nextActionDueKind: true, outcome: true,
        resumeVersion: { select: { name: true } },
        assessments: { where: { type: 'OA' }, select: { id: true, dueAt: true, timezone: true, platform: true } },
        interviews: { select: { id: true, stage: true, scheduledStart: true, timezone: true } },
        offers: { select: { offerDate: true, decisionDeadline: true, compensationSummary: true, notes: true } },
      },
    }),
    prisma.resumeVersion.findMany({ select: { id: true, name: true } }),
  ]);
  const existingApplications: ExistingApplicationRecord[] = existingApplicationsRaw.map((app) => {
    const currentAssessment = selectCurrentAssessment(app.assessments);
    const currentInterview = selectCurrentInterview(app.interviews.filter((interview) => interview.stage === app.currentStage));
    return {
      ...app,
      resumeVersionName: app.resumeVersion?.name ?? null,
      currentAssessment: currentAssessment ? { dueAt: currentAssessment.dueAt, timezone: currentAssessment.timezone, platform: currentAssessment.platform } : null,
      currentInterview: currentInterview ? { stage: currentInterview.stage, scheduledStart: currentInterview.scheduledStart, timezone: currentInterview.timezone } : null,
      offer: app.offers ? { offerDate: app.offers.offerDate, decisionDeadline: app.offers.decisionDeadline, compensationSummary: app.offers.compensationSummary, notes: app.offers.notes } : null,
    };
  });

  const preview = buildImportPreview(rows, columnMap, existingApplications, existingResumeVersions, { cellFormats, nextActionDueKindOverride });

  const summary = {
    total: preview.length,
    valid: preview.filter((row) => row.status === 'valid').length,
    invalid: preview.filter((row) => row.status === 'invalid').length,
    blank: preview.filter((row) => row.status === 'blank').length,
    duplicatesDatabase: preview.filter((row) => row.duplicate?.source === 'database').length,
    duplicatesWorkbook: preview.filter((row) => row.duplicate?.source === 'workbook').length,
    warnings: preview.filter((row) => row.warnings.length > 0).length,
  };

  return NextResponse.json({ sheetNames, sheetName, headers, columnMap, nextActionDueKindOverride, rows: preview, summary });
}
