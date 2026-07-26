import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { e2eDatabasePath, e2eDatabaseUrl } from './e2e-db';

export default async function globalSetup() {
  const projectRoot = path.resolve(__dirname, '..', '..');

  fs.mkdirSync(path.dirname(e2eDatabasePath), { recursive: true });
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    const target = `${e2eDatabasePath}${suffix}`;
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }

  execFileSync('npx', ['prisma', 'db', 'push', '--accept-data-loss', '--skip-generate'], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: e2eDatabaseUrl },
    stdio: 'inherit',
  });
}
