/**
 * SQLite stores for projects and their dated logs. Projects are keyed by a
 * unique name; logs join their project by id, so every query here stays on
 * one table.
 * @module @deepseek-ai/dsh-personal/store/projects
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveWindow } from '../dates.ts'
import type { ProjectId, ProjectLogFilter, ProjectLogId, ProjectLogRow, ProjectLogStatus, ProjectRow, ProjectStatus } from '../types.ts'
import {
  StatementCache,
  containsPattern,
  decodeTags,
  encodeTags,
  normalizeLimit,
  nowIso,
  tagClause,
  whereClause,
  windowClauses,
  type SupportedValue,
} from './statements.ts'

/** Raw `projects` row as SQLite returns it. */
interface ProjectDbRow {
  id: string
  name: string
  description: string
  status: string
  created_at: string
  updated_at: string
}

/** Raw `project_logs` row as SQLite returns it. */
interface ProjectLogDbRow {
  id: string
  project_id: string
  date: string
  title: string
  content: string
  status: string
  tags: string
  created_at: string
}

/** Insert payload for one project; ids and timestamps come from the service. */
export interface ProjectInsert {
  id: string
  name: string
  description: string
  status: ProjectStatus
  createdAt: string
}

/** Insert payload for one project log; ids and timestamps come from the service. */
export interface ProjectLogInsert {
  id: string
  projectId: string
  date: string
  title: string
  content: string
  status: ProjectLogStatus
  tags: string[]
  createdAt: string
}

/** Durable project store. */
export class ProjectStore {
  private readonly sql: StatementCache

  /** @param db - the opened personal database. */
  constructor(db: DatabaseSync) {
    this.sql = new StatementCache(db)
  }

  /** Map one raw row to the domain row. */
  private static toRow(raw: ProjectDbRow): ProjectRow {
    return {
      id: brandString<ProjectId>(raw.id),
      name: raw.name,
      description: raw.description,
      status: raw.status as ProjectStatus,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    }
  }

  /**
   * Insert one project row.
   * @param insert - complete insert payload.
   */
  insert(insert: ProjectInsert): void {
    this.sql.run(
      'INSERT INTO projects (id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      insert.id, insert.name, insert.description, insert.status, insert.createdAt, insert.createdAt,
    )
  }

  /**
   * Read one project by id.
   * @param id - project id.
   * @returns the row, or undefined when absent.
   */
  get(id: ProjectId): ProjectRow | undefined {
    const raw = this.sql.get<ProjectDbRow>('SELECT * FROM projects WHERE id = ?', id)
    return raw === undefined ? undefined : ProjectStore.toRow(raw)
  }

  /**
   * Read one project by its unique name.
   * @param name - exact project name.
   * @returns the row, or undefined when absent.
   */
  getByName(name: string): ProjectRow | undefined {
    const raw = this.sql.get<ProjectDbRow>('SELECT * FROM projects WHERE name = ?', name)
    return raw === undefined ? undefined : ProjectStore.toRow(raw)
  }

  /**
   * List every project, oldest first.
   * @returns all project rows.
   */
  list(): ProjectRow[] {
    return this.sql.all<ProjectDbRow>('SELECT * FROM projects ORDER BY created_at, id')
      .map(row => ProjectStore.toRow(row))
  }

  /**
   * Refresh a project's `updated_at` after one of its logs or references moved.
   * @param id - project id.
   */
  touch(id: ProjectId): void {
    this.sql.run('UPDATE projects SET updated_at = ? WHERE id = ?', nowIso(), id)
  }

  /**
   * Substring-search projects across name and description.
   * @param text - raw search text.
   * @param limit - row cap.
   * @returns matching rows.
   */
  searchText(text: string, limit: number): ProjectRow[] {
    const pattern = containsPattern(text)
    return this.sql.all<ProjectDbRow>(
      'SELECT * FROM projects WHERE name LIKE ? ESCAPE \'\\\' OR description LIKE ? ESCAPE \'\\\' '
        + 'ORDER BY created_at, id LIMIT ?',
      pattern, pattern, limit,
    ).map(row => ProjectStore.toRow(row))
  }
}

/** Durable project-log store. */
export class ProjectLogStore {
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
  private static toRow(raw: ProjectLogDbRow): ProjectLogRow {
    return {
      id: brandString<ProjectLogId>(raw.id),
      projectId: brandString<ProjectId>(raw.project_id),
      date: raw.date,
      title: raw.title,
      content: raw.content,
      status: raw.status as ProjectLogRow['status'],
      tags: decodeTags(raw.tags),
      createdAt: raw.created_at,
    }
  }

  /**
   * Insert one project-log row.
   * @param insert - complete insert payload.
   */
  insert(insert: ProjectLogInsert): void {
    this.sql.run(
      'INSERT INTO project_logs (id, project_id, date, title, content, status, tags, created_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      insert.id, insert.projectId, insert.date, insert.title, insert.content,
      insert.status, encodeTags(insert.tags), insert.createdAt,
    )
  }

  /**
   * Read one project log by id.
   * @param id - log id.
   * @returns the row, or undefined when absent.
   */
  get(id: ProjectLogId): ProjectLogRow | undefined {
    const raw = this.sql.get<ProjectLogDbRow>('SELECT * FROM project_logs WHERE id = ?', id)
    return raw === undefined ? undefined : ProjectLogStore.toRow(raw)
  }

  /**
   * List logs by project, date window, and tag, newest first.
   * @param filter - query filter with the project already resolved to an id.
   * @returns matching rows.
   */
  list(filter: Omit<ProjectLogFilter, 'project'> & { projectId?: ProjectId }): ProjectLogRow[] {
    const limit = normalizeLimit(filter.limit)
    const win = resolveWindow(filter, this.timeZone)
    const { where, params } = whereClause([
      filter.projectId !== undefined
        ? { clauses: ['project_id = ?'], params: [filter.projectId] }
        : { clauses: [], params: [] as SupportedValue[] },
      windowClauses('date', 'date', win),
      filter.tag !== undefined ? tagClause('tags', filter.tag) : { clauses: [], params: [] as SupportedValue[] },
    ])
    return this.sql.all<ProjectLogDbRow>(
      `SELECT * FROM project_logs ${where} ORDER BY date DESC, id DESC LIMIT ?`,
      ...params, limit,
    ).map(row => ProjectLogStore.toRow(row))
  }

  /**
   * Substring-search logs across title and content within a window.
   * @param text - raw search text.
   * @param win - inclusive window bounds.
   * @param limit - row cap.
   * @returns matching rows, newest first.
   */
  searchText(text: string, win: { from?: string; to?: string }, limit: number): ProjectLogRow[] {
    const pattern = containsPattern(text)
    const { where, params } = whereClause([
      windowClauses('date', 'date', win),
      { clauses: ['(title LIKE ? ESCAPE \'\\\' OR content LIKE ? ESCAPE \'\\\')'], params: [pattern, pattern] },
    ])
    return this.sql.all<ProjectLogDbRow>(
      `SELECT * FROM project_logs ${where} ORDER BY date DESC, id DESC LIMIT ?`,
      ...params, limit,
    ).map(row => ProjectLogStore.toRow(row))
  }
}
