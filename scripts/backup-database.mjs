import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { projectRoot, resolveDatabasePath, timestamp } from './database-path.mjs';

const databasePath = resolveDatabasePath();
if (!fs.existsSync(databasePath)) {
  throw new Error(`Database file does not exist: ${databasePath}`);
}

const backupsDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(projectRoot, 'data', 'backups');
fs.mkdirSync(backupsDir, { recursive: true });

const backupPath = path.join(backupsDir, `dev-${timestamp()}.db`);

try {
  execFileSync('sqlite3', [databasePath, `.backup '${backupPath}'`], { stdio: 'pipe' });
} catch {
  fs.copyFileSync(databasePath, backupPath);
}

console.log(backupPath);
