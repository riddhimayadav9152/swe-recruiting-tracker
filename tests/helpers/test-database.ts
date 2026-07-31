import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sqliteCompanionSuffixes = ['', '-journal', '-shm', '-wal'];

export function resetSqliteTestDatabaseFile(projectRoot: string, databasePath: string) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  for (const suffix of sqliteCompanionSuffixes) {
    const target = `${databasePath}${suffix}`;
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }

  const devDatabasePath = path.resolve(projectRoot, 'data', 'dev.db');
  if (fs.existsSync(devDatabasePath)) {
    fs.copyFileSync(devDatabasePath, databasePath);
    return;
  }

  fs.closeSync(fs.openSync(databasePath, 'w'));
}

export function pushPrismaSchema(projectRoot: string, databaseUrl: string, stdio: 'inherit' | 'pipe' = 'pipe') {
  execFileSync('npx', ['prisma', 'db', 'push', '--accept-data-loss', '--skip-generate'], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio,
  });
}
