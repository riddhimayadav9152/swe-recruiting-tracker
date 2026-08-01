import fs from 'fs';
import path from 'path';
import { resolveDatabasePath } from './database-path.mjs';

const databasePath = resolveDatabasePath();
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
console.log(`Database directory ready: ${path.dirname(databasePath)}`);
