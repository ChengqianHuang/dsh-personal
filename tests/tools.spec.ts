import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PersonalService } from '../src/index.ts'
import type { ProjectId, ProjectLogId, TaskId } from '../src/types.ts'
import { createQueryTools } from '../src/tools/query.ts'
import { createReviewTools } from '../src/tools/review.ts'
import { renderDailyReview } from '../src/tools/review.ts'
import { createWriteTools } from '../src/tools/write.ts'
import { registerPersonalTools } from '../src/tools/index.ts'
import { Context } from '@deepseek-ai/cordis'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const TOOL_NAMES = [
  'record_movie',
  'create_project',
  'record_project_log',
  'create_task',
  'update_task',
  'complete_task',
  'create_blog_post',
  'update_blog_post',
  'create_idea',
  'record_daily_log',
  'register_website',
  'query_movies',
  'query_tasks',
  'query_project_logs',
  'query_blog_posts',
  'query_websites',
  'search_personal_data',
  'generate_daily_review',
  'generate_weekly_review',
]

async function serviceWithTools(): Promise<{ service: PersonalService; tools: ToolDefinition[] }> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-personal-tools-'))
  const databasePath = join(root, 'personal.db')
  const service = new PersonalService(new Context(), { databasePath, timezone: 'UTC' })
  const tools = [...createWriteTools(service), ...createQueryTools(service), ...createReviewTools(service)]
  return { service, tools }
}

/** A minimal ToolRunContext: every personal tool touches only the signal. */
function exec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

describe('tool schemas', () => {
  it('exposes the full semantic tool list with no SQL-shaped tool', async () => {
    const { tools } = await serviceWithTools()
    expect(tools.map(tool => tool.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const name of ['execute_sql', 'insert_row', 'update_table', 'generic_database_operation']) {
      expect(tools.some(tool => tool.name === name)).toBe(false)
    }
  })

  it('accepts representative arguments for every tool', async () => {
    const { tools } = await serviceWithTools()
    const execCtx = exec()
    const samples: Record<string, Record<string, unknown>> = {
      record_movie: { title: '灵媒', rating: 7, watched_at: '2026-09-26', tags: ['horror'] },
      create_project: { name: 'Forge' },
      record_project_log: { project: 'Forge', title: '定位问题', status: 'DONE' },
      create_task: { title: '检查证书', due_in: 'next-week', website: 'blog.example.com' },
      update_task: { task_id: 'task_x', status: 'DOING', due_at: '2026-10-01' },
      complete_task: { task_id: 'task_x' },
      create_blog_post: { title: 'DSH Personal Agent', status: 'IDEA' },
      update_blog_post: { post_id: 'blog_x', status: 'DRAFT' },
      create_idea: { title: 'idea', category: 'product' },
      record_daily_log: { summary: '平静', date: '2026-09-26' },
      register_website: { name: 'Blog', domain: 'blog.example.com' },
      query_movies: { period: 'this-month', limit: 10 },
      query_tasks: { statuses: ['TODO', 'DOING'], due: 'overdue' },
      query_project_logs: { project: 'Forge', period: 'this-week' },
      query_blog_posts: { status: 'IDEA' },
      query_websites: { tag: 'blog' },
      search_personal_data: { text: '证书', types: ['task', 'blog_post'] },
      generate_daily_review: { days_ago: 1 },
      generate_weekly_review: {},
    }
    for (const tool of tools) {
      try {
        await (tool.execute(samples[tool.name] ?? {}, execCtx))
      } catch (error) {
        // Args pass schema validation; domain-level failures (unknown ids)
        // are plain service errors, never ToolArgsError.
        expect(error, tool.name).not.toBeInstanceOf(ToolArgsError)
      }
    }
  })

  it('rejects invalid arguments before the body runs', async () => {
    const { tools } = await serviceWithTools()
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['record_movie', { rating: 7 }],
      ['record_movie', { title: 'x', rating: 'seven' }],
      ['complete_task', {}],
      ['create_task', { title: 'x', due_in: 'someday' }],
      ['search_personal_data', { types: ['sql_table'] }],
    ]
    for (const [name, args] of invalid) {
      const run = byName.get(name)!.execute(args, exec())
      await expect(run, name).rejects.toBeInstanceOf(ToolArgsError)
    }
  })
})

