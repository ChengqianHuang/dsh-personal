/**
 * SQLite store for movies: insert, point read, window and tag queries, and
 * text search over title and note. Row mapping to {@link MovieRow} lives here.
 * @module @deepseek-ai/dsh-personal/store/movies
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MovieFilter, MovieId, MovieRow } from '../types.ts'
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
import { resolveWindow } from '../dates.ts'

/** Raw `movies` row as SQLite returns it. */
interface MovieDbRow {
  id: string
  title: string
  watched_at: string
  rating: number | null
  note: string
  tags: string
  created_at: string
  updated_at: string
}

/** Insert payload for one movie; ids and timestamps come from the service. */
export interface MovieInsert {
  id: string
  title: string
  watchedAt: string
  rating: number | null
  note: string
  tags: string[]
  createdAt: string
}

/** Durable movie store. */
export class MovieStore {
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
  private static toRow(raw: MovieDbRow): MovieRow {
    return {
      id: brandString<MovieId>(raw.id),
      title: raw.title,
      watchedAt: raw.watched_at,
      rating: raw.rating,
      note: raw.note,
      tags: decodeTags(raw.tags),
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    }
  }

  /**
   * Insert one movie row.
   * @param insert - complete insert payload.
   */
  insert(insert: MovieInsert): void {
    this.sql.run(
      'INSERT INTO movies (id, title, watched_at, rating, note, tags, created_at, updated_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      insert.id, insert.title, insert.watchedAt, insert.rating, insert.note,
      encodeTags(insert.tags), insert.createdAt, insert.createdAt,
    )
  }

  /**
   * Read one movie by id.
   * @param id - movie id.
   * @returns the row, or undefined when absent.
   */
  get(id: MovieId): MovieRow | undefined {
    const raw = this.sql.get<MovieDbRow>('SELECT * FROM movies WHERE id = ?', id)
    return raw === undefined ? undefined : MovieStore.toRow(raw)
  }

  /**
   * List movies by watch-date window and tag, newest watch first.
   * @param filter - query filter.
   * @returns matching rows.
   */
  list(filter: MovieFilter): MovieRow[] {
    const limit = normalizeLimit(filter.limit)
    const win = resolveWindow(filter, this.timeZone)
    const { where, params } = whereClause([
      windowClauses('watched_at', 'date', win),
      filter.tag !== undefined ? tagClause('tags', filter.tag) : { clauses: [], params: [] as SupportedValue[] },
    ])
    const raws = this.sql.all<MovieDbRow>(
      `SELECT * FROM movies ${where} ORDER BY watched_at DESC, id DESC LIMIT ?`,
      ...params, limit,
    )
    return raws.map(row => MovieStore.toRow(row))
  }

  /**
   * Substring-search movies across title and note within a window.
   * @param text - raw search text.
   * @param win - inclusive window bounds.
   * @param limit - row cap.
   * @returns matching rows, newest watch first.
   */
  searchText(text: string, win: { from?: string; to?: string }, limit: number): MovieRow[] {
    const pattern = containsPattern(text)
    const { where, params } = whereClause([
      windowClauses('watched_at', 'date', win),
      { clauses: ['(title LIKE ? ESCAPE \'\\\' OR note LIKE ? ESCAPE \'\\\')'], params: [pattern, pattern] },
    ])
    const raws = this.sql.all<MovieDbRow>(
      `SELECT * FROM movies ${where} ORDER BY watched_at DESC, id DESC LIMIT ?`,
      ...params, limit,
    )
    return raws.map(row => MovieStore.toRow(row))
  }
}
