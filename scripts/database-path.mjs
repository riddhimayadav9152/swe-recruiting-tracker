import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(scriptDir, '..');
export const prismaDir = path.join(projectRoot, 'prisma');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

export function loadDatabaseUrl() {
  const envValues = {
    ...parseEnvFile(path.join(projectRoot, '.env')),
    ...parseEnvFile(path.join(projectRoot, '.env.local')),
    ...process.env,
  };

  return envValues.DATABASE_URL ?? 'file:../data/dev.db';
}

export function resolveDatabasePath(databaseUrl = loadDatabaseUrl()) {
  if (!databaseUrl.startsWith('file:')) {
    throw new Error(`Only SQLite file: DATABASE_URL values are supported by these scripts. Received: ${databaseUrl}`);
  }

  const rawPath = databaseUrl.slice('file:'.length);
  if (!rawPath) throw new Error('DATABASE_URL points to an empty SQLite file path.');
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(prismaDir, rawPath);
}

export function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}
