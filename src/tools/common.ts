/**
 * Shared tool-schema fragments and render helpers for the personal tools:
 * enum vocabularies, the date-window parameter block, row output schemas,
 * and row-to-text formatters. One home per shape keeps the 18 tool
 * definitions from drifting apart.
 * @module @deepseek-ai/dsh-personal/tools/common
 */

import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {
  BlogPostRow,
  DailyLogRow,
  IdeaRow,
  MovieRow,
  ProjectLogRow,
  ProjectRow,
  TaskRow,
  WebsiteRow,
} from '../types.ts'

/** Named query windows a model caller can select. */
export const PERIOD_VALUES = ['today', 'this-week', 'this-month', 'this-year'] as const

/** Task status vocabulary. */
export const TASK_STATUSES = ['TODO', 'DOING', 'DONE', 'CANCELLED'] as const

/** Task priority vocabulary. */
export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const

/** Relative due buckets resolved by the service against today. */
export const DUE_IN_VALUES = [
  'today', 'tomorrow', 'this-week', 'next-week', 'this-weekend', 'next-weekend', 'this-month', 'next-month',
] as const

/** Task due selections. */
export const TASK_DUE_VALUES = ['overdue', 'today', 'this-week'] as const

/** Project status vocabulary. */
export const PROJECT_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETED'] as const

/** Project-log status vocabulary. */
export const PROJECT_LOG_STATUSES = ['DONE', 'WIP', 'BLOCKED'] as const

/** Blog-post pipeline vocabulary. */
export const BLOG_POST_STATUSES = ['IDEA', 'OUTLINE', 'DRAFT', 'REVIEW', 'PUBLISHED'] as const

/** Personal object types a search can select. */
export const PERSONAL_TYPES = [
  'movie', 'project', 'project_log', 'task', 'blog_post', 'website', 'idea', 'daily_log',
] as const

/** The shared date-window parameter block; explicit dates win over `period`. */
export const windowParameters = {
  from: { type: 'string', description: 'Window start date, YYYY-MM-DD inclusive.' } as const,
  to: { type: 'string', description: 'Window end date, YYYY-MM-DD inclusive.' },
  period: {
    type: 'string',
    enum: PERIOD_VALUES,
    description: 'Named window resolved against today: today, this-week (Mon-Sun), this-month, or this-year. Ignored when from or to is given.',
  },
} satisfies ParameterSchemaSpec

/**
 * ISO date parameter description reused by capture tools.
 * @param label - human name of the date, e.g. `Watch date`.
 * @returns the parameter spec fragment.
 */
export function dateParam(label: string): { type: 'string'; description: string } {
  return { type: 'string', description: `${label} as YYYY-MM-DD; omit for today.` }
}

/** Row cap parameter. */
export const limitParameter = {
  type: 'integer',
  description: 'Maximum rows to return, 1-200; defaults to 20.',
} as const

/** Field fragments shared by the row output schemas; spread, never copied. */
const tagFields = { tags: { type: 'array', items: { type: 'string' }, required: true } } as const
const stampFields = {
  createdAt: { type: 'string', required: true },
  updatedAt: { type: 'string', required: true },
} as const

/** Movie row output schema. */
export const movieRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    watchedAt: { type: 'string', required: true },
    rating: { oneOf: [{ type: 'number' }, { type: 'null' }] as const, required: true },
    note: { type: 'string', required: true },
    ...tagFields,
    ...stampFields,
  },
} satisfies ValueSchemaSpec

/** Project row output schema. */
export const projectRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', enum: PROJECT_STATUSES, required: true },
    ...stampFields,
  },
} satisfies ValueSchemaSpec

/** Project-log row output schema. */
export const projectLogRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    projectId: { type: 'string', required: true },
    date: { type: 'string', required: true },
    title: { type: 'string', required: true },
    content: { type: 'string', required: true },
    status: { type: 'string', enum: PROJECT_LOG_STATUSES, required: true },
    ...tagFields,
    createdAt: { type: 'string', required: true },
  },
} satisfies ValueSchemaSpec

/** Task row output schema. */
export const taskRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    status: { type: 'string', enum: TASK_STATUSES, required: true },
    priority: { type: 'string', enum: TASK_PRIORITIES, required: true },
    dueAt: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
    doneAt: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
    projectId: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
    websiteId: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
    sourceType: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
    sourceId: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
    createdAt: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
  },
} satisfies ValueSchemaSpec

