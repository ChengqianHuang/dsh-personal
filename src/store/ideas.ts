/**
 * SQLite stores for ideas and daily logs: insert, filtered listing, and text
 * search. Ideas are creation-dated; daily logs carry an explicit date column.
 * @module @deepseek-ai/dsh-personal/store/ideas
 */

import type { DatabaseSync } from 'node:sqlite'
import { personalSearchIndex } from './search.ts'
import { resolveSearchWeights } from '../config.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveWindow } from '../dates.ts'
import type { DailyLogFilter, DailyLogId, DailyLogRow, IdeaFilter, IdeaId, IdeaRow, ProjectId } from '../types.ts'
import {
  StatementCache,
  normalizeLimit,
  whereClause,
  windowClauses,
} from './statements.ts'

/** Raw `ideas` row as SQLite returns it. */
interface IdeaDbRow {
  id: string
  title: string
  content: string
  category: string
  related_project_id: string | null
  created_at: string
}

/** Raw `daily_logs` row as SQLite returns it. */
interface DailyLogDbRow {
  id: string
  date: string
  summary: string
  raw_text: string
  created_at: string
}

/** Insert payload for one idea; ids and timestamps come from the service. */
export interface IdeaInsert {
  id: string
  title: string
  content: string
  category: string
  relatedProjectId: string | null
  createdAt: string
}

/** Insert payload for one daily log; ids and timestamps come from the service. */
export interface DailyLogInsert {
  id: string
  date: string
  summary: string
  rawText: string
  createdAt: string
}

/** Durable idea store. */
export class IdeaStore {
  private readonly sql: StatementCache

  /** @param db - the opened personal database. */
  constructor(private readonly db: DatabaseSync) {
    this.sql = new StatementCache(db)
  }

  /** Map one raw row to the domain row. */
  private static toRow(raw: IdeaDbRow): IdeaRow {
    return {
      id: brandString<IdeaId>(raw.id),
      title: raw.title,
      content: raw.content,
      category: raw.category,
      relatedProjectId: raw.related_project_id === null ? null : brandString<ProjectId>(raw.related_project_id),
      createdAt: raw.created_at,
    }
  }

  /**
   * Insert one idea row.
   * @param insert - complete insert payload.
   */
  insert(insert: IdeaInsert): void {
    this.sql.run(
      'INSERT INTO ideas (id, title, content, category, related_project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      insert.id, insert.title, insert.content, insert.category, insert.relatedProjectId, insert.createdAt,
    )
  }

  /**
   * Read one idea by id.
   * @param id - idea id.
   * @returns the row, or undefined when absent.
   */
  get(id: IdeaId): IdeaRow | undefined {
    const raw = this.sql.get<IdeaDbRow>('SELECT * FROM ideas WHERE id = ?', id)
    return raw === undefined ? undefined : IdeaStore.toRow(raw)
  }

  /**
   * List ideas by category, oldest first.
   * @param filter - query filter.
   * @returns matching rows.
   */
  list(filter: IdeaFilter): IdeaRow[] {
    const limit = normalizeLimit(filter.limit)
    const { where, params } = whereClause([
      filter.category !== undefined
        ? { clauses: ['category = ? COLLATE NOCASE'], params: [filter.category] }
        : { clauses: [], params: [] },
    ])
    return this.sql.all<IdeaDbRow>(
      `SELECT * FROM ideas ${where} ORDER BY created_at, id LIMIT ?`,
      ...params, limit,
    ).map(row => IdeaStore.toRow(row))
  }

  /**
   * Ideas created inside an inclusive window, for reviews.
   * @param win - inclusive window bounds.
   * @returns matching rows, oldest first.
   */
  listCreatedBetween(win: { from?: string; to?: string }): IdeaRow[] {
    const { where, params } = whereClause([windowClauses('created_at', 'datetime', win)])
    return this.sql.all<IdeaDbRow>(
      `SELECT * FROM ideas ${where} ORDER BY created_at, id`,
      ...params,
    ).map(row => IdeaStore.toRow(row))
  }

  /**
   * Keyword-search ideas across title and content.
   * @param text - raw search text.
   * @param win - inclusive creation-window bounds.
   * @param limit - row cap.
   * @returns matching rows in relevance order.
   */
  searchText(text: string, win: { from?: string; to?: string }, limit: number): IdeaRow[] {
    return personalSearchIndex(this.db).search({
      text, ...win, types: ['idea'], limit, weights: resolveSearchWeights({}),
    }).hits.map(hit => hit.row as unknown as IdeaRow)
  }
}

/** Durable daily-log store. */
export class DailyLogStore {
  private readonly sql: StatementCache

  /**
   * @param db - the opened personal database.
   * @param timeZone - IANA zone resolving filter windows.
   */
  constructor(
    private readonly db: DatabaseSync,
    private readonly timeZone: string | undefined,
  ) {
    this.sql = new StatementCache(db)
  }

  /** Map one raw row to the domain row. */
  private static toRow(raw: DailyLogDbRow): DailyLogRow {
    return {
      id: brandString<DailyLogId>(raw.id),
      date: raw.date,
      summary: raw.summary,
      rawText: raw.raw_text,
      createdAt: raw.created_at,
    }
  }

  /**
   * Read one daily log by id.
   * @param id - log id.
   * @returns the row, or undefined when absent.
   */
  get(id: DailyLogId): DailyLogRow | undefined {
    const raw = this.sql.get<DailyLogDbRow>('SELECT * FROM daily_logs WHERE id = ?', id)
    return raw === undefined ? undefined : DailyLogStore.toRow(raw)
  }

  /**
   * Insert one daily-log row.
   * @param insert - complete insert payload.
   */
  insert(insert: DailyLogInsert): void {
    this.sql.run(
      'INSERT INTO daily_logs (id, date, summary, raw_text, created_at) VALUES (?, ?, ?, ?, ?)',
      insert.id, insert.date, insert.summary, insert.rawText, insert.createdAt,
    )
  }

  /**
   * List daily logs inside a window, newest date first.
   * @param filter - query filter.
   * @returns matching rows.
   */
  list(filter: DailyLogFilter): DailyLogRow[] {
    const limit = normalizeLimit(filter.limit)
    const win = resolveWindow(filter, this.timeZone)
    const { where, params } = whereClause([windowClauses('date', 'date', win)])
    return this.sql.all<DailyLogDbRow>(
      `SELECT * FROM daily_logs ${where} ORDER BY date DESC, id DESC LIMIT ?`,
      ...params, limit,
    ).map(row => DailyLogStore.toRow(row))
  }

  /**
   * Daily logs recorded on one calendar date.
   * @param date - `YYYY-MM-DD`.
   * @returns matching rows.
   */
  listOn(date: string): DailyLogRow[] {
    return this.sql.all<DailyLogDbRow>(
      'SELECT * FROM daily_logs WHERE date = ? ORDER BY created_at, id',
      date,
    ).map(row => DailyLogStore.toRow(row))
  }

  /**
   * Keyword-search logs across summary and raw text within a window.
   * @param text - raw search text.
   * @param win - inclusive window bounds.
   * @param limit - row cap.
   * @returns matching rows in relevance order.
   */
  searchText(text: string, win: { from?: string; to?: string }, limit: number): DailyLogRow[] {
    return personalSearchIndex(this.db).search({
      text, ...win, types: ['daily_log'], limit, weights: resolveSearchWeights({}),
    }).hits.map(hit => hit.row as unknown as DailyLogRow)
  }
}
