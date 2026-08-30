import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, type Migration } from './migrate.js';

const dirs: string[] = [];

/**
 * One past the newest real migration. Written this way so that adding a
 * migration does not break the tests that stack a synthetic one on top.
 */
const NEWEST = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
const NEXT = NEWEST + 1;

function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dogpark-migrate-'));
  dirs.push(dir);
  return join(dir, 'dogpark.db');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('applies the schema once and is a no-op thereafter', () => {
    const path = file();
    const db = new Database(path);
    try {
      const first = migrate(db);
      expect(first.from).toBe(0);
      expect(first.applied).toEqual(MIGRATIONS.map((m) => m.version));

      const second = migrate(db);
      expect(second.applied).toEqual([]);
      expect(second.from).toBe(second.to);
    } finally {
      db.close();
    }
  });

  it('carries existing agent keys across the idempotency rebuild', () => {
    const path = file();
    const db = new Database(path);
    try {
      // Stop at 2, which is the shape 0003 has to migrate away from.
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 2),
      );
      db.prepare(
        "INSERT INTO agent (id, display_name, created_at, archived) VALUES ('a', 'alice', 'then', 0)",
      ).run();
      db.prepare(
        'INSERT INTO idempotency (agent_id, key, request_hash, outcome_json, created_at) ' +
          "VALUES ('a', 'k', 'h', '{\"messageId\":\"m\"}', 'then')",
      ).run();

      const result = migrate(db);
      expect(result.applied).toContain(3);

      const rows = db.prepare('SELECT writer, key, request_hash FROM idempotency').all();
      expect(rows).toEqual([{ writer: 'a', key: 'k', request_hash: 'h' }]);
    } finally {
      db.close();
    }
  });

  it('refuses to migrate an agent that holds the reserved writer id', () => {
    const path = file();
    const db = new Database(path);
    try {
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version <= 2),
      );
      // agent.id is unconstrained TEXT, so only a hand-written row can carry
      // the sentinel — and copying its keys into the human's namespace would
      // make them indistinguishable ever after. The migration must refuse.
      db.prepare(
        "INSERT INTO agent (id, display_name, created_at, archived) VALUES (':human', 'impostor', 'then', 0)",
      ).run();

      expect(() => migrate(db)).toThrow(/migration 3/);
      // The refusal rolled back: the database is still at version 2, intact.
      const version = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
        v: number;
      };
      expect(version.v).toBe(2);
    } finally {
      db.close();
    }
  });

  it('records what it applied in a version table', () => {
    const db = new Database(file());
    try {
      migrate(db, undefined, () => '2026-01-01T00:00:00.000Z');
      const rows = db
        .prepare('SELECT version, name, applied_at FROM schema_version ORDER BY version')
        .all() as { version: number; name: string; applied_at: string }[];
      expect(rows[0]).toEqual({
        version: 1,
        name: 'initial',
        applied_at: '2026-01-01T00:00:00.000Z',
      });
    } finally {
      db.close();
    }
  });

  it('applies only what is ahead of the current version', () => {
    const db = new Database(file());
    try {
      migrate(db);
      const extra: Migration = {
        version: NEXT,
        name: 'later',
        sql: 'CREATE TABLE later (id TEXT PRIMARY KEY) STRICT',
      };
      const result = migrate(db, [...MIGRATIONS, extra]);
      expect(result.applied).toEqual([NEXT]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM later').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('leaves nothing behind when a migration fails', () => {
    const db = new Database(file());
    try {
      migrate(db);
      const broken: Migration = {
        version: NEXT,
        name: 'broken',
        sql: 'CREATE TABLE half (id TEXT PRIMARY KEY) STRICT; THIS IS NOT SQL;',
      };
      expect(() => migrate(db, [...MIGRATIONS, broken])).toThrow(
        new RegExp(`migration ${NEXT} \\(broken\\) failed`),
      );

      const versions = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
        v: number;
      };
      expect(versions.v).toBe(NEWEST);
      expect(() => db.prepare('SELECT 1 FROM half').get()).toThrow(/no such table/);
    } finally {
      db.close();
    }
  });

  it('refuses to run old code against a newer database', () => {
    const db = new Database(file());
    try {
      migrate(db, [
        ...MIGRATIONS,
        { version: NEXT, name: 'later', sql: 'CREATE TABLE later (id TEXT PRIMARY KEY) STRICT' },
      ]);
      expect(() => migrate(db, MIGRATIONS)).toThrow(new RegExp(`knows only up to ${NEWEST}`));
    } finally {
      db.close();
    }
  });
});