/** Blog-post row output schema. */
export const blogPostRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    status: { type: 'string', enum: BLOG_POST_STATUSES, required: true },
    summary: { type: 'string', required: true },
    content: { type: 'string', required: true },
    ...tagFields,
    relatedProjectId: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
    ...stampFields,
  },
} satisfies ValueSchemaSpec

/** Website row output schema. */
export const websiteRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    domain: { type: 'string', required: true },
    repo: { type: 'string', required: true },
    hosting: { type: 'string', required: true },
    description: { type: 'string', required: true },
    ...tagFields,
    ...stampFields,
  },
} satisfies ValueSchemaSpec

/** Idea row output schema. */
export const ideaRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    content: { type: 'string', required: true },
    category: { type: 'string', required: true },
    relatedProjectId: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
    createdAt: { type: 'string', required: true },
  },
} satisfies ValueSchemaSpec

/** Daily-log row output schema. */
export const dailyLogRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    date: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    rawText: { type: 'string', required: true },
    createdAt: { type: 'string', required: true },
  },
} satisfies ValueSchemaSpec

/** Relation row output schema. */
export const relationRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    fromType: { type: 'string', enum: PERSONAL_TYPES, required: true },
    fromId: { type: 'string', required: true },
    relationType: { type: 'string', required: true },
    toType: { type: 'string', enum: PERSONAL_TYPES, required: true },
    toId: { type: 'string', required: true },
    createdAt: { type: 'string', required: true },
  },
} satisfies ValueSchemaSpec

/**
 * One text content block.
 * @param text - model-facing text.
 * @returns the single-block content array.
 */
export function textBlock(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

/**
 * Render one movie row as a line.
 * @param row - the row fields the renderer prints.
 * @returns the one-line text.
 */
export function renderMovie(row: Pick<MovieRow, 'title' | 'watchedAt' | 'rating' | 'tags'>): string {
  const rating = row.rating === null ? 'unrated' : `${row.rating}/10`
  const tags = row.tags.length > 0 ? ` [${row.tags.join(', ')}]` : ''
  return `${row.watchedAt} 《${row.title}》 ${rating}${tags}`
}

/**
 * Render one project row as a line.
 * @param row - the row fields the renderer prints.
 * @returns the one-line text.
 */
export function renderProject(row: Pick<ProjectRow, 'name' | 'status'>): string {
  return `${row.name} (${row.status})`
}

/**
 * Render one project-log row as a line.
 * @param row - the row fields the renderer prints.
 * @returns the one-line text.
 */
export function renderProjectLog(row: Pick<ProjectLogRow, 'date' | 'status' | 'title'>): string {
  return `${row.date} ${row.status} ${row.title}`
}

/**
 * Render one task row as a line.
 * @param row - the row fields the renderer prints.
 * @returns the one-line text.
 */
export function renderTask(row: Pick<TaskRow, 'status' | 'priority' | 'title' | 'dueAt' | 'doneAt'>): string {
  const due = row.dueAt === null ? '' : ` due ${row.dueAt}`
  const done = row.doneAt === null ? '' : ` done ${row.doneAt}`
  return `${row.status} [${row.priority}] ${row.title}${due}${done}`
}

/**
 * Render one blog-post row as a line.
 * @param row - the row fields the renderer prints.
 * @returns the one-line text.
 */
export function renderBlogPost(row: Pick<BlogPostRow, 'status' | 'title'>): string {
  return `${row.status} ${row.title}`
}

/**
 * Render one website row as a line.
 * @param row - the row fields the renderer prints.
 * @returns the one-line text.
 */
export function renderWebsite(row: Pick<WebsiteRow, 'name' | 'domain'>): string {
  return `${row.name} (${row.domain})`
}

/**
 * Render one idea row as a line.
 * @param row - the row fields the renderer prints.
 * @returns the one-line text.
 */
export function renderIdea(row: Pick<IdeaRow, 'title' | 'category'>): string {
  const category = row.category === '' ? '' : ` [${row.category}]`
  return `${row.title}${category}`
}

/**
 * Render one daily-log row as a line.
 * @param row - the row fields the renderer prints.
 * @returns the one-line text.
 */
export function renderDailyLog(row: Pick<DailyLogRow, 'date' | 'summary'>): string {
  return `${row.date} ${row.summary}`
}

/**
 * Named window for render text.
 * @param from - window start, when bounded.
 * @param to - window end, when bounded.
 * @param period - named period, when the caller used one.
 * @returns the human-readable window label.
 */
export function describeWindow(from: string | undefined, to: string | undefined, period: string | undefined): string {
  if (from !== undefined || to !== undefined) {
    return `${from ?? '…'}..${to ?? '…'}`
  }
  return period ?? 'all time'
}
