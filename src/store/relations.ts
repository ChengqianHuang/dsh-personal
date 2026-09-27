/**
 * SQLite store for cross-object relations: insert, both-direction neighbor
 * lookup, and per-object listing. The uniqueness key makes repeated links
 * idempotent at the schema level.
 * @module @deepseek-ai/dsh-personal/store/relations
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PersonalObjectType, RelationId, RelationRow } from '../types.ts'
import { mintId } from './ids.ts'
import { StatementCache, nowIso } from './statements.ts'

/** Raw `relations` row as SQLite returns it. */
interface RelationDbRow {
  id: string
  from_type: string
  from_id: string
  relation_type: string
  to_type: string
  to_id: string
  created_at: string
}

/** Insert payload for one relation; ids and timestamps come from the service. */
export interface RelationInsert {
  fromType: PersonalObjectType
  fromId: string
  relationType: string
  toType: PersonalObjectType
  toId: string
  createdAt: string
}

/** Durable relation store. */
export class RelationStore {
  private readonly sql: StatementCache

  /** @param db - the opened personal database. */
  constructor(db: DatabaseSync) {
    this.sql = new StatementCache(db)
  }

  /** Map one raw row to the domain row. */
  private static toRow(raw: RelationDbRow): RelationRow {
    return {
      id: brandString<RelationId>(raw.id),
      fromType: raw.from_type as PersonalObjectType,
      fromId: raw.from_id,
      relationType: raw.relation_type,
      toType: raw.to_type as PersonalObjectType,
      toId: raw.to_id,
      createdAt: raw.created_at,
    }
  }

  /**
   * Link two objects; re-linking an existing pair is a no-op returning the
   * stored row, so callers can associate without dedup logic.
   * @param from - source object type and id.
   * @param relationType - free-form relation label.
   * @param to - target object type and id.
   * @returns the stored relation row.
   */
  link(
    from: { type: PersonalObjectType; id: string },
    relationType: string,
    to: { type: PersonalObjectType; id: string },
  ): RelationRow {
    const existing = this.sql.get<RelationDbRow>(
      'SELECT * FROM relations WHERE from_type = ? AND from_id = ? AND relation_type = ? '
        + 'AND to_type = ? AND to_id = ?',
      from.type, from.id, relationType, to.type, to.id,
    )
    if (existing !== undefined) return RelationStore.toRow(existing)
    const createdAt = nowIso()
    const id = mintId('rel')
    this.sql.run(
      'INSERT INTO relations (id, from_type, from_id, relation_type, to_type, to_id, created_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, from.type, from.id, relationType, to.type, to.id, createdAt,
    )
    return {
      id: brandString<RelationId>(id),
      fromType: from.type,
      fromId: from.id,
      relationType,
      toType: to.type,
      toId: to.id,
      createdAt,
    }
  }

  /**
   * Relations leaving one object.
   * @param type - object type.
   * @param id - object id.
   * @returns matching rows, oldest first.
   */
  listFrom(type: PersonalObjectType, id: string): RelationRow[] {
    return this.sql.all<RelationDbRow>(
      'SELECT * FROM relations WHERE from_type = ? AND from_id = ? ORDER BY created_at, id',
      type, id,
    ).map(row => RelationStore.toRow(row))
  }

  /**
   * Relations arriving at one object.
   * @param type - object type.
   * @param id - object id.
   * @returns matching rows, oldest first.
   */
  listTo(type: PersonalObjectType, id: string): RelationRow[] {
    return this.sql.all<RelationDbRow>(
      'SELECT * FROM relations WHERE to_type = ? AND to_id = ? ORDER BY created_at, id',
      type, id,
    ).map(row => RelationStore.toRow(row))
  }
}
