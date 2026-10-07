import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { DatabaseQueries } from './db/queries.ts';
import { applySchema } from './db/schemaSql.ts';
import { parseStatement } from './ingestion/parsers/index.ts';
import { consolidate } from './ingestion/consolidation.ts';
import type { ConsolidatedResult, ParsedStatement } from './ingestion/types.ts';

export interface StatementFile {
  name: string;
  buffer: Buffer;
  hash?: string;
}

export interface ConsolidationOutput {
  result: ConsolidatedResult;
  statements: ParsedStatement[];
}

/**
 * Run the full statement pipeline over a batch of files:
 * parse each (never throws) → consolidate → persist one run to the database.
 * Returns the consolidated result plus the per-file statements (for callers
 * that want the raw parse output / issues).
 */
export async function runConsolidation(files: StatementFile[], db: DatabaseQueries): Promise<ConsolidationOutput> {
  const statements: ParsedStatement[] = [];
  for (const f of files) {
    const hash = computeFileHash(f.buffer);
    const stmt = await parseStatement(f.name, f.buffer);
    stmt.fileHash = hash;
    statements.push(stmt);
  }
  const result = consolidate(statements);
  db.saveConsolidation(result, statements);
  return { result, statements };
}

function computeFileHash(buf: Buffer): string {
  // Simple deterministic hash of buffer content
  let hash = 0;
  for (let i = 0; i < buf.length; i++) {
    const chr = buf[i];
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

/** Convenience: read files from disk paths. */
export async function runConsolidationFromPaths(paths: string[], db: DatabaseQueries): Promise<ConsolidationOutput> {
  const files: StatementFile[] = paths.map((p) => ({
    name: path.basename(p),
    buffer: fs.readFileSync(p),
  }));
  return runConsolidation(files, db);
}

/** Open (and schema-initialize) a database for direct, server-less use — e.g. the CLI's scratch DB. */
export function openStatementsDatabase(dbPath: string): DatabaseQueries {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return new DatabaseQueries(db);
}
