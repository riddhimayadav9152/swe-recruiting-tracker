import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const application = await prisma.application.findUnique({
    where: { id },
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

  if (!application) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(application);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();
  const existing = await prisma.application.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
    status: existing.status,
    currentStage: existing.currentStage,
  };

  if (body.action === 'apply') {
    updateData.status = 'Applied';
    updateData.currentStage = 'Application Submitted';
    updateData.dateApplied = body.dateApplied ? new Date(body.dateApplied) : new Date();
    updateData.resumeVersionId = body.resumeVersionId ?? null;
    updateData.emailUsed = body.emailUsed ?? existing.emailUsed;
    updateData.nextAction = 'Monitor application and email';
    updateData.nextActionDue = body.nextActionDue ? new Date(body.nextActionDue) : new Date(Date.now() + 10 * 86400000);
    await prisma.activity.create({
      data: { applicationId: id, eventType: 'Application submitted', summary: 'Marked application as submitted', metadataJson: JSON.stringify(body) },
    });
  } else if (body.action === 'oa') {
    updateData.status = 'OA';
    updateData.currentStage = 'Online Assessment';
    updateData.nextAction = 'Prepare for and complete OA';
    updateData.nextActionDue = body.nextActionDue ? new Date(body.nextActionDue) : new Date(Date.now() + 3 * 86400000);
    await prisma.activity.create({
      data: { applicationId: id, eventType: 'OA received', summary: 'Recorded OA milestone', metadataJson: JSON.stringify(body) },
    });
  } else if (body.action === 'interview') {
    updateData.status = body.status ?? 'Technical Interview';
    updateData.currentStage = body.currentStage ?? 'Recruiter Screen';
    updateData.nextAction = `Prepare for ${body.currentStage ?? 'interview'}`;
    updateData.nextActionDue = body.nextActionDue ? new Date(body.nextActionDue) : new Date(Date.now() + 86400000);
    await prisma.activity.create({
      data: { applicationId: id, eventType: 'Interview scheduled', summary: 'Scheduled interview', metadataJson: JSON.stringify(body) },
    });
  } else if (body.action === 'reject') {
    updateData.status = 'Rejected';
    updateData.currentStage = 'Rejected';
    updateData.nextAction = 'No active next action';
    updateData.nextActionDue = null;
    await prisma.activity.create({
      data: { applicationId: id, eventType: 'Rejected', summary: 'Marked application as rejected', metadataJson: JSON.stringify(body) },
    });
  } else if (body.action === 'offer') {
    updateData.status = 'Offer';
    updateData.currentStage = 'Offer Received';
    updateData.nextAction = 'Review, compare, and respond to offer';
    updateData.nextActionDue = body.nextActionDue ? new Date(body.nextActionDue) : new Date(Date.now() + 7 * 86400000);
    await prisma.activity.create({
      data: { applicationId: id, eventType: 'Offer received', summary: 'Recorded offer', metadataJson: JSON.stringify(body) },
    });
  } else if (body.action === 'description') {
    await prisma.jobDescription.upsert({
      where: { applicationId: id },
      create: {
        applicationId: id,
        fullText: body.fullText ?? '',
        minimumQualifications: body.minimumQualifications ?? '',
        preferredQualifications: body.preferredQualifications ?? '',
        keywords: body.keywords ?? '',
      },
      update: {
        fullText: body.fullText ?? '',
        minimumQualifications: body.minimumQualifications ?? '',
        preferredQualifications: body.preferredQualifications ?? '',
        keywords: body.keywords ?? '',
      },
    });
    await prisma.activity.create({
      data: { applicationId: id, eventType: 'Job description saved', summary: 'Saved job description', metadataJson: JSON.stringify(body) },
    });
  } else if (body.action === 'note') {
    await prisma.note.create({ data: { applicationId: id, category: body.category ?? 'General', content: body.content ?? '' } });
    await prisma.activity.create({ data: { applicationId: id, eventType: 'Note added', summary: 'Added note', metadataJson: JSON.stringify(body) } });
  } else if (body.action === 'contact') {
    await prisma.contact.create({ data: { applicationId: id, name: body.name ?? 'Unknown', title: body.title ?? '', email: body.email ?? '', relationship: body.relationship ?? '', notes: body.notes ?? '' } });
    await prisma.activity.create({ data: { applicationId: id, eventType: 'Contact added', summary: 'Added contact', metadataJson: JSON.stringify(body) } });
  }

  const updated = await prisma.application.update({ where: { id }, data: updateData });
  return NextResponse.json(updated);
}
