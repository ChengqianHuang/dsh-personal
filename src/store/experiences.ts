/**
 * SQLite store for experiences: anything the user already did — watched a
 * movie, read a book, listened to an album, visited an exhibition. Categories
 * and actions are open vocabulary (normalized at write, expanded at query),
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

/**
 * Query variants for one category or action word: the normalized term plus
 * its deterministic singular/plural counterpart, so a query for `movies`
 * finds rows written as `movie` (and vice versa) without pretending to parse
 * English — `series` expands to the harmless extra `serie` that never matches.
 * @param value - raw query word.
 * @returns the normalized term and its counterpart, deduplicated.
 */
export function categoryQueryVariants(value: string): string[] {
  const base = normalizeCategoryAction(value)
  if (base.length === 0) return [base]
  const counterpart = base.endsWith('s') && base.length > 3 ? base.slice(0, -1) : `${base}s`
  return base === counterpart ? [base] : [base, counterpart]
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
   * List experiences by category, action, occurred-date window, and tag,
   * newest experience first. Category and action accept singular or plural
   * query words (see {@link categoryQueryVariants}).
   * @param filter - query filter.
   * @returns matching rows.
   */
  list(filter: ExperienceFilter): ExperienceRow[] {
    const limit = normalizeLimit(filter.limit)
    const win = resolveWindow(filter, this.timeZone)
    const parts: Array<{ clauses: string[]; params: SupportedValue[] }> = []
    if (filter.category !== undefined) {
      parts.push({
        clauses: [`category IN (${categoryQueryVariants(filter.category).map(() => '?').join(', ')})`],
        params: categoryQueryVariants(filter.category),
      })
    }
    if (filter.action !== undefined) {
      parts.push({
        clauses: [`action IN (${categoryQueryVariants(filter.action).map(() => '?').join(', ')})`],
        params: categoryQueryVariants(filter.action),
      })
    }
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
    const pattern = containsPattern(text)
    const { where, params } = whereClause([
      windowClauses('occurred_on', 'date', win),
      { clauses: ['(title LIKE ? ESCAPE \'\\\' OR note LIKE ? ESCAPE \'\\\')'], params: [pattern, pattern] },
    ])
    const raws = this.sql.all<ExperienceDbRow>(
      `SELECT * FROM experiences ${where} ORDER BY occurred_on DESC, id DESC LIMIT ?`,
      ...params, limit,
    )
    return raws.map(row => ExperienceStore.toRow(row))
  }
}
