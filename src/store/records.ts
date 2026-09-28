/**
 * Exact-id record snapshots and allowlisted edits over the eight personal tables.
 * Mutations compare a content revision inside the caller's write transaction.
 * @module dsh-personal/store/records
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PersonalObjectType, PersonalRecordId, RecordRevision, RecordSnapshot } from '../types.ts'
import { StatementCache, type SupportedValue } from './statements.ts'

/** Durable table names; callers never supply SQL identifiers. */
export const RECORD_TABLES: Record<PersonalObjectType, string> = {
  experience: 'experiences', project: 'projects', project_log: 'project_logs', task: 'tasks',
  blog_post: 'blog_posts', website: 'websites', idea: 'ideas', daily_log: 'daily_logs',
}

/** Snapshot reads and writes; the service owns transactions and validation. */
export class RecordStore {
  private readonly sql: StatementCache

  /** @param db - the shared personal database connection. */
  constructor(db: DatabaseSync) { this.sql = new StatementCache(db) }

  /**
   * Read an exact id and derive a revision from all durable fields.
   * @param type - object kind.
   * @param id - exact record id.
   * @returns full camelCase row and revision, or undefined.
   */
  get(type: PersonalObjectType, id: PersonalRecordId): RecordSnapshot | undefined {
    const raw = this.sql.get<Record<string, SupportedValue>>(`SELECT * FROM ${RECORD_TABLES[type]} WHERE id = ?`, id)
    if (raw === undefined) return undefined
    const row: Record<string, JsonValue> = {}
    for (const [column, value] of Object.entries(raw)) {
      const key = column.replaceAll(/_([a-z])/g, (_match: string, letter: string) => letter.toUpperCase())
      row[key] = column === 'tags' ? JSON.parse(String(value)) as JsonValue : value as JsonValue
    }
    const revision = createHash('sha256').update(JSON.stringify([type, raw])).digest('hex')
    return { type, row, revision: brandString<RecordRevision>(revision) }
  }

  /**
   * Reject missing or stale targets; the caller holds BEGIN IMMEDIATE.
   * @param type - object kind.
   * @param id - exact record id.
   * @param revision - token from get_personal_record.
   * @returns the current snapshot.
   */
  requireCurrent(type: PersonalObjectType, id: PersonalRecordId, revision: RecordRevision): RecordSnapshot {
    const current = this.get(type, id)
    if (current === undefined) throw new Error(`dsh-personal: unknown ${type} id ${JSON.stringify(id)}`)
    if (current.revision !== revision) {
      throw new Error('dsh-personal: record changed; read it again and reconsider the requested edit before retrying')
    }
    return current
  }

  /**
   * Apply validated column values; only the edit parser supplies these pairs.
   * @param type - object kind.
   * @param id - exact record id.
   * @param pairs - allowlisted columns and normalized values.
   */
  update(type: PersonalObjectType, id: PersonalRecordId, pairs: Array<readonly [string, SupportedValue]>): void {
    this.sql.run(`UPDATE ${RECORD_TABLES[type]} SET ${pairs.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`,
      ...pairs.map(([, value]) => value), id)
  }

  /**
   * Find durable references that block deletion; relations are removable links.
   * @param type - target kind.
   * @param id - exact target id.
   * @returns referring kind and id pairs, without a result cap.
   */
  references(type: PersonalObjectType, id: PersonalRecordId): Array<{ type: PersonalObjectType; id: PersonalRecordId }> {
    const refs: Array<{ type: PersonalObjectType; id: PersonalRecordId }> = []
    const columns: Array<readonly [PersonalObjectType, string]> = type === 'project'
      ? [['project_log', 'project_id'], ['task', 'project_id'], ['blog_post', 'related_project_id'], ['idea', 'related_project_id']]
      : type === 'website' ? [['task', 'website_id']] : []
    for (const [kind, column] of columns) {
      for (const row of this.sql.all<{ id: string }>(`SELECT id FROM ${RECORD_TABLES[kind]} WHERE ${column} = ?`, id)) {
        refs.push({ type: kind, id: brandString<PersonalRecordId>(row.id) })
      }
    }
    for (const row of this.sql.all<{ id: string }>('SELECT id FROM tasks WHERE source_type = ? AND source_id = ?', type, id)) {
      // A self-reference disappears with the row itself.
      if (type !== 'task' || row.id !== id) refs.push({ type: 'task', id: brandString<PersonalRecordId>(row.id) })
    }
    return refs
  }

  /**
   * Delete one target and its explicit relation endpoints atomically.
   * @param type - target kind.
   * @param id - exact target id.
   * @returns the number of removed relations.
   */
  delete(type: PersonalObjectType, id: PersonalRecordId): number {
    const refs = this.references(type, id)
    if (refs.length > 0) throw new Error(`dsh-personal: record is referenced; unlink or reassign these records first: ${JSON.stringify(refs)}`)
    const { changes } = this.sql.run('DELETE FROM relations WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)', type, id, type, id)
    this.sql.run(`DELETE FROM ${RECORD_TABLES[type]} WHERE id = ?`, id)
    return Number(changes)
  }
}
