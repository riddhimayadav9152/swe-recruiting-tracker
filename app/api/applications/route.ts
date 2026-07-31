import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { detectDuplicate, validateApplicationInput } from '@/lib/recruiting';
import { applicationCreateSchema } from '@/lib/schemas/workflows';
import { createApplicationRecord } from '@/lib/workflows/applications';

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
      offers: true,
      links: true,
    },
  });
  return NextResponse.json(applications);
}

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = applicationCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  const input = parsed.data;
  const errors = validateApplicationInput(input);
  if (Object.keys(errors).length) {
    return NextResponse.json({ errors }, { status: 400 });
  }
  const existing = await prisma.application.findMany({
    select: { company: true, role: true, applicationUrl: true },
  });
  const duplicate = detectDuplicate(existing, input);
  if (duplicate) {
    return NextResponse.json({ duplicate: true }, { status: 409 });
  }

  const existingCodes = await prisma.application.findMany({ select: { applicationCode: true } });
  const created = await createApplicationRecord(prisma, input, existingCodes.map((item) => item.applicationCode));

  return NextResponse.json(created);
}
