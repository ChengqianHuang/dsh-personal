/**
 * SQLite store for tasks, including the `done_at` transition rule: entering
 * `DONE` stamps the completion date and any other status clears it. The
 * stamp's calendar date comes from the repository's configured zone.
 * @module @deepseek-ai/dsh-personal/store/tasks
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import { todayIso, weekRangeOf } from '../dates.ts'
import type {
  ProjectId,
  TaskDueFilter,
  TaskFilter,
  TaskId,
  TaskPriority,
  TaskRow,
  TaskStatus,
  WebsiteId,
} from '../types.ts'
import {
  StatementCache,
  containsPattern,
  normalizeLimit,
  nowIso,
  updateAssignments,
  whereClause,
  windowClauses,
  type SupportedValue,
} from './statements.ts'

/** Raw `tasks` row as SQLite returns it. */
interface TaskDbRow {
  id: string
  title: string
  status: string
  priority: string
  due_at: string | null
  done_at: string | null
  project_id: string | null
  website_id: string | null
  source_type: string | null
  source_id: string | null
  created_at: string
  updated_at: string
}

/** Insert payload for one task; ids and timestamps come from the service. */
export interface TaskInsert {
  id: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  dueAt: string | null
  projectId: string | null
  websiteId: string | null
  sourceType: string | null
  sourceId: string | null
  createdAt: string
}

/** Mutable task patch; `undefined` leaves a column unchanged. */
export interface TaskPatch {
  title?: string
  status?: TaskStatus
  priority?: TaskPriority
  dueAt?: string | null
}

/** Durable task store. */
export class TaskStore {
  private readonly sql: StatementCache

  /**
   * @param db - the opened personal database.
   * @param timeZone - IANA zone stamping completion dates and resolving due filters.
   */
  constructor(
    db: DatabaseSync,
    private readonly timeZone: string | undefined,
  ) {
    this.sql = new StatementCache(db)
  }

  /** Map one raw row to the domain row. */
  private static toRow(raw: TaskDbRow): TaskRow {
    return {
      id: brandString<TaskId>(raw.id),
      title: raw.title,
      status: raw.status as TaskStatus,
      priority: raw.priority as TaskPriority,
      dueAt: raw.due_at,
      doneAt: raw.done_at,
      projectId: raw.project_id === null ? null : brandString<ProjectId>(raw.project_id),
      websiteId: raw.website_id === null ? null : brandString<WebsiteId>(raw.website_id),
      sourceType: raw.source_type,
      sourceId: raw.source_id,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    }
  }

  /**
   * Insert one task row. A task created directly in `DONE` is stamped with
   * today's completion date in the configured zone.
   * @param insert - complete insert payload.
   */
  insert(insert: TaskInsert): void {
    const doneAt = insert.status === 'DONE' ? todayIso(this.timeZone) : null
    this.sql.run(
      'INSERT INTO tasks (id, title, status, priority, due_at, done_at, project_id, website_id, '
        + 'source_type, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      insert.id, insert.title, insert.status, insert.priority, insert.dueAt, doneAt,
      insert.projectId, insert.websiteId, insert.sourceType, insert.sourceId,
      insert.createdAt, insert.createdAt,
    )
  }

  /**
   * Read one task by id.
   * @param id - task id.
   * @returns the row, or undefined when absent.
   */
  get(id: TaskId): TaskRow | undefined {
    const raw = this.sql.get<TaskDbRow>('SELECT * FROM tasks WHERE id = ?', id)
    return raw === undefined ? undefined : TaskStore.toRow(raw)
  }

  /**
   * Apply a patch to one task. Entering `DONE` stamps `done_at` with today in
   * the configured zone; any other status clears it. `updated_at` always moves.
   * @param id - task id.
   * @param patch - mutable fields.
   * @returns the updated row, or undefined when the id is unknown.
   */
  update(id: TaskId, patch: TaskPatch): TaskRow | undefined {
    const { sets, params } = updateAssignments(nowIso(), [
      ...(patch.title !== undefined ? [['title', patch.title] as const] : []),
      ...(patch.status !== undefined
        ? ([[ 'status', patch.status ], [ 'done_at', patch.status === 'DONE' ? todayIso(this.timeZone) : null ]] as Array<readonly [string, SupportedValue]>)
        : []),
      ...(patch.priority !== undefined ? [['priority', patch.priority] as const] : []),
      ...(patch.dueAt !== undefined ? [['due_at', patch.dueAt] as const] : []),
    ])
    this.sql.run(`UPDATE tasks SET ${sets} WHERE id = ?`, ...params, id)
    return this.get(id)
  }

