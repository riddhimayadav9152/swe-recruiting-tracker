import path from 'path';
import { PrismaClient } from '@prisma/client';
import { e2eDatabasePath, e2eDatabaseUrl } from './e2e-db';
import { pushPrismaSchema, resetSqliteTestDatabaseFile } from '../helpers/test-database';

export default async function globalSetup() {
  const projectRoot = path.resolve(__dirname, '..', '..');

  resetSqliteTestDatabaseFile(projectRoot, e2eDatabasePath);
  pushPrismaSchema(projectRoot, e2eDatabaseUrl, 'inherit');

  const prisma = new PrismaClient({ datasources: { db: { url: e2eDatabaseUrl } } });
  await prisma.$transaction([
    prisma.activity.deleteMany(),
    prisma.note.deleteMany(),
    prisma.contact.deleteMany(),
    prisma.jobDescription.deleteMany(),
    prisma.applicationLink.deleteMany(),
    prisma.assessment.deleteMany(),
    prisma.interview.deleteMany(),
    prisma.offer.deleteMany(),
    prisma.document.deleteMany(),
    prisma.application.deleteMany(),
    prisma.resumeVersion.deleteMany(),
    prisma.userProfile.deleteMany(),
  ]);
  await prisma.$disconnect();
}
