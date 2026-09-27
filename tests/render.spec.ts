// Coverage for the model-facing projections: every tool's execute, output
// render, and presentCall run against a real service over a temp database,
// so the model-visible text is exercised exactly as the pipeline produces it.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import type { BlogPostId, DailyLogId, ExperienceId, IdeaId, ProjectId, ProjectLogId, TaskId, TaskPriority, TaskStatus, WebsiteId } from '../src/types.ts'
import { PersonalService } from '../src/index.ts'
import { createQueryTools } from '../src/tools/query.ts'
import { createReviewTools } from '../src/tools/review.ts'
import { createWriteTools } from '../src/tools/write.ts'
import { renderDailyReview, renderWeeklyReview } from '../src/tools/review.ts'
import { renderExperience } from '../src/tools/common.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function exec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

/** Run one tool body and type the canonical value as its JSON projection. */
async function executeJson(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<Record<string, JsonValue>> {
  return await (tool.execute as (a: unknown, e: ToolRunContext) => Promise<Record<string, JsonValue>>)(args, exec())
}

/** The samples record representative rows; the queries then read them back. */
const WRITE_SAMPLES: Record<string, Record<string, unknown>> = {
  record_experience: { category: 'movie', action: 'watched', title: '灵媒', rating: 7, tags: ['horror'] },
  record_experience_full: { category: 'movie', action: 'watched', title: 'Quiet', occurred_on: '2026-09-25' },
  create_project: { name: 'Forge', description: 'LLM app' },
  record_project_log: { project: 'Forge', title: '定位了中文错位问题', status: 'DONE', tags: ['debug'] },
  create_task: { title: '检查 HTTPS 证书', due_in: 'next-week', priority: 'HIGH' },
  // Second pass: the other conditional-spread paths (exact date + source links).
  create_task_full: { title: '续费域名', due_at: '2026-12-01', project: 'Forge', website: 'blog.example.com', source_type: 'blog_post', source_id: 'blog_1' },
  update_task: { task_id: 'REPLACED', status: 'DOING' },
  complete_task: { task_id: 'REPLACED' },
  create_blog_post: { title: 'DSH Personal Agent', status: 'IDEA', tags: ['dsh'], related_project: 'Forge' },
  update_blog_post: { post_id: 'REPLACED', status: 'DRAFT', title: 'v2', summary: 'premise', content: 'body' },
  create_idea: { title: '写博客的想法', category: 'writing' },
  record_daily_log: { summary: '平静的一天', raw_text: 'raw words' },
  register_website: { name: 'Blog', domain: 'blog.example.com', tags: ['blog'] },
}

describe('tool projections', () => {
  it('executes, renders, and presents every write tool', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-personal-render-'))
    const service = new PersonalService(new Context(), { databasePath: join(root, 'personal.db'), timezone: 'UTC' })
    const tools = new Map(createWriteTools(service).map(tool => [tool.name, tool]))

    const ids: Record<string, string> = {}
    for (const [name, tool] of tools) {
      if (name === 'update_task' || name === 'complete_task' || name === 'update_blog_post') {
        continue
      }
      const args = { ...(WRITE_SAMPLES[name] ?? {}) }
      const value = await executeJson(tool, args)
      if (name === 'create_task') ids.task = (value.task as { id: string }).id
      if (name === 'create_blog_post') ids.blog = (value.post as { id: string }).id

      const text = tool.output.render(args, value).filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text.length, name).toBeGreaterThan(0)
      expect(tool.presentCall?.(args), name).toBeDefined()
      expect(tool.isConcurrencySafe?.(args), name).toBe(true)
    }

    // A second pass exercises the complementary optional-argument paths:
    // exact dates, omitted optionals, and a project created on first mention.
    const secondPass: Record<string, Record<string, unknown>> = {
      record_experience: { title: 'Quiet', category: 'movie', action: 'watched', occurred_on: '2026-09-25' },
      record_project_log: { project: 'Fresh Project', title: '开张' },
      create_task: WRITE_SAMPLES.create_task_full ?? {},
      create_blog_post: { title: 'No Project Post' },
      create_idea: { title: 'Linked idea', related_project: 'Forge' },
      record_daily_log: { summary: '无原始文本的一天' },
    }
    for (const [name, args] of Object.entries(secondPass)) {
      const tool = tools.get(name)!
      const value = await executeJson(tool, args)
      const text = tool.output.render(args, value).filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text.length, name).toBeGreaterThan(0)
    }

    // Half-point ratings display as stored.
    expect(renderExperience({
      category: 'movie', action: 'watched', title: '沙丘 2', occurredOn: '2026-09-25',
      rating: 7.5, note: '视觉出色', tags: [],
    })).toBe('2026-09-25 [movie] watched 沙丘 2 7.5/10 — 视觉出色')

    // The update tools run once their target ids exist.
    const updates: Record<string, Record<string, unknown>> = {
      update_task: { task_id: ids.task, status: 'DOING' },
      complete_task: { task_id: ids.task },
      update_blog_post: { post_id: ids.blog, status: 'DRAFT', summary: 'premise', content: 'body' },
    }
    // The relative-due path of update_task (no explicit date) reuses the tool.
    updates.update_task_relative = { tool: 'update_task', args: { task_id: ids.task, due_in: 'tomorrow' } }
    const updateEntries: Array<{ name: string; toolName: string; args?: Record<string, unknown> }> = [
      { name: 'update_task', toolName: 'update_task', args: { task_id: ids.task, status: 'DOING' } },
      { name: 'complete_task', toolName: 'complete_task', args: { task_id: ids.task } },
      { name: 'update_blog_post', toolName: 'update_blog_post', args: { post_id: ids.blog, status: 'DRAFT', summary: 'premise', content: 'body' } },
      // The relative-due path of update_task (no explicit date).
      { name: 'update_task_relative', toolName: 'update_task', args: { task_id: ids.task, due_in: 'tomorrow' } },
    ]
    for (const entry of updateEntries) {
      const tool = tools.get(entry.toolName)!
      const args = entry.args ?? {}
      const value = await executeJson(tool, args)
      const text = tool.output.render(args, value).filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text.length, entry.name).toBeGreaterThan(0)
      expect(tool.presentCall?.(args), entry.name).toBeDefined()
      expect(tool.isConcurrencySafe?.(args), entry.name).toBe(true)
    }
    service.close()
  })

  it('executes and renders every query and review tool with data behind it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-personal-render-query-'))
    const service = new PersonalService(new Context(), { databasePath: join(root, 'personal.db'), timezone: 'UTC' })
    // Seed one row of each queried type; the website exists before the task
    // that links to it.
    await service.recordExperience({ category: 'movie', action: 'watched', title: '灵媒', rating: 7 })
    await service.recordProjectLog({ project: 'Forge', title: '定位了问题' })
    await service.registerWebsite({ name: 'Blog', domain: 'blog.example.com' })
    await service.createTask({ title: '证书', dueIn: 'today', project: 'Forge', website: 'blog.example.com' })
    await service.createBlogPost({ title: 'DSH Personal Agent' })
    await service.createIdea({ title: 'idea' })
    await service.recordDailyLog({ summary: '小结' })

    const tools = [...createQueryTools(service), ...createReviewTools(service)]
    const samples: Record<string, Record<string, unknown>> = {
      query_experiences: { period: 'this-month' },
      query_tasks: { statuses: ['TODO'] },
      query_project_logs: { project: 'Forge' },
      query_blog_posts: { status: 'IDEA' },
      query_websites: { tag: 'blog' },
      search_personal_data: { text: 'blog' },
      generate_daily_review: {},
      generate_weekly_review: {},
    }
    for (const tool of tools) {
      const args = samples[tool.name] ?? {}
      const value = await (tool.execute as (a: unknown, e: ToolRunContext) => Promise<JsonValue>)(args, exec())
      const text = tool.output.render(args, value).filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text.length, tool.name).toBeGreaterThan(0)
      expect(tool.presentCall?.(args), tool.name).toBeDefined()
      expect(tool.isConcurrencySafe?.(args), tool.name).toBe(true)
    }

    // Explicit window bounds render their own label.
    const windowed = { from: '2026-01-01', to: '2026-01-31' }
    const windowText = tools.find(t => t.name === 'query_experiences')!.output.render(windowed, { records: [], count: 0 }).filter(block => block.type === 'text').map(block => block.text).join('')
    expect(windowText).toContain('2026-01-01..2026-01-31')
    const oneSided = { from: '2026-01-01' }
    const oneSidedText = tools.find(t => t.name === 'query_experiences')!.output.render(oneSided, { records: [], count: 0 }).filter(block => block.type === 'text').map(block => block.text).join('')
    expect(oneSidedText).toContain('2026-01-01..…')

    // The row-list tools render their empty shape too.
    for (const name of ['query_tasks', 'query_project_logs', 'query_blog_posts', 'query_websites']) {
      const tool = tools.find(t => t.name === name)!
      const empty = { records: [], count: 0 }
      const text = tool.output.render({}, empty).filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text.length, name).toBeGreaterThan(0)
    }
    // query_websites renders its populated shape directly as well.
    const websites = tools.find(t => t.name === 'query_websites')!
    const populated = {
      records: [{ id: 'w', name: 'Blog', domain: 'blog.example.com', repo: '', hosting: '', description: '', tags: [], createdAt: '', updatedAt: '' }],
      count: 1,
    } as JsonValue
    const websiteText = websites.output.render({}, populated).filter(block => block.type === 'text').map(block => block.text).join('')
    expect(websiteText).toContain('- Blog (blog.example.com)')
    // A to-only window label renders the open start.
    const toOnly = tools.find(t => t.name === 'query_experiences')!
    const toOnlyText = toOnly.output.render({ to: '2026-01-31' }, { records: [], count: 0 }).filter(block => block.type === 'text').map(block => block.text).join('')
    expect(toOnlyText).toContain('…..2026-01-31')
    // query_tasks also resolves a real project and website reference.
    const queryTasks = tools.find(tool => tool.name === 'query_tasks')!
    const resolved = await (queryTasks.execute as (a: unknown, e: ToolRunContext) => Promise<{ count: number }>)(
      { statuses: ['TODO'], project: 'Forge', website: 'blog.example.com' }, exec(),
    )
    expect(resolved.count).toBeGreaterThan(0)
    service.close()
  })

  it('rejects every already-cancelled call before the body runs', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-personal-render-abort-'))
    const service = new PersonalService(new Context(), { databasePath: join(root, 'personal.db'), timezone: 'UTC' })
    const tools = [...createWriteTools(service), ...createQueryTools(service), ...createReviewTools(service)]
    const cancelled = { signal: AbortSignal.abort() } as unknown as ToolRunContext
    const argsFor: Record<string, Record<string, unknown>> = {
      ...Object.fromEntries(Object.entries(WRITE_SAMPLES).map(([name, args]) => [name, { ...args }])),
      search_personal_data: { text: 'x' },
    }
    for (const tool of tools) {
      await expect(
        Promise.resolve(tool.execute(argsFor[tool.name] ?? {}, cancelled)),
        tool.name,
      ).rejects.toThrow('cancelled')
    }
    service.close()
  })

  it('renders every search-result type line and the unknown-type fallback', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-personal-render-search-'))
    const service = new PersonalService(new Context(), { databasePath: join(root, 'personal.db'), timezone: 'UTC' })
    const search = createQueryTools(service).find(tool => tool.name === 'search_personal_data')!
    const row = {
      experience: { id: 'm', category: 'movie', action: 'watched', title: '灵媒', occurredOn: '2026-09-26', rating: 7, note: '恐怖片', tags: [], createdAt: '' },
      project: { id: 'p', name: 'Forge', description: '', status: 'ACTIVE', createdAt: '', updatedAt: '' },
      project_log: { id: 'l', projectId: 'p', date: '2026-09-26', title: '定位', content: '', status: 'DONE', tags: [], createdAt: '' },
      task: { id: 't', title: '证书', status: 'TODO', priority: 'HIGH', dueAt: null, doneAt: null, projectId: null, websiteId: null, sourceType: null, sourceId: null, createdAt: '', updatedAt: '' },
      blog_post: { id: 'b', title: 'DSH', status: 'IDEA', summary: '', content: '', tags: [], relatedProjectId: null, createdAt: '', updatedAt: '' },
      website: { id: 'w', name: 'Blog', domain: 'blog.example.com', repo: '', hosting: '', description: '', tags: [], createdAt: '', updatedAt: '' },
      idea: { id: 'i', title: 'idea', content: '', category: '', relatedProjectId: null, createdAt: '' },
      daily_log: { id: 'd', date: '2026-09-26', summary: '小结', rawText: '', createdAt: '' },
      future_type: { id: 'x' },
    }
    const grouped: Record<string, JsonValue[]> = {}
    for (const [type, value] of Object.entries(row)) grouped[type] = [value]
    const text = search.output.render({ text: 'x' }, grouped).filter(block => block.type === 'text').map(block => block.text).join('')
    for (const marker of ['experience:', 'project:', 'project_log:', 'task:', 'blog_post:', 'website:', 'idea:', 'daily_log:', 'future_type:']) {
      expect(text, marker).toContain(marker)
    }
    expect(text).toContain('2026-09-26 [movie] watched 灵媒 7/10 — 恐怖片')
    service.close()
  })

  it('renders review bundles with every section and the empty variants', async () => {
    const today = '2026-09-26'
    const task = { id: brandString<TaskId>('t1'), title: 'ship', status: 'DONE' as TaskStatus, priority: 'HIGH' as TaskPriority, dueAt: null, projectId: null, websiteId: null, sourceType: null, sourceId: null, doneAt: today, createdAt: '', updatedAt: '' }
    const website = { website: { id: brandString<WebsiteId>('w'), name: 'Blog', domain: 'blog.example.com', repo: '', hosting: '', description: '', tags: [], createdAt: '', updatedAt: '' }, openTasks: [{ ...task, id: brandString<TaskId>('t2'), title: '续费', status: 'TODO' as TaskStatus }] }
    const dailyFull = renderDailyReview({
      date: today,
      work: [{ project: { id: brandString<ProjectId>('p'), name: 'Forge', description: '', status: 'ACTIVE', createdAt: '', updatedAt: '' }, logs: [{ id: brandString<ProjectLogId>('l'), projectId: brandString<ProjectId>('p'), date: today, title: '定位了问题', content: '', status: 'DONE', tags: [], createdAt: '' }] }],
      tasksDone: [task],
      tasksOpen: [{ ...task, id: brandString<TaskId>('t3'), title: 'open', status: 'TODO' }],
      experiences: [{ id: brandString<ExperienceId>('m'), category: 'movie', action: 'watched', title: '灵媒', occurredOn: today, rating: null, note: '', tags: ['horror'], createdAt: '' }],
      blogPosts: [{ id: brandString<BlogPostId>('b'), title: 'DSH', status: 'IDEA', summary: '', content: '', tags: [], relatedProjectId: null, createdAt: '', updatedAt: '' }],
      ideas: [{ id: brandString<IdeaId>('i'), title: 'idea', content: '', category: 'writing', relatedProjectId: null, createdAt: '' }],
      websites: [website],
      dailyLogs: [{ id: brandString<DailyLogId>('d'), date: today, summary: '小结', rawText: '', createdAt: '' }],
    })
    for (const marker of ['Work:', 'Tasks open:', 'Experiences:', 'Blog posts created:', 'Ideas captured:', 'Websites with open tasks:', 'Daily logs:']) {
      expect(dailyFull, marker).toContain(marker)
    }
    const weeklyFull = renderWeeklyReview({
      from: '2026-09-21',
      to: '2026-09-27',
      activeProjects: [{ id: brandString<ProjectId>('p'), name: 'Forge', description: '', status: 'ACTIVE', createdAt: '', updatedAt: '' }],
      tasksDone: [task],
      tasksOpen: [],
      experiences: [{ id: brandString<ExperienceId>('m'), category: 'movie', action: 'watched', title: '灵媒', occurredOn: today, rating: null, note: '', tags: [], createdAt: '' }],
      blogPosts: [{ id: brandString<BlogPostId>('b'), title: 'DSH', status: 'IDEA', summary: '', content: '', tags: [], relatedProjectId: null, createdAt: '', updatedAt: '' }],
      ideas: [{ id: brandString<IdeaId>('i'), title: 'idea', content: '', category: 'writing', relatedProjectId: null, createdAt: '' }],
      websites: [website],
    })
    expect(weeklyFull).toContain('Weekly review 2026-09-21 .. 2026-09-27')
    expect(weeklyFull).toContain('Active projects:')
    const weeklyEmpty = renderWeeklyReview({
      from: '2026-09-21', to: '2026-09-27',
      activeProjects: [], tasksDone: [], tasksOpen: [], experiences: [], blogPosts: [], ideas: [], websites: [],
    })
    expect(weeklyEmpty).not.toContain('Experiences:')
  })

  it('renders empty query results and empty search results', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-personal-render-empty-'))
    const service = new PersonalService(new Context(), { databasePath: join(root, 'personal.db'), timezone: 'UTC' })
    const tools = new Map(createQueryTools(service).map(tool => [tool.name, tool]))

    const empty = await (tools.get('query_experiences')!.execute as (a: unknown, e: ToolRunContext) => Promise<JsonValue>)( {}, exec())
    const text = tools.get('query_experiences')!.output.render({}, empty).filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toContain('No experiences')

    const nothing = await (tools.get('search_personal_data')!.execute as (a: unknown, e: ToolRunContext) => Promise<JsonValue>)({ text: 'absent-token' }, exec())
    const searchText = tools.get('search_personal_data')!.output.render({ text: 'absent-token' }, nothing).filter(block => block.type === 'text').map(block => block.text).join('')
    expect(searchText).toContain('Nothing found')
    // A non-object search result renders as not-found too.
    const nullText = tools.get('search_personal_data')!.output.render({ text: 'x' }, null).filter(block => block.type === 'text').map(block => block.text).join('')
    expect(nullText).toContain('Nothing found')
    service.close()
  })
})
