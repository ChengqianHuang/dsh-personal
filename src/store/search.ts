/**
 * Connection-local FTS5 index derived from personal rows. TEMP triggers keep
 * local writes transactional; data_version detects commits by other connections.
 * The durable schema and independently writable database stay unchanged.
 * @module dsh-personal/store/search
 */

import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { initSync, cut, cut_for_search } from 'jieba-wasm/web'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PersonalObjectType, SearchPersonalResult, SearchWeights } from '../types.ts'
import { normalizeLimit, type SupportedValue } from './statements.ts'

// The ESM entry avoids the package's CommonJS Node wrapper. Its WASM bytes
// resolve beside that entry in both source and the externalized bundle.
initSync({ module: readFileSync(new URL('./jieba_rs_wasm_bg.wasm', import.meta.resolve('jieba-wasm/web'))) })

interface DocumentSource {
  type: PersonalObjectType
  table: string
  title: string
  body: string
  date: string
  tags: string
}

const SOURCES: readonly DocumentSource[] = [
  { type: 'experience', table: 'experiences', title: 'title', body: 'note', date: 'occurred_on', tags: 'tags' },
  { type: 'project', table: 'projects', title: 'name', body: 'description', date: 'created_at', tags: "'[]'" },
  { type: 'project_log', table: 'project_logs', title: 'title', body: 'content', date: 'date', tags: 'tags' },
  { type: 'task', table: 'tasks', title: 'title', body: "''", date: 'created_at', tags: "'[]'" },
  { type: 'blog_post', table: 'blog_posts', title: 'title', body: "summary || ' ' || content", date: 'created_at', tags: 'tags' },
  { type: 'website', table: 'websites', title: "name || ' ' || domain", body: "description || ' ' || repo || ' ' || hosting", date: 'created_at', tags: 'tags' },
  { type: 'idea', table: 'ideas', title: 'title', body: "content || ' ' || category", date: 'created_at', tags: "'[]'" },
  { type: 'daily_log', table: 'daily_logs', title: 'summary', body: 'raw_text', date: 'date', tags: "'[]'" },
]

/** Internal filters already resolved to inclusive ISO dates and canonical keys. */
export interface SearchFilter {
  text: string
  match?: 'all' | 'any' | undefined
  types?: PersonalObjectType[] | undefined
  from?: string
  to?: string
  category?: string | undefined
  action?: string | undefined
  tag?: string | undefined
  limit?: number | undefined
  weights: SearchWeights
}

/**
 * Split normalized input into Chinese words and Latin/number tokens. Query
 * syntax and punctuation never become FTS operators. Search-mode indexing
 * additionally includes Jieba's shorter compound words.
 * @param text - text from a record or query.
 * @param indexing - whether to include compound subwords.
 * @returns tokens in text order, including repeats in indexed documents.
 */
export function tokenizeSearch(text: string, indexing = false): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  // jieba-wasm declares its array elements as any; its cut API returns strings.
  const words = (indexing ? cut_for_search(normalized, true) : cut(normalized, true)) as string[]
  return words.flatMap(word => word.match(/[\p{L}\p{N}]+/gu) ?? [])
}

const indexes = new WeakMap<DatabaseSync, PersonalSearchIndex>()

/**
 * Get the one derived index belonging to this connection.
 * @param db - open personal database; closing it also drops its TEMP index.
 * @returns the lazily initialized search index.
 */
export function personalSearchIndex(db: DatabaseSync): PersonalSearchIndex {
  let index = indexes.get(db)
  if (index === undefined) {
    index = new PersonalSearchIndex(db)
    indexes.set(db, index)
  }
  return index
}

/** FTS5 retrieval with one relevance order and a global result limit. */
export class PersonalSearchIndex {
  private dataVersion: number | undefined
  private readonly projections: string[]

