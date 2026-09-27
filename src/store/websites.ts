/**
 * SQLite store for websites: insert, point reads by id and unique domain,
 * tag queries, and text search. Row mapping to {@link WebsiteRow} lives here.
 * @module @deepseek-ai/dsh-personal/store/websites
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WebsiteFilter, WebsiteId, WebsiteRow } from '../types.ts'
import {
  StatementCache,
  containsPattern,
  decodeTags,
  encodeTags,
  normalizeLimit,
  tagClause,
  whereClause,
  type SupportedValue,
} from './statements.ts'

/** Raw `websites` row as SQLite returns it. */
interface WebsiteDbRow {
  id: string
  name: string
  domain: string
  repo: string
  hosting: string
  description: string
  tags: string
  created_at: string
  updated_at: string
}

/** Insert payload for one website; ids and timestamps come from the service. */
export interface WebsiteInsert {
  id: string
  name: string
  domain: string
  repo: string
  hosting: string
  description: string
  tags: string[]
  createdAt: string
}

/** Durable website store. */
export class WebsiteStore {
  private readonly sql: StatementCache

  /** @param db - the opened personal database. */
  constructor(db: DatabaseSync) {
    this.sql = new StatementCache(db)
  }

  /** Map one raw row to the domain row. */
  private static toRow(raw: WebsiteDbRow): WebsiteRow {
    return {
      id: brandString<WebsiteId>(raw.id),
      name: raw.name,
      domain: raw.domain,
      repo: raw.repo,
      hosting: raw.hosting,
      description: raw.description,
      tags: decodeTags(raw.tags),
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    }
  }

  /**
   * Insert one website row.
   * @param insert - complete insert payload.
   */
  insert(insert: WebsiteInsert): void {
    this.sql.run(
      'INSERT INTO websites (id, name, domain, repo, hosting, description, tags, created_at, updated_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      insert.id, insert.name, insert.domain, insert.repo, insert.hosting, insert.description,
      encodeTags(insert.tags), insert.createdAt, insert.createdAt,
    )
  }

  /**
   * Read one website by id.
   * @param id - website id.
   * @returns the row, or undefined when absent.
   */
  get(id: WebsiteId): WebsiteRow | undefined {
    const raw = this.sql.get<WebsiteDbRow>('SELECT * FROM websites WHERE id = ?', id)
    return raw === undefined ? undefined : WebsiteStore.toRow(raw)
  }

  /**
   * Read one website by its unique domain.
   * @param domain - exact domain.
   * @returns the row, or undefined when absent.
   */
  getByDomain(domain: string): WebsiteRow | undefined {
    const raw = this.sql.get<WebsiteDbRow>('SELECT * FROM websites WHERE domain = ?', domain)
    return raw === undefined ? undefined : WebsiteStore.toRow(raw)
  }

  /**
   * List websites by tag, oldest first.
   * @param filter - query filter.
   * @returns matching rows.
   */
  list(filter: WebsiteFilter): WebsiteRow[] {
    const limit = normalizeLimit(filter.limit)
    const { where, params } = whereClause([
      filter.tag !== undefined ? tagClause('tags', filter.tag) : { clauses: [], params: [] as SupportedValue[] },
    ])
    return this.sql.all<WebsiteDbRow>(
      `SELECT * FROM websites ${where} ORDER BY created_at, id LIMIT ?`,
      ...params, limit,
    ).map(row => WebsiteStore.toRow(row))
  }

  /**
   * Substring-search websites across name, domain, and description.
   * @param text - raw search text.
   * @param limit - row cap.
   * @returns matching rows.
   */
  searchText(text: string, limit: number): WebsiteRow[] {
    const pattern = containsPattern(text)
    return this.sql.all<WebsiteDbRow>(
      'SELECT * FROM websites WHERE name LIKE ? ESCAPE \'\\\' OR domain LIKE ? ESCAPE \'\\\' '
        + 'OR description LIKE ? ESCAPE \'\\\' ORDER BY created_at, id LIMIT ?',
      pattern, pattern, pattern, limit,
    ).map(row => WebsiteStore.toRow(row))
  }
}
