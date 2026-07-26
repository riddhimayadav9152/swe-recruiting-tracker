import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateApplicationCode, generateNextAction, detectDuplicate, validateApplicationInput } from '@/lib/recruiting';

export async function GET() {
  const applications = await prisma.application.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      jobDescription: true,
      resumeVersion: true,
      interviews: true,
      assessments: true,
      contacts: true,
      notesRelation: true,
      activities: true,
      documents: true,
    },
  });
  return NextResponse.json(applications);
}

export async function POST(request: Request) {
  const body = await request.json();
  const errors = validateApplicationInput(body);
  if (Object.keys(errors).length) {
    return NextResponse.json({ errors }, { status: 400 });
  }
  const existing = await prisma.application.findMany({
    select: { company: true, role: true, applicationUrl: true },
  });
  const duplicate = detectDuplicate(existing, body);
  if (duplicate) {
    return NextResponse.json({ duplicate: true }, { status: 409 });
  }

  const created = await prisma.application.create({
    data: {
      applicationCode: generateApplicationCode(body.company, body.role),
      company: body.company,
      role: body.role,
      applicationUrl: body.applicationUrl,
      priority: body.priority,
      status: body.status ?? 'Not Applied',
      currentStage: body.currentStage ?? 'Discovered',
      location: body.location ?? null,
      applicationDeadline: body.applicationDeadline ? new Date(body.applicationDeadline) : null,
      dateFound: body.dateFound ? new Date(body.dateFound) : new Date(),
      notes: body.notes ?? '',
      nextAction: generateNextAction(body.status ?? 'Not Applied', body.currentStage ?? 'Discovered'),
      nextActionDue: body.applicationDeadline ? new Date(body.applicationDeadline) : new Date(Date.now() + 2 * 86400000),
    },
    include: { jobDescription: true, resumeVersion: true, interviews: true, assessments: true, contacts: true, notesRelation: true, activities: true, documents: true },
  });

  await prisma.activity.create({
    data: {
      applicationId: created.id,
      eventType: 'Opportunity created',
      previousStatus: null,
      newStatus: created.status,
      previousStage: null,
      newStage: created.currentStage,
      summary: `Added new opportunity for ${created.company}`,
      metadataJson: JSON.stringify({ priority: created.priority }),
    },
  });

  return NextResponse.json(created);
}
