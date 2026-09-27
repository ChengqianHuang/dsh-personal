/**
 * SQLite store for experiences: anything the user already did — watched a
 * movie, read a book, listened to an album, visited an exhibition. Categories
 * and actions are open vocabulary (normalized at write and query),
 * so a new kind of experience needs no store, migration, or schema change.
 * @module dsh-personal/store/experiences
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveWindow } from '../dates.ts'
import type { ExperienceFilter, ExperienceId, ExperienceRow } from '../types.ts'
import {
  StatementCache,
  containsPattern,
  decodeTags,
  encodeTags,
  normalizeLimit,
  tagClause,
  whereClause,
  windowClauses,
  type SupportedValue,
} from './statements.ts'

/** Raw `experiences` row as SQLite returns it. */
interface ExperienceDbRow {
  id: string
  category: string
  action: string
  title: string
  occurred_on: string
  rating: number | null
  note: string
  tags: string
  created_at: string
}

/** Insert payload for one experience; ids and timestamps come from the service. */
export interface ExperienceInsert {
  id: string
  category: string
  action: string
  title: string
  occurredOn: string
  rating: number | null
  note: string
  tags: string[]
  createdAt: string
}

/**
 * Normalize a category or action word: trimmed, lowercased, internal
 * whitespace collapsed. Applied identically on write and query so stored
 * values and query terms always speak the same dialect.
 * @param value - raw caller word.
 * @returns the normalized word.
 */
export function normalizeCategoryAction(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, ' ')
}

/** Durable experience store. */
export class ExperienceStore {
  private readonly sql: StatementCache

  /**
   * @param db - the opened personal database.
   * @param timeZone - IANA zone resolving filter windows.
   */
  constructor(
    db: DatabaseSync,
    private readonly timeZone: string | undefined,
  ) {
    this.sql = new StatementCache(db)
  }

  /** Map one raw row to the domain row. */
  private static toRow(raw: ExperienceDbRow): ExperienceRow {
    return {
      id: brandString<ExperienceId>(raw.id),
      category: raw.category,
      action: raw.action,
      title: raw.title,
      occurredOn: raw.occurred_on,
      rating: raw.rating,
      note: raw.note,
      tags: decodeTags(raw.tags),
      createdAt: raw.created_at,
    }
  }

  /**
   * Insert one experience row. Category and action are stored normalized.
   * @param insert - complete insert payload.
   */
  insert(insert: ExperienceInsert): void {
    this.sql.run(
      'INSERT INTO experiences (id, category, action, title, occurred_on, rating, note, tags, created_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      insert.id, normalizeCategoryAction(insert.category), normalizeCategoryAction(insert.action),
      insert.title, insert.occurredOn, insert.rating, insert.note,
      encodeTags(insert.tags), insert.createdAt,
    )
  }

  /**
   * Read one experience by id.
   * @param id - experience id.
   * @returns the row, or undefined when absent.
   */
  get(id: ExperienceId): ExperienceRow | undefined {
    const raw = this.sql.get<ExperienceDbRow>('SELECT * FROM experiences WHERE id = ?', id)
    return raw === undefined ? undefined : ExperienceStore.toRow(raw)
  }

  /**
   * List experiences by canonical category, action, occurred-date window,
   * text, and tag, newest experience first.
   * @param filter - query filter.
   * @returns matching rows.
   */
  list(filter: ExperienceFilter): ExperienceRow[] {
    const limit = normalizeLimit(filter.limit)
    const win = resolveWindow(filter, this.timeZone)
    const parts: Array<{ clauses: string[]; params: SupportedValue[] }> = []
    if (filter.category !== undefined) {
      parts.push({
        clauses: ['category = ?'],
        params: [normalizeCategoryAction(filter.category)],
      })
    }
    if (filter.action !== undefined) {
      parts.push({
        clauses: ['action = ?'],
        params: [normalizeCategoryAction(filter.action)],
      })
    }
    if (filter.text !== undefined) parts.push(experienceTextClause(filter.text))
    const { where, params } = whereClause([
      ...parts,
      windowClauses('occurred_on', 'date', win),
      filter.tag !== undefined ? tagClause('tags', filter.tag) : { clauses: [], params: [] as SupportedValue[] },
    ])
    const raws = this.sql.all<ExperienceDbRow>(
      `SELECT * FROM experiences ${where} ORDER BY occurred_on DESC, id DESC LIMIT ?`,
      ...params, limit,
    )
    return raws.map(row => ExperienceStore.toRow(row))
  }

  /**
   * Substring-search experiences across title and note within a window.
   * @param text - raw search text.
   * @param win - inclusive window bounds.
   * @param limit - row cap.
   * @returns matching rows, newest experience first.
   */
  searchText(text: string, win: { from?: string; to?: string }, limit: number): ExperienceRow[] {
    const { where, params } = whereClause([
      windowClauses('occurred_on', 'date', win),
      experienceTextClause(text),
    ])
    const raws = this.sql.all<ExperienceDbRow>(
      `SELECT * FROM experiences ${where} ORDER BY occurred_on DESC, id DESC LIMIT ?`,
      ...params, limit,
    )
    return raws.map(row => ExperienceStore.toRow(row))
  }
}

/** Search the two free-text experience fields without treating caller text as SQL. */
function experienceTextClause(text: string): { clauses: string[]; params: SupportedValue[] } {
  const pattern = containsPattern(text)
  return {
    clauses: ['(title LIKE ? ESCAPE \'\\\' OR note LIKE ? ESCAPE \'\\\')'],
    params: [pattern, pattern],
  }
}
