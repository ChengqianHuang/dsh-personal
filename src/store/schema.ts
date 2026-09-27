/**
 * SQLite schema for the personal plugin: the ordered migration list and the
 * monotonic migration runner. `PRAGMA user_version` is the schema version;
 * every migration applies once inside a transaction that also stamps its
 * version, so an interrupted migration leaves the previous version intact.
 * @module dsh-personal/store/schema
 */

import type { DatabaseSync } from 'node:sqlite'

/**
 * Current personal schema version. Bump by appending a migration; any on-disk
 * version that is not `0` (fresh) or the current version is rejected —
 * intermediate versions carry no automatic data migration.
 *
 * 1–2 — earlier movie-centric schemas; databases stamped with them are
 *       rejected at open with rebuild instructions (the experiences model
 *       intentionally does not migrate the old `movies` table).
 * 3   — the experiences model: `movies` is replaced by an open
 *       `experiences` table (category × action), relation types updated.
 */
export const PERSONAL_SCHEMA_VERSION = 3

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
    version: 3,
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
        CREATE TABLE experiences (
          id          TEXT PRIMARY KEY,
          category    TEXT NOT NULL,
          action      TEXT NOT NULL,
          title       TEXT NOT NULL,
          occurred_on TEXT NOT NULL,
          rating      REAL CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10)),
          note        TEXT NOT NULL DEFAULT '',
          tags        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
          created_at  TEXT NOT NULL
        ) STRICT
      `)
      db.exec('CREATE INDEX experiences_category_date ON experiences (category, occurred_on)')
      db.exec('CREATE INDEX experiences_occurred_on ON experiences (occurred_on)')
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
            ('experience', 'project', 'project_log', 'task', 'blog_post', 'website', 'idea', 'daily_log')),
          from_id       TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          to_type       TEXT NOT NULL CHECK (to_type IN
            ('experience', 'project', 'project_log', 'task', 'blog_post', 'website', 'idea', 'daily_log')),
          to_id         TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          UNIQUE (from_type, from_id, relation_type, to_type, to_id)
        ) STRICT
      `)
      db.exec('CREATE INDEX relations_from ON relations (from_type, from_id)')
      db.exec('CREATE INDEX relations_to ON relations (to_type, to_id)')
    },
  },
]

/** Rejection when the on-disk schema cannot be opened by this build. */
export class SchemaVersionError extends Error {
  constructor(path: string, onDisk: number, current: number) {
    super(
      onDisk > current
        ? `dsh-personal: database at "${path}" has schema version ${onDisk}, newer than this build (${current}); ` +
          'upgrade the plugin build and reopen.'
        : `dsh-personal: database at "${path}" uses schema version ${onDisk}, created by an older build; ` +
          `this build requires version ${current} (the experiences model has no data migration from older schemas). ` +
          `Move or delete the database file and restart to create a fresh one.`,
    )
    this.name = 'SchemaVersionError'
  }
}

/**
 * Bring an opened personal database to the current schema version by applying
 * every pending migration in order. Each migration runs in one transaction
 * that also stamps its own version, so a failure rolls back to the previous
 * version and the next open retries the same migration.
 *
 * Databases stamped with a retired version (below the oldest migration in the
 * list) are rejected with rebuild instructions instead of being silently
 * misread or deleted.
 * @param db - the opened SQLite handle.
 * @param path - database path for error messages.
 * @throws {@link SchemaVersionError} when the database is from a different,
 * incompatible schema generation.
 */
export function migratePersonalDatabase(db: DatabaseSync, path: string): void {
  const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (onDisk !== 0 && onDisk !== PERSONAL_SCHEMA_VERSION) {
    throw new SchemaVersionError(path, onDisk, PERSONAL_SCHEMA_VERSION)
  }
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
