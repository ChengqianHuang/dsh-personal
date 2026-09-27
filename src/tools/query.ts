/**
 * Model-facing query tools: typed filters over the personal stores plus one
 * cross-type text search. Filters arrive pre-validated by the schema; the
 * service resolves names and windows; facts come only from SQLite.
 * @module @deepseek-ai/dsh-personal/tools/query
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PersonalService } from '../index.ts'
import type { ProjectId, WebsiteId } from '../types.ts'
import {
  BLOG_POST_STATUSES,
  PERSONAL_TYPES,
  TASK_DUE_VALUES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  blogPostRowSchema,
  describeWindow,
  limitParameter,
  movieRowSchema,
  projectLogRowSchema,
  renderBlogPost,
  renderDailyLog,
  renderIdea,
  renderMovie,
  renderProject,
  renderProjectLog,
  renderTask,
  renderWebsite,
  taskRowSchema,
  textBlock,
  websiteRowSchema,
  windowParameters,
} from './common.ts'

/**
 * Build the six query and search tools over one service.
 * @param service - the personal service the tools delegate to.
 * @returns the tool definitions for registration.
 */
export function createQueryTools(service: PersonalService): ToolDefinition[] {
  const queryMovies = defineTool({
    name: 'query_movies',
    description: 'List movies the user watched, newest first. Filter by watch-date window or tag.',
    parameters: {
      ...windowParameters,
      tag: { type: 'string', description: 'Exact tag match, case-insensitive.' },
      limit: limitParameter,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          records: { type: 'array', items: movieRowSchema, required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (args, value) => textBlock(
        value.count === 0
          ? `No movies in ${describeWindow(args.from, args.to, args.period)}.`
          : `${value.count} movie(s) in ${describeWindow(args.from, args.to, args.period)}:\n`
            + value.records.map(renderMovie).map(line => `- ${line}`).join('\n'),
      ),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const records = await service.queryMovies(args)
      return { records, count: records.length }
    },
    presentCall: args => ({ card: 'generic', title: 'Query movies', kind: 'other', rawInput: args }),
  })

  const queryTasks = defineTool({
    name: 'query_tasks',
    description:
      'List tasks by status, priority, due selection, or links. For “what do I still owe” '
      + 'pass statuses [TODO, DOING]; for overdue work pass due overdue.',
    parameters: {
      statuses: {
        type: 'array',
        items: { type: 'string', enum: TASK_STATUSES },
        description: 'Statuses to include; omitted means every status.',
      },
      priority: { type: 'string', enum: TASK_PRIORITIES, description: 'Exact priority.' },
      due: {
        type: 'string',
        enum: TASK_DUE_VALUES,
        description: 'Due selection resolved against today: overdue, due today, or due this week.',
      },
      project: { type: 'string', description: 'Owning project name or id.' },
      website: { type: 'string', description: 'Related website name, domain, or id.' },
      limit: limitParameter,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          records: { type: 'array', items: taskRowSchema, required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => textBlock(
        value.count === 0
          ? 'No tasks match.'
          : `${value.count} task(s):\n` + value.records.map(renderTask).map(line => `- ${line}`).join('\n'),
      ),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const { project, website, ...filter } = args
      const projectId = await requireReference(project, ref => service.findProject(ref), 'project')
      const websiteId = await requireReference(website, ref => service.findWebsite(ref), 'website')
      const records = await service.queryTasks({
        ...filter,
        ...(projectId !== undefined ? { projectId: brandString<ProjectId>(projectId) } : {}),
        ...(websiteId !== undefined ? { websiteId: brandString<WebsiteId>(websiteId) } : {}),
      })
      return { records, count: records.length }
    },
    presentCall: args => ({ card: 'generic', title: 'Query tasks', kind: 'other', rawInput: args }),
  })

  const queryProjectLogs = defineTool({
    name: 'query_project_logs',
    description:
      'List project logs, newest first. Filter by project (name or id), date window, or tag. '
      + 'Omit the project to see logs across every project.',
    parameters: {
      project: { type: 'string', description: 'Project name or id; omitted means every project.' },
      ...windowParameters,
      tag: { type: 'string', description: 'Exact tag match, case-insensitive.' },
      limit: limitParameter,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          records: { type: 'array', items: projectLogRowSchema, required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (args, value) => textBlock(
        value.count === 0
          ? `No project logs in ${describeWindow(args.from, args.to, args.period)}.`
          : `${value.count} log(s) in ${describeWindow(args.from, args.to, args.period)}:\n`
            + value.records.map(renderProjectLog).map(line => `- ${line}`).join('\n'),
      ),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const records = await service.queryProjectLogs(args)
      return { records, count: records.length }
    },
    presentCall: args => ({ card: 'generic', title: 'Query project logs', kind: 'other', rawInput: args }),
  })

  const queryBlogPosts = defineTool({
    name: 'query_blog_posts',
    description:
      'List blog posts by pipeline stage or tag. For “what have I not started writing” '
      + 'pass status IDEA.',
    parameters: {
      status: { type: 'string', enum: BLOG_POST_STATUSES, description: 'Exact pipeline stage.' },
      tag: { type: 'string', description: 'Exact tag match, case-insensitive.' },
      limit: limitParameter,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          records: { type: 'array', items: blogPostRowSchema, required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => textBlock(
        value.count === 0
          ? 'No blog posts match.'
          : `${value.count} post(s):\n` + value.records.map(renderBlogPost).map(line => `- ${line}`).join('\n'),
      ),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const records = await service.queryBlogPosts(args)
      return { records, count: records.length }
    },
    presentCall: args => ({ card: 'generic', title: 'Query blog posts', kind: 'other', rawInput: args }),
  })

  const queryWebsites = defineTool({
    name: 'query_websites',
    description:
      'List registered websites with their ids, domains, and tags. Use an id from here to '
      + 'link a maintenance task to a site.',
    parameters: {
      tag: { type: 'string', description: 'Exact tag match, case-insensitive.' },
      limit: limitParameter,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          records: { type: 'array', items: websiteRowSchema, required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => textBlock(
        value.count === 0
          ? 'No websites registered.'
          : `${value.count} website(s):\n` + value.records.map(renderWebsite).map(line => `- ${line}`).join('\n'),
      ),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const records = await service.queryWebsites(args)
      return { records, count: records.length }
    },
    presentCall: args => ({ card: 'generic', title: 'Query websites', kind: 'other', rawInput: args }),
  })

  const searchPersonalData = defineTool({
    name: 'search_personal_data',
    description:
      'Substring-search across every personal object type — movies, projects, project logs, '
      + 'tasks, blog posts, websites, ideas, daily logs — inside an optional date window. '
      + 'Use it when the question spans types or no dedicated query tool fits.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to find, case-insensitive substring.' },
      types: {
        type: 'array',
        items: { type: 'string', enum: PERSONAL_TYPES },
        description: 'Object types to search; omitted means every type.',
      },
      ...windowParameters,
      limit: limitParameter,
    },
    output: {
      schema: { type: 'json', description: 'Matches grouped by object type; empty groups are omitted.' },
      render: (args, value) => textBlock(renderSearchResult(args.text, value)),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      // Every personal row field is string | number | null | string[], so the
      // grouped result is JSON-safe by construction; the tool returns it as
      // its JSON projection.
      return await service.searchPersonal(args) as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Search personal data', kind: 'other', rawInput: args.text }),
  })

  return [
    queryMovies,
    queryTasks,
    queryProjectLogs,
    queryBlogPosts,
    queryWebsites,
    searchPersonalData,
  ]
}

/** Resolve an optional reference or fail loud on an unresolvable one. */
async function requireReference<T extends { id: string }>(
  ref: string | undefined,
  resolve: (ref: string) => Promise<T | undefined>,
  label: string,
): Promise<string | undefined> {
  if (ref === undefined) return undefined
  const found = await resolve(ref)
  if (found === undefined) throw new Error(`dsh-personal: unknown ${label} ${JSON.stringify(ref)}`)
  return found.id
}

/** Human summary of one search result group. */
function renderSearchResult(text: string, value: JsonValue): string {
  if (typeof value !== 'object' || value === null) return `Nothing found for ${JSON.stringify(text)}.`
  const groups = Object.entries(value)
  if (groups.length === 0) return `Nothing found for ${JSON.stringify(text)}.`
  const lines: string[] = []
  for (const [type, rows] of groups) {
    lines.push(`${type}:`)
    for (const row of rows as Array<Record<string, unknown>>) {
      lines.push(`  - ${summarizeRow(type, row)}`)
    }
  }
  return `Found matches for ${JSON.stringify(text)}:\n` + lines.join('\n')
}

/** One-line summary of a searched row, keyed by its object type. */
function summarizeRow(type: string, row: Record<string, unknown>): string {
  switch (type) {
    case 'movie': return renderMovie(row as never)
    case 'project': return renderProject(row as never)
    case 'project_log': return renderProjectLog(row as never)
    case 'task': return renderTask(row as never)
    case 'blog_post': return renderBlogPost(row as never)
    case 'website': return renderWebsite(row as never)
    case 'idea': return renderIdea(row as never)
    case 'daily_log': return renderDailyLog(row as never)
    default: return JSON.stringify(row)
  }
}

/** Reject a call whose cancellation already arrived. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('dsh-personal: cancelled before execution')
}
