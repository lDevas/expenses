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
    statements.push(await parseStatement(f.name, f.buffer));
  }
  const result = consolidate(statements);
  db.saveConsolidation(result, statements);
  return { result, statements };
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
