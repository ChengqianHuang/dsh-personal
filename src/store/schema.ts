/**
 * SQLite schema for the personal plugin: the ordered migration list and the
 * monotonic migration runner. `PRAGMA user_version` is the schema version;
 * every migration applies once inside a transaction that also stamps its
 * version, so an interrupted migration leaves the previous version intact.
 * @module @deepseek-ai/dsh-personal/store/schema
 */

import type { DatabaseSync } from 'node:sqlite'

/**
 * Current personal schema version. Bump by appending a migration; any on-disk
 * version greater than this rejects — a database written by a newer build.
 *
 * 1 — initial tables (movies.rating INTEGER).
 * 2 — rebuild `movies` with a REAL rating: real-use review showed half-point
 *     scores ("7.5 分") truncated to integers end to end.
 */
export const PERSONAL_SCHEMA_VERSION = 2

/**
 * SQLite `application_id` fingerprint (`PERS`) marking a database as owned by
 * this plugin; opening a foreign database rejects instead of guessing.
 */
export const PERSONAL_APPLICATION_ID = 0x50455253

/** One forward-only schema migration. */
export interface PersonalMigration {
  /** Version this migration produces; versions are dense and increasing. */
  readonly version: number
  /** Apply the migration's DDL and DML inside the caller's transaction. */
  readonly up: (db: DatabaseSync) => void
}

/** Ordered migration list; every version above the on-disk version applies. */
export const PERSONAL_MIGRATIONS: readonly PersonalMigration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE projects (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          status      TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED')),
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        ) STRICT
      `)
      db.exec(`
        CREATE TABLE websites (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          domain      TEXT NOT NULL UNIQUE,
          repo        TEXT NOT NULL DEFAULT '',
          hosting     TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          tags        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        ) STRICT
      `)
      db.exec(`
        CREATE TABLE movies (
          id         TEXT PRIMARY KEY,
          title      TEXT NOT NULL,
          watched_at TEXT NOT NULL,
          rating     INTEGER CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10)),
          note       TEXT NOT NULL DEFAULT '',
          tags       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT
      `)
      db.exec('CREATE INDEX movies_watched_at ON movies (watched_at)')
      db.exec(`
        CREATE TABLE project_logs (
          id         TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects (id),
          date       TEXT NOT NULL,
          title      TEXT NOT NULL,
          content    TEXT NOT NULL DEFAULT '',
          status     TEXT NOT NULL CHECK (status IN ('DONE', 'WIP', 'BLOCKED')),
          tags       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
          created_at TEXT NOT NULL
        ) STRICT
      `)
      db.exec('CREATE INDEX project_logs_project_date ON project_logs (project_id, date)')
      db.exec(`
        CREATE TABLE tasks (
          id          TEXT PRIMARY KEY,
          title       TEXT NOT NULL,
          status      TEXT NOT NULL CHECK (status IN ('TODO', 'DOING', 'DONE', 'CANCELLED')),
          priority    TEXT NOT NULL CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH')),
          due_at      TEXT,
          done_at     TEXT,
          project_id  TEXT REFERENCES projects (id),
          website_id  TEXT REFERENCES websites (id),
          source_type TEXT,
          source_id   TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        ) STRICT
      `)
      db.exec('CREATE INDEX tasks_status ON tasks (status)')
      db.exec('CREATE INDEX tasks_due_at ON tasks (due_at)')
      db.exec('CREATE INDEX tasks_project ON tasks (project_id)')
      db.exec('CREATE INDEX tasks_website ON tasks (website_id)')
      db.exec(`
        CREATE TABLE blog_posts (
          id                 TEXT PRIMARY KEY,
          title              TEXT NOT NULL,
          status             TEXT NOT NULL CHECK (status IN ('IDEA', 'OUTLINE', 'DRAFT', 'REVIEW', 'PUBLISHED')),
          summary            TEXT NOT NULL DEFAULT '',
          content            TEXT NOT NULL DEFAULT '',
          tags               TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
          related_project_id TEXT REFERENCES projects (id),
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        ) STRICT
      `)
      db.exec('CREATE INDEX blog_posts_status ON blog_posts (status)')
      db.exec(`
        CREATE TABLE ideas (
          id                 TEXT PRIMARY KEY,
          title              TEXT NOT NULL,
          content            TEXT NOT NULL DEFAULT '',
          category           TEXT NOT NULL DEFAULT '',
          related_project_id TEXT REFERENCES projects (id),
          created_at         TEXT NOT NULL
        ) STRICT
      `)
      db.exec(`
        CREATE TABLE daily_logs (
          id         TEXT PRIMARY KEY,
          date       TEXT NOT NULL,
          summary    TEXT NOT NULL,
          raw_text   TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        ) STRICT
      `)
      db.exec('CREATE INDEX daily_logs_date ON daily_logs (date)')
      db.exec(`
        CREATE TABLE relations (
          id            TEXT PRIMARY KEY,
          from_type     TEXT NOT NULL CHECK (from_type IN
            ('movie', 'project', 'project_log', 'task', 'blog_post', 'website', 'idea', 'daily_log')),
          from_id       TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          to_type       TEXT NOT NULL CHECK (to_type IN
            ('movie', 'project', 'project_log', 'task', 'blog_post', 'website', 'idea', 'daily_log')),
          to_id         TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          UNIQUE (from_type, from_id, relation_type, to_type, to_id)
        ) STRICT
      `)
      db.exec('CREATE INDEX relations_from ON relations (from_type, from_id)')
      db.exec('CREATE INDEX relations_to ON relations (to_type, to_id)')
    },
  },
  {
    version: 2,
    up(db) {
      // SQLite cannot alter a column type in place: rebuild the table and
      // copy every row. `movies` is never the target of a foreign key, so
      // dropping it breaks no reference.
      db.exec(`
        CREATE TABLE movies_v2 (
          id         TEXT PRIMARY KEY,
          title      TEXT NOT NULL,
          watched_at TEXT NOT NULL,
          rating     REAL CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10)),
          note       TEXT NOT NULL DEFAULT '',
          tags       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT
      `)
      db.exec(
        'INSERT INTO movies_v2 (id, title, watched_at, rating, note, tags, created_at, updated_at) '
          + 'SELECT id, title, watched_at, rating, note, tags, created_at, updated_at FROM movies',
      )
      db.exec('DROP TABLE movies')
      db.exec('ALTER TABLE movies_v2 RENAME TO movies')
      db.exec('CREATE INDEX movies_watched_at ON movies (watched_at)')
    },
  },
]

/** Versioned rejection when the on-disk schema is newer than this build. */
export class SchemaVersionError extends Error {
  constructor(path: string, onDisk: number, current: number) {
    super(
      `dsh-personal: database at "${path}" has schema version ${onDisk}, newer than this build (${current})`,
    )
    this.name = 'SchemaVersionError'
  }
}

/**
 * Bring an opened personal database to the current schema version by applying
 * every pending migration in order. Each migration runs in one transaction
 * that also stamps its own version, so a failure rolls back to the previous
 * version and the next open retries the same migration.
 * @param db - the opened SQLite handle.
 * @param path - database path for error messages.
 * @throws {@link SchemaVersionError} when the database is from a newer build.
 */
export function migratePersonalDatabase(db: DatabaseSync, path: string): void {
  const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (onDisk > PERSONAL_SCHEMA_VERSION) throw new SchemaVersionError(path, onDisk, PERSONAL_SCHEMA_VERSION)
  for (const migration of PERSONAL_MIGRATIONS) {
    if (migration.version <= onDisk) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