  /**
   * Install a private index and triggers. Existing rows are indexed on first search.
   * @param db - connection owning all TEMP objects and the read snapshots.
   */
  constructor(private readonly db: DatabaseSync) {
    db.exec('PRAGMA temp_store = MEMORY')
    db.function('personal_search_tokens', { deterministic: true }, value => tokenizeSearch(String(value), true).join(' '))
    db.exec(`CREATE VIRTUAL TABLE temp.personal_search_documents USING fts5(
      title, tags, body,
      object_type UNINDEXED, object_id UNINDEXED, occurred_on UNINDEXED,
      row_json UNINDEXED, category UNINDEXED, action UNINDEXED, tag_json UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    )`)
    this.projections = SOURCES.map(source => {
      const columns = db.prepare(`PRAGMA main.table_info(${source.table})`).all() as Array<{ name: string }>
      const rowJson = 'json_object(' + columns.flatMap(({ name }) => [
        `'${name.replaceAll(/_([a-z])/g, (_match: string, letter: string) => letter.toUpperCase())}'`,
        name === 'tags' ? 'json(tags)' : name,
      ]).join(', ') + ')'
      const category = source.type === 'experience' ? 'category' : "''"
      const action = source.type === 'experience' ? 'action' : "''"
      const select = `SELECT personal_search_tokens(${source.title}), personal_search_tokens(${source.tags}),
        personal_search_tokens(${source.body}), '${source.type}', id, substr(${source.date}, 1, 10),
        ${rowJson}, ${category}, ${action}, ${source.tags} FROM main.${source.table}`
      const insert = `INSERT INTO personal_search_documents ${select}`
      const remove = `DELETE FROM personal_search_documents WHERE object_type = '${source.type}' AND object_id = old.id;`
      db.exec(`CREATE TEMP TRIGGER personal_search_${source.table}_insert AFTER INSERT ON main.${source.table}
        BEGIN ${insert} WHERE id = new.id; END`)
      db.exec(`CREATE TEMP TRIGGER personal_search_${source.table}_update AFTER UPDATE ON main.${source.table}
        BEGIN ${remove} ${insert} WHERE id = new.id; END`)
      db.exec(`CREATE TEMP TRIGGER personal_search_${source.table}_delete AFTER DELETE ON main.${source.table}
        BEGIN ${remove} END`)
      return insert
    })
  }

  /**
   * Retrieve a consistent snapshot, synchronizing external commits first.
   * Title, tag, and body weights feed SQLite BM25; lower BM25 ranks come first.
   * Ties use newest date, object type, and id. Must be called outside a transaction.
   * @param filter - terms, matching mode, metadata filters, weights, and global cap.
   * @returns normalized query terms and globally ranked domain rows.
   */
  search(filter: SearchFilter): SearchPersonalResult {
    const limit = normalizeLimit(filter.limit)
    const terms = [...new Set(tokenizeSearch(filter.text))]
    if (terms.length === 0 || filter.types?.length === 0) return { terms, hits: [] }
    const expression = terms.map(term => `"${term}"`).join(filter.match === 'any' ? ' OR ' : ' AND ')
    const clauses = ['personal_search_documents MATCH ?']
    const params: SupportedValue[] = [expression]
    if (filter.types !== undefined) {
      clauses.push(`object_type IN (${filter.types.map(() => '?').join(', ')})`)
      params.push(...filter.types)
    }
    for (const [column, value, operator] of [
      ['occurred_on', filter.from, '>='], ['occurred_on', filter.to, '<='],
      ['category', filter.category, '='], ['action', filter.action, '='],
    ] as const) {
      if (value !== undefined) { clauses.push(`${column} ${operator} ?`); params.push(value) }
    }
    if (filter.tag !== undefined) {
      clauses.push('EXISTS (SELECT 1 FROM json_each(tag_json) WHERE value = ? COLLATE NOCASE)')
      params.push(filter.tag)
    }
    this.db.exec('BEGIN')
    try {
      // Reading a durable table pins the WAL snapshot before checking the
      // connection-local counter, so rebuild and retrieval see the same commit.
      this.db.prepare('SELECT id FROM main.experiences LIMIT 1').get()
      const { data_version: version } = this.db.prepare('PRAGMA main.data_version').get() as { data_version: number }
      if (version !== this.dataVersion) {
        this.db.exec('DELETE FROM personal_search_documents')
        for (const projection of this.projections) this.db.exec(projection)
      }
      const rows = this.db.prepare(`SELECT object_type, row_json,
        bm25(personal_search_documents, ?, ?, ?) AS score
        FROM personal_search_documents WHERE ${clauses.join(' AND ')}
        ORDER BY score, occurred_on DESC, object_type, object_id LIMIT ?`).all(
        filter.weights.title, filter.weights.tags, filter.weights.body, ...params, limit,
      ) as Array<{ object_type: PersonalObjectType; row_json: string; score: number }>
      const hits = rows.map(row => ({ type: row.object_type, score: -row.score, row: JSON.parse(row.row_json) as JsonValue }))
      this.db.exec('COMMIT')
      this.dataVersion = version
      return { terms, hits }
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
