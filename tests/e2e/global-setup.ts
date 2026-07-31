import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { e2eDatabasePath, e2eDatabaseUrl } from './e2e-db';

export default async function globalSetup() {
  const projectRoot = path.resolve(__dirname, '..', '..');

  fs.mkdirSync(path.dirname(e2eDatabasePath), { recursive: true });
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    const target = `${e2eDatabasePath}${suffix}`;
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  fs.copyFileSync(path.resolve(projectRoot, 'data', 'dev.db'), e2eDatabasePath);

  execFileSync('npx', ['prisma', 'db', 'push', '--accept-data-loss', '--skip-generate'], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: e2eDatabaseUrl },
    stdio: 'inherit',
  });

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
