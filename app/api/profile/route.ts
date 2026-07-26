import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const profile = await prisma.userProfile.findFirst();
  return NextResponse.json(profile ?? { id: 'default' });
}

export async function POST(request: Request) {
  const body = await request.json();
  const existing = await prisma.userProfile.findFirst();
  const profile = existing
    ? await prisma.userProfile.update({ where: { id: existing.id }, data: body })
    : await prisma.userProfile.create({ data: body });
  return NextResponse.json(profile);
}
