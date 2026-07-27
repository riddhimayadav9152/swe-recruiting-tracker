import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { workflowPayloadSchema } from '@/lib/schemas/workflows';
import { applyWorkflow, contactWorkflow, interviewCompletedWorkflow, interviewReceivedWorkflow, oaCompletedWorkflow, oaReceivedWorkflow, offerWorkflow, rejectWorkflow, setApplicationDateWorkflow } from '@/lib/workflows/applications';

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
      offers: true,
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
      case 'description': {
        const payload = parsed.data;
        await prisma.$transaction(async (tx) => {
          await tx.jobDescription.upsert({
            where: { applicationId: id },
            create: {
              applicationId: id,
              fullText: payload.fullText ?? '',
              minimumQualifications: payload.minimumQualifications ?? '',
              preferredQualifications: payload.preferredQualifications ?? '',
              keywords: payload.keywords ?? '',
            },
            update: {
              fullText: payload.fullText ?? '',
              minimumQualifications: payload.minimumQualifications ?? '',
              preferredQualifications: payload.preferredQualifications ?? '',
              keywords: payload.keywords ?? '',
            },
          });
          await tx.activity.create({
            data: { applicationId: id, eventType: 'Job description saved', summary: 'Saved job description', metadataJson: JSON.stringify(payload) },
          });
        });
        updated = await prisma.application.findUniqueOrThrow({ where: { id } });
        break;
      }
      case 'note': {
        const payload = parsed.data;
        await prisma.$transaction(async (tx) => {
          await tx.note.create({ data: { applicationId: id, category: payload.category ?? 'General', content: payload.content ?? '' } });
          await tx.activity.create({ data: { applicationId: id, eventType: 'Note added', summary: 'Added note', metadataJson: JSON.stringify(payload) } });
        });
        updated = await prisma.application.findUniqueOrThrow({ where: { id } });
        break;
      }
      case 'contact':
        await contactWorkflow(prisma, id, parsed.data);
        updated = await prisma.application.findUniqueOrThrow({ where: { id } });
        break;
      case 'setApplicationDate':
        updated = await setApplicationDateWorkflow(prisma, id, parsed.data);
        break;
      default:
        throw new Error('Unsupported action');
    }

    return NextResponse.json(updated);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 400 });
  }
}
