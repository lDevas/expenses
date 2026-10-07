import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { applySchema } from './db/schemaSql.ts';
import { DatabaseQueries } from './db/queries.ts';

const DATA_DIR = path.join(path.resolve('.'), 'data');
const DB_PATH = path.join(DATA_DIR, 'expenses.db');

function removeDbFiles(dbPath: string): void {
  const base = dbPath;
  const files = [
    base,
    `${base}-shm`,
    `${base}-wal`,
    `${base}-journal`,
  ];
  for (const f of files) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        console.log(`🗑️ Removed ${f}`);
      }
    } catch (e) {
      console.warn(`⚠️ Could not remove ${f}:`, e);
    }
  }
}

function initDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  const queries = new DatabaseQueries(db);
  queries.seedDefaultInstitutions();
  db.close();
  console.log(`✅ Initialized ${dbPath}`);
}

console.log('🔄 Resetting local database...');
removeDbFiles(DB_PATH);

initDb(DB_PATH);

console.log('✅ Database reset complete');
console.log(`📁 DB: ${DB_PATH}`);
