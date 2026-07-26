import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { workflowPayloadSchema } from '@/lib/schemas/workflows';
import { applyWorkflow, interviewCompletedWorkflow, interviewReceivedWorkflow, oaCompletedWorkflow, oaReceivedWorkflow, offerWorkflow, rejectWorkflow } from '@/lib/workflows/applications';

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
  const parsed = workflowPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const existing = await prisma.application.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    let updated;
    switch (parsed.data.action) {
      case 'apply':
        updated = await applyWorkflow(prisma, id, parsed.data);
        break;
      case 'oaReceived':
        updated = await oaReceivedWorkflow(prisma, id, parsed.data);
        break;
      case 'oaCompleted':
        updated = await oaCompletedWorkflow(prisma, id, parsed.data);
        break;
      case 'interviewReceived':
        updated = await interviewReceivedWorkflow(prisma, id, parsed.data);
        break;
      case 'interviewCompleted':
        updated = await interviewCompletedWorkflow(prisma, id, parsed.data);
        break;
      case 'reject':
        updated = await rejectWorkflow(prisma, id, parsed.data);
        break;
      case 'offer':
        updated = await offerWorkflow(prisma, id, parsed.data);
        break;
      case 'description':
        await prisma.$transaction(async (tx) => {
          await tx.jobDescription.upsert({
            where: { applicationId: id },
            create: {
              applicationId: id,
              fullText: parsed.data.fullText ?? '',
              minimumQualifications: parsed.data.minimumQualifications ?? '',
              preferredQualifications: parsed.data.preferredQualifications ?? '',
              keywords: parsed.data.keywords ?? '',
            },
            update: {
              fullText: parsed.data.fullText ?? '',
              minimumQualifications: parsed.data.minimumQualifications ?? '',
              preferredQualifications: parsed.data.preferredQualifications ?? '',
              keywords: parsed.data.keywords ?? '',
            },
          });
          await tx.activity.create({
            data: { applicationId: id, eventType: 'Job description saved', summary: 'Saved job description', metadataJson: JSON.stringify(parsed.data) },
          });
        });
        updated = await prisma.application.findUniqueOrThrow({ where: { id } });
        break;
      case 'note':
        await prisma.$transaction(async (tx) => {
          await tx.note.create({ data: { applicationId: id, category: parsed.data.category ?? 'General', content: parsed.data.content ?? '' } });
          await tx.activity.create({ data: { applicationId: id, eventType: 'Note added', summary: 'Added note', metadataJson: JSON.stringify(parsed.data) } });
        });
        updated = await prisma.application.findUniqueOrThrow({ where: { id } });
        break;
      case 'contact':
        await prisma.$transaction(async (tx) => {
          await tx.contact.create({ data: { applicationId: id, name: parsed.data.name ?? 'Unknown', title: parsed.data.title ?? '', email: parsed.data.email ?? '', relationship: parsed.data.relationship ?? '', notes: parsed.data.notes ?? '' } });
          await tx.activity.create({ data: { applicationId: id, eventType: 'Contact added', summary: 'Added contact', metadataJson: JSON.stringify(parsed.data) } });
        });
        updated = await prisma.application.findUniqueOrThrow({ where: { id } });
        break;
      default:
        throw new Error('Unsupported action');
    }

    return NextResponse.json(updated);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 400 });
  }
}
