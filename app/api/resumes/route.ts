import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const resumes = await prisma.resumeVersion.findMany({ orderBy: { createdAt: 'desc' }, include: { applications: true } });
  return NextResponse.json(resumes);
}

export async function POST(request: Request) {
  const body = await request.json();
  const resume = await prisma.resumeVersion.create({ data: body });
  return NextResponse.json(resume);
}