describe('tool execution', () => {
  it('writes, queries, and reviews through the thin adapters', async () => {
    const { tools } = await serviceWithTools()
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
      await (byName.get(name)!.execute as (args: unknown, exec: ToolRunContext) => Promise<Record<string, unknown>>)(args, exec())

    const recorded = await call('record_movie', { title: '灵媒', rating: 7 })
    expect((recorded.movie as { title: string }).title).toBe('灵媒')

    const logged = await call('record_project_log', { project: 'Forge', title: '定位问题' })
    expect(logged.projectCreated).toBe(true)

    const task = await call('create_task', { title: '检查证书', due_in: 'next-week' })
    const taskId = (task.task as { id: string }).id
    const completed = await call('complete_task', { task_id: taskId })
    expect((completed.task as { status: string }).status).toBe('DONE')

    const website = await call('register_website', { name: 'Blog', domain: 'blog.example.com' })
    const websiteId = (website.website as { id: string }).id

    const movies = await call('query_movies', { period: 'this-month' })
    expect(movies.count).toBe(1)

    const search = await call('search_personal_data', { text: 'blog' })
    expect(Object.keys(search)).toContain('website')

    const review = await call('generate_daily_review', {})
    expect(review).toHaveProperty('date')

    const update = await call('update_task', { task_id: taskId, status: 'DOING' })
    expect((update.task as { status: string }).status).toBe('DOING')

    expect(websiteId).toBeTruthy()
  })

  it('rejects an already-cancelled call', async () => {
    const { tools } = await serviceWithTools()
    const recordMovie = tools.find(tool => tool.name === 'record_movie')!
    const controller = new AbortController()
    controller.abort()
    const cancelled = { signal: controller.signal } as unknown as ToolRunContext
    await expect(recordMovie.execute({ title: 'x' }, cancelled)).rejects.toThrow('cancelled')
  })

  it('surfaces unknown references as errors for the model', async () => {
    const { tools } = await serviceWithTools()
    const queryTasks = tools.find(tool => tool.name === 'query_tasks')!
    await expect(queryTasks.execute({ statuses: ['TODO'], project: 'ghost' }, exec()))
      .rejects.toThrow('unknown project')
  })
})

describe('review rendering', () => {
  it('renders sections and omits empty ones', () => {
    const today = '2026-09-26'
    const rendered = renderDailyReview({
      date: today,
      work: [{ project: { id: brandString<ProjectId>('p1'), name: 'Forge', description: '', status: 'ACTIVE', createdAt: '', updatedAt: '' }, logs: [{ id: brandString<ProjectLogId>('l1'), projectId: brandString<ProjectId>('p1'), date: today, title: '定位了问题', content: '', status: 'DONE', tags: [], createdAt: '' }] }],
      tasksDone: [{ id: brandString<TaskId>('t1'), title: 'ship', status: 'DONE', priority: 'HIGH', dueAt: null, projectId: null, websiteId: null, sourceType: null, sourceId: null, doneAt: today, createdAt: '', updatedAt: '' }],
      tasksOpen: [],
      movies: [],
      blogPosts: [],
      ideas: [],
      websites: [],
      dailyLogs: [],
    })
    expect(rendered).toContain('Daily review 2026-09-26')
    expect(rendered).toContain('Forge:')
    expect(rendered).toContain('- 2026-09-26 DONE 定位了问题')
    expect(rendered).toContain('Tasks done:')
    expect(rendered).not.toContain('Movies watched:')
    expect(rendered).not.toContain('Ideas captured:')
    const emptyWork = renderDailyReview({
      date: today,
      work: [],
      tasksDone: [],
      tasksOpen: [],
      movies: [],
      blogPosts: [],
      ideas: [],
      websites: [],
      dailyLogs: [],
    })
    expect(emptyWork).toBe('Daily review 2026-09-26')
    expect(rendered).not.toContain('Tasks open:')
  })
})

describe('tool registration gating', () => {
  it('registers all nineteen tools by default and honors the review toggles', async () => {
    root ??= await mkdtemp(join(tmpdir(), 'dsh-personal-gating-'))
    const databasePath = join(root, 'a.db')
    const service = new PersonalService(new Context(), { databasePath, timezone: 'UTC' })
    const registered: string[] = []
    const ctxStub = { tools: { register: (tool: ToolDefinition) => { registered.push(tool.name) } } } as unknown as Context
    registerPersonalTools(ctxStub, service, {
      databasePath, enableDailyReview: true, enableWeeklyReview: true, timeZone: 'UTC',
    })
    expect(registered).toEqual(TOOL_NAMES)
    expect(registered).toHaveLength(19)

    const gated: string[] = []
    registerPersonalTools({ tools: { register: (tool: ToolDefinition) => { gated.push(tool.name) } } } as unknown as Context, service, {
      databasePath, enableDailyReview: false, enableWeeklyReview: true, timeZone: 'UTC',
    })
    expect(gated).not.toContain('generate_daily_review')
    expect(gated).toContain('generate_weekly_review')

    const weeklyOff: string[] = []
    registerPersonalTools({ tools: { register: (tool: ToolDefinition) => { weeklyOff.push(tool.name) } } } as unknown as Context, service, {
      databasePath, enableDailyReview: true, enableWeeklyReview: false, timeZone: 'UTC',
    })
    expect(weeklyOff).toContain('generate_daily_review')
    expect(weeklyOff).not.toContain('generate_weekly_review')

    const none: string[] = []
    registerPersonalTools({ tools: { register: (tool: ToolDefinition) => { none.push(tool.name) } } } as unknown as Context, service, {
      databasePath, enableDailyReview: false, enableWeeklyReview: false, timeZone: 'UTC',
    })
    expect(none).not.toContain('generate_daily_review')
    expect(none).not.toContain('generate_weekly_review')
    service.close()
  })
})
