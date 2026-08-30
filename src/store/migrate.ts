import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';

/**
 * Forward-only SQL migrations applied at startup against a version table. No
 * ORM, no migration library, no down-migrations: a rollback is a restore.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

function sqlFile(name: string): string {
  const path = fileURLToPath(new URL(name, import.meta.url));
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    // .sql files sit beside the module rather than inside it, so a build that
    // only runs tsc will not have copied them. Say so, rather than failing as
    // a bare ENOENT at startup.
    throw new Error(
      `Dogpark cannot start: migration file ${name} is missing at ${path}. ` +
        `The build must copy src/store/*.sql alongside the compiled modules.`,
      { cause },
    );
  }
}

/**
 * Ordered and append-only. Editing an applied migration changes the schema of
 * new deployments only, so once a version has run anywhere it is frozen and
 * the change becomes the next entry.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: sqlFile('schema.sql') },
  // Amended once before it had run anywhere durable (the first cut lacked
  // read_log.label_seq). If a database ever turns up that ran that cut,
  // openStore fails at prepare on the missing column; the remedy is a
  // version 3 of exactly:
  //   ALTER TABLE read_log ADD COLUMN label_seq INTEGER NOT NULL DEFAULT 0
  {
    version: 2,
    name: 'label-history-and-attachment-reads',
    sql: sqlFile('0002-label-history-and-attachment-reads.sql'),
  },
];

const VERSION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT
`;

export interface MigrateResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly number[];
}

/**
 * Brings `db` up to the newest migration. Each migration and its version row
 * commit together, so a crash mid-run leaves the database at a version that
 * was actually reached.
 */
export function migrate(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => string = () => new Date().toISOString(),
): MigrateResult {
  db.exec(VERSION_TABLE);

  const currentRow = db
    .prepare<[], { version: number | null }>('SELECT MAX(version) AS version FROM schema_version')
    .get();
  const from = currentRow?.version ?? 0;

  const ahead = migrations.filter((m) => m.version > from);
  // A database newer than the code is not something a forward-only scheme can
  // repair, and running the old code against it would corrupt data quietly.
  const newest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  if (from > newest) {
    throw new Error(
      `Dogpark cannot start: the database is at schema version ${from}, ` +
        `but this build knows only up to ${newest}.`,
    );
  }

  const record = db.prepare<[number, string, string], unknown>(
    'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
  );

  const applied: number[] = [];
  for (const migration of [...ahead].sort((a, b) => a.version - b.version)) {
    // exec() cannot run inside better-sqlite3's transaction() wrapper when the
    // SQL itself contains transaction control, so drive BEGIN/COMMIT directly
    // and keep the DDL and its version row in one unit.
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `Dogpark cannot start: migration ${migration.version} (${migration.name}) failed.`,
        { cause: error },
      );
    }
    applied.push(migration.version);
  }

  return { from, to: Math.max(from, newest), applied };
}
