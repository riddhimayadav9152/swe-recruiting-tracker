import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { backfillNextActionDueKind } from '../backfill';

const projectRoot = path.resolve(__dirname, '..', '..');
const dbPath = path.resolve(projectRoot, 'data', 'backfill-test.db');
const databaseUrl = `file:${dbPath}`;

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

beforeAll(async () => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  execFileSync('npx', ['prisma', 'db', 'push', '--accept-data-loss', '--skip-generate'], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
});

beforeEach(async () => {
  await prisma.$transaction([
    prisma.activity.deleteMany(),
    prisma.assessment.deleteMany(),
    prisma.interview.deleteMany(),
    prisma.offer.deleteMany(),
    prisma.application.deleteMany(),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const baseApp = { role: 'Software Engineer', status: 'Not Applied', currentStage: 'Discovered' };

describe('backfillNextActionDueKind', () => {
  it('reclassifies a row whose nextActionDue matches its own applicationDeadline', async () => {
    const app = await prisma.application.create({
      data: {
        ...baseApp,
        applicationCode: 'APPD-1',
        company: 'Deadline Co',
        applicationDeadline: new Date('2026-08-15T00:00:00.000Z'),
        nextActionDue: new Date('2026-08-15T00:00:00.000Z'),
        nextActionDueKind: 'timestamp',
      },
    });

    const result = await backfillNextActionDueKind(prisma);
    expect(result.updated).toBe(1);
    expect(result.byCategory.applicationDeadline).toBe(1);
    expect(result.byCategory.offerDecisionDeadline).toBe(0);
    expect(result.byCategory.interviewFollowUpDate).toBe(0);

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(updated.nextActionDueKind).toBe('date');
  });

  it('reclassifies a row whose nextActionDue matches its Offer decisionDeadline', async () => {
    const app = await prisma.application.create({
      data: {
        ...baseApp,
        applicationCode: 'OFFR-1',
        company: 'Offer Co',
        status: 'Offer',
        currentStage: 'Offer Received',
        nextActionDue: new Date('2026-08-20T00:00:00.000Z'),
        nextActionDueKind: 'timestamp',
      },
    });
    await prisma.offer.create({ data: { applicationId: app.id, decisionDeadline: new Date('2026-08-20T00:00:00.000Z') } });

    const result = await backfillNextActionDueKind(prisma);
    expect(result.updated).toBe(1);
    expect(result.byCategory.offerDecisionDeadline).toBe(1);

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(updated.nextActionDueKind).toBe('date');
  });

  it('reclassifies a row whose nextActionDue matches an Interview followUpDate', async () => {
    const app = await prisma.application.create({
      data: {
        ...baseApp,
        applicationCode: 'INTV-1',
        company: 'Interview Co',
        status: 'Recruiter Screen',
        currentStage: 'Recruiter Screen',
        nextActionDue: new Date('2026-08-25T00:00:00.000Z'),
        nextActionDueKind: 'timestamp',
      },
    });
    await prisma.interview.create({ data: { applicationId: app.id, stage: 'Recruiter Screen', followUpDate: new Date('2026-08-25T00:00:00.000Z') } });

    const result = await backfillNextActionDueKind(prisma);
    expect(result.updated).toBe(1);
    expect(result.byCategory.interviewFollowUpDate).toBe(1);

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(updated.nextActionDueKind).toBe('date');
  });

  it('leaves a genuine timestamp-derived nextActionDue alone even if none of the three sources match', async () => {
    await prisma.application.create({
      data: {
        ...baseApp,
        applicationCode: 'TS-1',
        company: 'Timestamp Co',
        status: 'Applied',
        currentStage: 'Application Submitted',
        nextActionDue: new Date('2026-08-30T12:34:56.000Z'),
        nextActionDueKind: 'timestamp',
      },
    });

    const result = await backfillNextActionDueKind(prisma);
    expect(result.updated).toBe(0);

    const applications = await prisma.application.findMany();
    expect(applications[0].nextActionDueKind).toBe('timestamp');
  });

  it('is idempotent — re-running after a successful backfill updates nothing further', async () => {
    const app = await prisma.application.create({
      data: {
        ...baseApp,
        applicationCode: 'IDEM-1',
        company: 'Idempotent Co',
        applicationDeadline: new Date('2026-09-01T00:00:00.000Z'),
        nextActionDue: new Date('2026-09-01T00:00:00.000Z'),
        nextActionDueKind: 'timestamp',
      },
    });

    const first = await backfillNextActionDueKind(prisma);
    expect(first.updated).toBe(1);

    const second = await backfillNextActionDueKind(prisma);
    expect(second.updated).toBe(0);

    const updated = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(updated.nextActionDueKind).toBe('date');
  });

  it('does not reclassify a row with no nextActionDue at all', async () => {
    await prisma.application.create({
      data: { ...baseApp, applicationCode: 'NULL-1', company: 'Null Co', nextActionDue: null },
    });

    const result = await backfillNextActionDueKind(prisma);
    expect(result.updated).toBe(0);
  });
});
