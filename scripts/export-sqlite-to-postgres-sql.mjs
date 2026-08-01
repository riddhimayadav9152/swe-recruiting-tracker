import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { projectRoot, resolveDatabasePath, timestamp } from './database-path.mjs';

const orderedTables = [
  'ResumeVersion',
  'UserProfile',
  'Application',
  'ApplicationLink',
  'JobDescription',
  'Assessment',
  'Offer',
  'Interview',
  'Contact',
  'Note',
  'Activity',
  'Document',
];

const dateColumns = new Set([
  'postingDate',
  'applicationDeadline',
  'dateFound',
  'dateApplied',
  'nextActionDue',
  'lastVerifiedAt',
  'createdAt',
  'updatedAt',
  'savedAt',
  'receivedAt',
  'dueAt',
  'completedAt',
  'offerDate',
  'decisionDeadline',
  'scheduledStart',
  'scheduledEnd',
  'followUpDate',
  'lastContacted',
  'nextFollowUp',
]);

const booleanColumns = new Set(['archived']);

const databasePath = resolveDatabasePath();
if (!fs.existsSync(databasePath)) throw new Error(`SQLite database not found: ${databasePath}`);

const outputPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(projectRoot, 'data', `postgres-import-${timestamp()}.sql`);

function sqliteJson(sql) {
  const output = execFileSync('sqlite3', ['-json', databasePath, sql], { encoding: 'utf8' });
  return output.trim() ? JSON.parse(output) : [];
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string' && /^\d+$/.test(value)) return new Date(Number(value)).toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid DateTime value in SQLite export: ${value}`);
  return parsed.toISOString();
}

function sqlValue(column, value) {
  if (value === null || value === undefined) return 'NULL';
  if (booleanColumns.has(column)) return value === true || value === 1 || value === '1' ? 'TRUE' : 'FALSE';
  if (dateColumns.has(column)) {
    const normalized = normalizeDate(value);
    return normalized ? `${quoteLiteral(normalized)}::timestamp(3)` : 'NULL';
  }
  if (typeof value === 'number') return String(value);
  return quoteLiteral(value);
}

function tableColumns(table) {
  return sqliteJson(`PRAGMA table_info(${quoteIdentifier(table)});`).map((row) => row.name);
}

const lines = [
  '-- Generated from local SQLite data for Supabase/Postgres import.',
  '-- Run this only after pushing prisma/schema.postgres.prisma to the Supabase database.',
  'BEGIN;',
  '',
];

for (const table of orderedTables) {
  const columns = tableColumns(table);
  if (!columns.length) continue;
  const rows = sqliteJson(`SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)};`);
  if (!rows.length) continue;

  const conflictTarget = columns.includes('id') ? quoteIdentifier('id') : null;
  const quotedTable = quoteIdentifier(table);
  const quotedColumns = columns.map(quoteIdentifier).join(', ');

  for (const row of rows) {
    const values = columns.map((column) => sqlValue(column, row[column])).join(', ');
    const updateColumns = columns.filter((column) => column !== 'id');
    const conflictClause = conflictTarget && updateColumns.length
      ? ` ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateColumns.map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(', ')}`
      : conflictTarget ? ` ON CONFLICT (${conflictTarget}) DO NOTHING` : '';
    lines.push(`INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${values})${conflictClause};`);
  }

  lines.push('');
}

lines.push('COMMIT;', '');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, lines.join('\n'));
console.log(outputPath);
