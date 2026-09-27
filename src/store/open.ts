/**
 * Open procedure for the personal SQLite database: create the file with
 * owner-only permissions, refuse foreign or unrecognized databases, apply
 * connection pragmas, and run pending migrations. Mirrors the deliberate
 * per-package open-sequence convention of the session-query read model.
 * @module @deepseek-ai/dsh-personal/store/open
 */

import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { PERSONAL_APPLICATION_ID, migratePersonalDatabase } from './schema.ts'

/**
 * Open (creating if missing) the personal database at `path`.
 * @param path - database file path; missing parent directories are created owner-only. `:memory:` opens an in-memory database.
 * @returns the opened handle with pragmas applied and migrations current.
 * @throws when the file belongs to another application or carries an unrecognized schema.
 */
export async function openPersonalDatabase(path: string): Promise<DatabaseSync> {
  // Compare before resolving: `resolve(':memory:')` would produce a real
  // absolute path and silently create a file with that name.
  const inMemory = path === ':memory:'
  const actual = inMemory ? path : resolve(path)
  if (!inMemory) {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(actual)
  try {
    assertPersonalIdentity(db, actual)
    // Mutating pragmas apply only after the identity gate refused foreign files.
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    // Stamp before migrating: an interrupted first migration retries as our
    // own database instead of tripping the foreign-tables rejection.
    db.exec(`PRAGMA application_id = ${PERSONAL_APPLICATION_ID}`)
    migratePersonalDatabase(db, actual)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

/** Exclusively create a missing database file with owner-only permissions. */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    /* v8 ignore next -- only EEXIST is expected; every other errno is a real
       filesystem fault (permissions, ENOSPC) that must propagate unchanged. */
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Refuse any database that is neither a fresh empty file nor one this plugin
 * stamped, so personal data is never written into a foreign database and a
 * foreign reader sees the `PERS` fingerprint before touching ours.
 * @param db - the just-opened handle.
 * @param path - database path for error messages.
 * @throws on a foreign `application_id`, or unattributed user tables.
 */
function assertPersonalIdentity(db: DatabaseSync, path: string): void {
  const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
  const userTables = listUserTables(db)
  if (applicationId === PERSONAL_APPLICATION_ID) return
  if (applicationId === 0 && userTables.length === 0) return
  if (applicationId === 0) {
    throw new Error(`dsh-personal: database at "${path}" has unrecognized user tables: ${userTables.join(', ')}`)
  }
  throw new Error(`dsh-personal: database at "${path}" belongs to another application`)
}

function listUserTables(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}
