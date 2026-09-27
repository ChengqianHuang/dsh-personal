/**
 * Shared SQLite plumbing for the personal stores: a prepared-statement cache,
 * timestamp and tag-JSON helpers, and filter-clause builders used by several
 * domains. Domain stores stay free of cross-domain SQL.
 * @module @deepseek-ai/dsh-personal/store/statements
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite'

/** Prepared-statement cache keyed by SQL text; one cache per database handle. */
export class StatementCache {
  private readonly cache = new Map<string, StatementSync>()

  constructor(private readonly db: DatabaseSync) {}

  /**
   * Prepare once and execute, returning the run summary.
   * @param sql - the SQL text; also the cache key.
   * @param params - bound parameters in placeholder order.
   * @returns the SQLite run summary (`changes`).
   */
  run(sql: string, ...params: SupportedValue[]): { changes: number | bigint } {
    return this.statement(sql).run(...params)
  }

  /**
   * Prepare once and select all rows, typed by the caller's row shape.
   * @param sql - the SQL text; also the cache key.
   * @param params - bound parameters in placeholder order.
   * @returns the selected rows.
   */
  all<T>(sql: string, ...params: SupportedValue[]): T[] {
    return this.statement(sql).all(...params) as T[]
  }

  /**
   * Prepare once and select the first row, or undefined. The type parameter
   * names the caller's row shape once at this boundary; node:sqlite itself
   * returns untyped rows.
   * @param sql - the SQL text; also the cache key.
   * @param params - bound parameters in placeholder order.
   * @returns the first row, or undefined.
   */
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- caller owns the row shape; the parameter is the boundary cast.
  get<T>(sql: string, ...params: SupportedValue[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined
  }

  private statement(sql: string): StatementSync {
    let statement = this.cache.get(sql)
    if (statement === undefined) {
      statement = this.db.prepare(sql)
      this.cache.set(sql, statement)
    }
    return statement
  }
}

/** Value types the personal schema stores; tags travel as JSON text. */
export type SupportedValue = string | number | bigint | null

/** Upper bound on any query's row return. */
export const MAX_QUERY_LIMIT = 200

/** Default row return when a caller omits a limit. */
export const DEFAULT_QUERY_LIMIT = 20

/**
 * Normalize a caller-supplied row limit.
 * @param limit - caller limit, or undefined for the default.
 * @returns the clamped limit in `1..200`.
 * @throws when the limit is not a positive integer.
 */
export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_QUERY_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`dsh-personal: limit must be a positive integer, got ${String(limit)}`)
  }
  return Math.min(limit, MAX_QUERY_LIMIT)
}

/**
 * Current wall-clock timestamp in the durable ISO format.
 * @returns e.g. `2026-09-26T12:34:56.789Z`.
 */
export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Encode a tag list for the JSON-text `tags` columns.
 * @param tags - caller tags, already validated as strings.
 * @returns the JSON text stored in the column.
 */
export function encodeTags(tags: string[]): string {
  return JSON.stringify(tags)
}

/**
 * Decode a stored `tags` column back to a list.
 * @param value - JSON text from the column.
 * @returns the tag list.
 */
export function decodeTags(value: string): string[] {
  return JSON.parse(value) as string[]
}

/**
 * Escape SQL `LIKE` metacharacters in caller text.
 * @param text - raw search text.
 * @returns text safe to embed in a `LIKE ? ESCAPE '\'` pattern.
 */
export function escapeLike(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/**
 * Build a case-insensitive substring pattern for `LIKE ? ESCAPE '\'`.
 * @param text - raw search text.
 * @returns the wrapped, escaped pattern.
 */
export function containsPattern(text: string): string {
  return `%${escapeLike(text)}%`
}

/**
 * Build the date-window clauses for one column. Date-only columns compare
 * directly; datetime columns compare against `[from, to + 1 day)` so an
 * inclusive caller window covers every timestamp of the end date.
 * @param column - the compared column.
 * @param kind - whether the column holds dates or ISO datetimes.
 * @param win - inclusive `from`/`to` bounds; each may be undefined.
 * @returns SQL clause fragments and their bound parameters, in order.
 */
export function windowClauses(
  column: string,
  kind: 'date' | 'datetime',
  win: { from?: string; to?: string },
): { clauses: string[]; params: SupportedValue[] } {
  const clauses: string[] = []
  const params: SupportedValue[] = []
  if (win.from !== undefined) {
    clauses.push(`${column} >= ?`)
    params.push(win.from)
  }
  if (win.to !== undefined) {
    clauses.push(kind === 'date' ? `${column} <= ?` : `${column} < date(?, '+1 day')`)
    params.push(win.to)
  }
  return { clauses, params }
}

/**
 * Build the exact tag-match clause using `json_each`.
 * @param column - the JSON-text `tags` column.
 * @param tag - tag value to match.
 * @returns the clause fragment and its parameter, in order.
 */
export function tagClause(column: string, tag: string): { clauses: string[]; params: SupportedValue[] } {
  return {
    clauses: [`EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ? COLLATE NOCASE)`],
    params: [tag],
  }
}

/**
 * Build a dynamic `UPDATE ... SET` body from column/value pairs, always
 * stamping `updated_at` first. Values must be fully resolved by the caller.
 * @param stamp - durable timestamp for `updated_at`.
 * @param pairs - column/value pairs in assignment order.
 * @returns the SET clause and its bound parameters, in order.
 */
export function updateAssignments(
  stamp: string,
  pairs: Array<readonly [string, SupportedValue]>,
): { sets: string; params: SupportedValue[] } {
  const assignments = ['updated_at = ?']
  const params: SupportedValue[] = [stamp]
  for (const [column, value] of pairs) {
    assignments.push(`${column} = ?`)
    params.push(value)
  }
  return { sets: assignments.join(', '), params }
}

/**
 * Join clause fragments with their shared parameter list.
 * @param parts - fragments and parameters from the builders above.
 * @returns a `WHERE` body (without the keyword) plus the flat parameter list.
 */
export function whereClause(parts: Array<{ clauses: string[]; params: SupportedValue[] }>): {
  where: string
  params: SupportedValue[]
} {
  const clauses = parts.flatMap(part => part.clauses)
  const params = parts.flatMap(part => part.params)
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params }
}