  /**
   * List tasks by status, priority, due selection, and links.
   * @param filter - query filter.
   * @returns matching rows, soonest due first with undated last.
   */
  list(filter: TaskFilter): TaskRow[] {
    const limit = normalizeLimit(filter.limit)
    const parts: Array<{ clauses: string[]; params: SupportedValue[] }> = []
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      parts.push({
        clauses: [`status IN (${filter.statuses.map(() => '?').join(', ')})`],
        params: [...filter.statuses],
      })
    }
    if (filter.priority !== undefined) {
      parts.push({ clauses: ['priority = ?'], params: [filter.priority] })
    }
    if (filter.projectId !== undefined) {
      parts.push({ clauses: ['project_id = ?'], params: [filter.projectId] })
    }
    if (filter.websiteId !== undefined) {
      parts.push({ clauses: ['website_id = ?'], params: [filter.websiteId] })
    }
    if (filter.due !== undefined) parts.push(this.dueClauses(filter.due))
    const { where, params } = whereClause(parts)
    const raws = this.sql.all<TaskDbRow>(
      `SELECT * FROM tasks ${where} ORDER BY due_at IS NULL, due_at, id LIMIT ?`,
      ...params, limit,
    )
    return raws.map(row => TaskStore.toRow(row))
  }

  /**
   * Tasks completed on one calendar date.
   * @param date - `YYYY-MM-DD`.
   * @returns matching rows, newest update first.
   */
  listDoneOn(date: string): TaskRow[] {
    return this.sql.all<TaskDbRow>(
      "SELECT * FROM tasks WHERE status = 'DONE' AND done_at = ? ORDER BY updated_at DESC, id",
      date,
    ).map(row => TaskStore.toRow(row))
  }

  /**
   * Tasks completed inside an inclusive window, for reviews.
   * @param win - inclusive window bounds on `done_at`.
   * @returns matching rows, newest completion first.
   */
  listDoneBetween(win: { from?: string; to?: string }): TaskRow[] {
    const { where, params } = whereClause([
      { clauses: ["status = 'DONE'"], params: [] },
      windowClauses('done_at', 'date', win),
    ])
    return this.sql.all<TaskDbRow>(
      `SELECT * FROM tasks ${where} ORDER BY done_at DESC, id`,
      ...params,
    ).map(row => TaskStore.toRow(row))
  }

  /**
   * Tasks still open (TODO or DOING), soonest due first.
   * @returns open task rows.
   */
  listOpen(): TaskRow[] {
    return this.sql.all<TaskDbRow>(
      "SELECT * FROM tasks WHERE status IN ('TODO', 'DOING') ORDER BY due_at IS NULL, due_at, id",
    ).map(row => TaskStore.toRow(row))
  }

  /**
   * Tasks open and due inside an inclusive window, for reviews.
   * @param win - inclusive window bounds.
   * @returns matching rows, soonest due first.
   */
  listOpenDueBetween(win: { from?: string; to?: string }): TaskRow[] {
    const { where, params } = whereClause([
      { clauses: ["status IN ('TODO', 'DOING')"], params: [] },
      windowClauses('due_at', 'date', win),
    ])
    return this.sql.all<TaskDbRow>(
      `SELECT * FROM tasks ${where} ORDER BY due_at, id`,
      ...params,
    ).map(row => TaskStore.toRow(row))
  }

  /**
   * Substring-search tasks across title.
   * @param text - raw search text.
   * @param win - window bounds; tasks compare on their due date.
   * @param limit - row cap.
   * @returns matching rows, soonest due first.
   */
  searchText(text: string, win: { from?: string; to?: string }, limit: number): TaskRow[] {
    const pattern = containsPattern(text)
    const { where, params } = whereClause([
      windowClauses('due_at', 'date', win),
      { clauses: ['title LIKE ? ESCAPE \'\\\''], params: [pattern] },
    ])
    const raws = this.sql.all<TaskDbRow>(
      `SELECT * FROM tasks ${where} ORDER BY due_at IS NULL, due_at, id LIMIT ?`,
      ...params, limit,
    )
    return raws.map(row => TaskStore.toRow(row))
  }

  /** Due-window clauses for one {@link TaskDueFilter}, resolved against today. */
  private dueClauses(due: TaskDueFilter): { clauses: string[]; params: SupportedValue[] } {
    const today = todayIso(this.timeZone)
    if (due === 'overdue') {
      return { clauses: ['due_at IS NOT NULL', 'due_at < ?', "status IN ('TODO', 'DOING')"], params: [today] }
    }
    if (due === 'today') {
      return { clauses: ['due_at = ?', "status IN ('TODO', 'DOING')"], params: [today] }
    }
    return {
      clauses: ['due_at IS NOT NULL', 'due_at >= ?', 'due_at <= ?', "status IN ('TODO', 'DOING')"],
      params: [today, weekRangeOf(today).to],
    }
  }
}
