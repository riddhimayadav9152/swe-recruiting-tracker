import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resumeCreateSchema } from '@/lib/schemas/resumes';

export async function GET() {
  const resumes = await prisma.resumeVersion.findMany({ orderBy: { createdAt: 'desc' }, include: { applications: true } });
  return NextResponse.json(resumes);
}

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = resumeCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  const resume = await prisma.resumeVersion.create({ data: parsed.data });
  return NextResponse.json(resume);
}
