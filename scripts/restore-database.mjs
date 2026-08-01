import fs from 'fs';
import path from 'path';
import { projectRoot, resolveDatabasePath, timestamp } from './database-path.mjs';

const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (!sourcePath) {
  throw new Error('Usage: npm run db:restore -- path/to/backup.db');
}
if (!fs.existsSync(sourcePath)) {
  throw new Error(`Backup file does not exist: ${sourcePath}`);
}

const databasePath = resolveDatabasePath();
const backupsDir = path.join(projectRoot, 'data', 'backups');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.mkdirSync(backupsDir, { recursive: true });

if (fs.existsSync(databasePath)) {
  const safetyBackupPath = path.join(backupsDir, `pre-restore-${timestamp()}.db`);
  fs.copyFileSync(databasePath, safetyBackupPath);
  console.log(`Existing database backed up to ${safetyBackupPath}`);
}

fs.copyFileSync(sourcePath, databasePath);
console.log(`Restored ${sourcePath} to ${databasePath}`);
