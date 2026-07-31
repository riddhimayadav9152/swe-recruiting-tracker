import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { linkCreateSchema } from '@/lib/schemas/workflows';
import { createLinkWorkflow } from '@/lib/workflows/applications';

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = linkCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  try {
    const created = await createLinkWorkflow(prisma, parsed.data);
    return NextResponse.json(created);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 400 });
  }
}
