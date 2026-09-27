/**
 * SQLite store for blog posts: insert, update, point read, status and tag
 * queries, creation-window listing for reviews, and text search. Row mapping
 * to {@link BlogPostRow} lives here.
 * @module @deepseek-ai/dsh-personal/store/blogs
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BlogPostFilter, BlogPostId, BlogPostRow, BlogPostStatus, ProjectId } from '../types.ts'
import {
  StatementCache,
  containsPattern,
  decodeTags,
  encodeTags,
  normalizeLimit,
  nowIso,
  tagClause,
  updateAssignments,
  whereClause,
  windowClauses,
  type SupportedValue,
} from './statements.ts'

/** Raw `blog_posts` row as SQLite returns it. */
interface BlogPostDbRow {
  id: string
  title: string
  status: string
  summary: string
  content: string
  tags: string
  related_project_id: string | null
  created_at: string
  updated_at: string
}

/** Insert payload for one blog post; ids and timestamps come from the service. */
export interface BlogPostInsert {
  id: string
  title: string
  status: BlogPostStatus
  summary: string
  content: string
  tags: string[]
  relatedProjectId: string | null
  createdAt: string
}

/** Mutable blog-post patch; `undefined` leaves a column unchanged. */
export interface BlogPostPatch {
  title?: string
  status?: BlogPostStatus
  summary?: string
  content?: string
  tags?: string[]
}

/** Durable blog-post store. */
export class BlogPostStore {
  private readonly sql: StatementCache

  /** @param db - the opened personal database. */
  constructor(db: DatabaseSync) {
    this.sql = new StatementCache(db)
  }

  /** Map one raw row to the domain row. */
  private static toRow(raw: BlogPostDbRow): BlogPostRow {
    return {
      id: brandString<BlogPostId>(raw.id),
      title: raw.title,
      status: raw.status as BlogPostStatus,
      summary: raw.summary,
      content: raw.content,
      tags: decodeTags(raw.tags),
      relatedProjectId: raw.related_project_id === null
        ? null
        : brandString<ProjectId>(raw.related_project_id),
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    }
  }

  /**
   * Insert one blog-post row.
   * @param insert - complete insert payload.
   */
  insert(insert: BlogPostInsert): void {
    this.sql.run(
      'INSERT INTO blog_posts (id, title, status, summary, content, tags, related_project_id, '
        + 'created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      insert.id, insert.title, insert.status, insert.summary, insert.content, encodeTags(insert.tags),
      insert.relatedProjectId, insert.createdAt, insert.createdAt,
    )
  }

  /**
   * Read one blog post by id.
   * @param id - post id.
   * @returns the row, or undefined when absent.
   */
  get(id: BlogPostId): BlogPostRow | undefined {
    const raw = this.sql.get<BlogPostDbRow>('SELECT * FROM blog_posts WHERE id = ?', id)
    return raw === undefined ? undefined : BlogPostStore.toRow(raw)
  }

  /**
   * Apply a patch to one blog post; `updated_at` always moves.
   * @param id - post id.
   * @param patch - mutable fields.
   * @returns the updated row, or undefined when the id is unknown.
   */
  update(id: BlogPostId, patch: BlogPostPatch): BlogPostRow | undefined {
    const { sets, params } = updateAssignments(nowIso(), [
      ...(patch.title !== undefined ? [['title', patch.title] as const] : []),
      ...(patch.status !== undefined ? [['status', patch.status] as const] : []),
      ...(patch.summary !== undefined ? [['summary', patch.summary] as const] : []),
      ...(patch.content !== undefined ? [['content', patch.content] as const] : []),
      ...(patch.tags !== undefined ? [['tags', encodeTags(patch.tags)] as const] : []),
    ])
    this.sql.run(`UPDATE blog_posts SET ${sets} WHERE id = ?`, ...params, id)
    return this.get(id)
  }

  /**
   * List blog posts by status and tag, oldest first.
   * @param filter - query filter.
   * @returns matching rows.
   */
  list(filter: BlogPostFilter): BlogPostRow[] {
    const limit = normalizeLimit(filter.limit)
    const { where, params } = whereClause([
      filter.status !== undefined
        ? { clauses: ['status = ?'], params: [filter.status] }
        : { clauses: [], params: [] as SupportedValue[] },
      filter.tag !== undefined ? tagClause('tags', filter.tag) : { clauses: [], params: [] as SupportedValue[] },
    ])
    return this.sql.all<BlogPostDbRow>(
      `SELECT * FROM blog_posts ${where} ORDER BY created_at, id LIMIT ?`,
      ...params, limit,
    ).map(row => BlogPostStore.toRow(row))
  }

  /**
   * Blog posts created inside an inclusive window, for reviews.
   * @param win - inclusive window bounds.
   * @returns matching rows, oldest first.
   */
  listCreatedBetween(win: { from?: string; to?: string }): BlogPostRow[] {
    const { where, params } = whereClause([windowClauses('created_at', 'datetime', win)])
    return this.sql.all<BlogPostDbRow>(
      `SELECT * FROM blog_posts ${where} ORDER BY created_at, id`,
      ...params,
    ).map(row => BlogPostStore.toRow(row))
  }

  /**
   * Substring-search posts across title, summary, and content.
   * @param text - raw search text.
   * @param win - inclusive creation-window bounds.
   * @param limit - row cap.
   * @returns matching rows, newest first.
   */
  searchText(text: string, win: { from?: string; to?: string }, limit: number): BlogPostRow[] {
    const pattern = containsPattern(text)
    const { where, params } = whereClause([
      windowClauses('created_at', 'datetime', win),
      {
        clauses: [
          '(title LIKE ? ESCAPE \'\\\' OR summary LIKE ? ESCAPE \'\\\' OR content LIKE ? ESCAPE \'\\\')',
        ],
        params: [pattern, pattern, pattern],
      },
    ])
    return this.sql.all<BlogPostDbRow>(
      `SELECT * FROM blog_posts ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...params, limit,
    ).map(row => BlogPostStore.toRow(row))
  }
}
