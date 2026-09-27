import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { resolvePersonalConfig } from '../src/config.ts'
import { addDays, todayIso } from '../src/dates.ts'
import { PersonalService } from '../src/index.ts'

let root: string | undefined
const closeHooks: Array<() => void> = []

afterEach(async () => {
  for (const close of closeHooks.splice(0)) close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A UTC service over a fresh temp database keeps every date assertion deterministic. */
async function service(): Promise<PersonalService> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-personal-service-'))
  const databasePath = join(root, `db-${closeHooks.length}.db`)
  const instance = new PersonalService(new Context(), { databasePath, timezone: 'UTC' })
  closeHooks.push(() => { instance.close() })
  return instance
}

describe('capture and mutation', () => {
  it('records a movie, defaulting the watch date to today', async () => {
    const svc = await service()
    const movie = await svc.recordMovie({ title: ' 灵媒 ', rating: 7, tags: ['horror'] })
    expect(movie).toMatchObject({
      title: '灵媒', watchedAt: todayIso('UTC'), rating: 7, tags: ['horror'], note: '',
    })
    const undated = await svc.recordMovie({ title: 'Quiet' })
    expect(undated.rating).toBeNull()
    const half = await svc.recordMovie({ title: '沙丘 2', rating: 7.5 })
    expect(half.rating).toBe(7.5)
    const quarter = await svc.queryMovies({})
    expect(quarter.find(row => row.title === '沙丘 2')?.rating).toBe(7.5)
    expect((await svc.recordMovie({ title: 'x', rating: 8.25 })).rating).toBe(8.25)
    await expect(svc.recordMovie({ title: '   ' })).rejects.toThrow('movie title')
    await expect(svc.recordMovie({ title: 'x', rating: 11 })).rejects.toThrow('rating')
    await expect(svc.recordMovie({ title: 'x', rating: Number.NaN })).rejects.toThrow('rating')
    await expect(svc.recordMovie({ title: 'x', watchedAt: '2026-02-30' })).rejects.toThrow('watchedAt')
  })

  it('creates projects, rejecting duplicate names', async () => {
    const svc = await service()
    const project = await svc.createProject({ name: 'Forge', description: 'LLM app' })
    expect(project.status).toBe('ACTIVE')
    await expect(svc.createProject({ name: 'Forge' })).rejects.toThrow('already exists')
  })

  it('resolves projects by id, exact name, and case-insensitive name', async () => {
    const svc = await service()
    const created = await svc.createProject({ name: 'Forge' })
    expect((await svc.findProject(created.id))?.name).toBe('Forge')
    expect((await svc.findProject('Forge'))?.id).toBe(created.id)
    expect((await svc.findProject('forge'))?.id).toBe(created.id)
    expect(await svc.findProject('missing')).toBeUndefined()
    expect(await svc.findProject('   ')).toBeUndefined()
  })

  it('records project logs, creating the project on first mention and linking it', async () => {
    const svc = await service()
    const first = await svc.recordProjectLog({ project: 'Forge', title: '定位了中文错位问题' })
    expect(first.project.name).toBe('Forge')
    expect(first.log.date).toBe(todayIso('UTC'))
    const second = await svc.recordProjectLog({
      project: 'Forge', title: '修完了', date: '2026-09-25', status: 'WIP', tags: ['fix'],
    })
    expect(second.project.id).toBe(first.project.id)
    expect(second.log).toMatchObject({ date: '2026-09-25', status: 'WIP', tags: ['fix'] })
    const logs = await svc.queryProjectLogs({ project: 'forge' })
    expect(logs.map(row => row.title)).toEqual(['定位了中文错位问题', '修完了'])
  })

  it('creates tasks with due dates, links, and relations', async () => {
    const svc = await service()
    const website = await svc.registerWebsite({ name: 'Blog', domain: 'blog.example.com' })
    const project = await svc.createProject({ name: 'Blog ops' })
    const task = await svc.createTask({
      title: '检查 HTTPS 证书', dueIn: 'next-week', priority: 'HIGH',
      project: 'blog ops', website: 'BLOG.EXAMPLE.COM',
    })
    expect(task.status).toBe('TODO')
    expect(task.dueAt).toBe(addDays(todayIso('UTC'), 7 - ((new Date(`${todayIso('UTC')}T00:00:00Z`).getUTCDay() + 6) % 7)))
    expect(task.projectId).toBe(project.id)
    expect(task.websiteId).toBe(website.id)
    await expect(svc.createTask({ title: 'x', project: 'ghost' })).rejects.toThrow('unknown project')
    await expect(svc.createTask({ title: 'x', website: 'ghost.example.com' })).rejects.toThrow('unknown website')
    await expect(svc.createTask({ title: '   ' })).rejects.toThrow('task title')
  })

  it('prefers explicit dueAt over dueIn', async () => {
    const svc = await service()
    const task = await svc.createTask({ title: 'x', dueAt: '2026-12-01', dueIn: 'tomorrow' })
    expect(task.dueAt).toBe('2026-12-01')
  })

  it('updates and completes tasks with done_at bookkeeping', async () => {
    const svc = await service()
    const created = await svc.createTask({ title: 'ship' })
    const today = todayIso('UTC')
    const done = await svc.completeTask(created.id)
    expect(done.status).toBe('DONE')
    expect(done.doneAt).toBe(today)
    const reopened = await svc.updateTask(created.id, { status: 'DOING' })
    expect(reopened.doneAt).toBeNull()
    const moved = await svc.updateTask(created.id, { dueIn: 'tomorrow' })
    expect(moved.dueAt).toBe(addDays(today, 1))
    const renamed = await svc.updateTask(created.id, { title: 'ship v2' })
    expect(renamed.title).toBe('ship v2')
    const reprioritized = await svc.updateTask(created.id, { priority: 'LOW' })
    expect(reprioritized.priority).toBe('LOW')
    const rescheduled = await svc.updateTask(created.id, { dueAt: '2026-12-01' })
    expect(rescheduled.dueAt).toBe('2026-12-01')
    await expect(svc.updateTask('task_missing' as never, { status: 'DONE' })).rejects.toThrow('unknown task')
  })

  it('moves blog posts through the pipeline', async () => {
    const svc = await service()
    const project = await svc.createProject({ name: 'Writing' })
    const post = await svc.createBlogPost({ title: 'DSH Personal Agent', relatedProject: 'writing', tags: ['dsh'] })
    expect(post).toMatchObject({ status: 'IDEA', relatedProjectId: project.id, tags: ['dsh'] })
    const updated = await svc.updateBlogPost(post.id, { status: 'DRAFT', content: 'draft body' })
    expect(updated).toMatchObject({ status: 'DRAFT', content: 'draft body' })
    const renamed = await svc.updateBlogPost(post.id, { title: 'DSH Personal Agent v2' })
    expect(renamed.title).toBe('DSH Personal Agent v2')
    const summarized = await svc.updateBlogPost(post.id, { summary: 'premise' })
    expect(summarized.summary).toBe('premise')
    const retagged = await svc.updateBlogPost(post.id, { tags: ['dsh'] })
    expect(retagged.tags).toEqual(['dsh'])
    await expect(svc.updateBlogPost('blog_missing' as never, { status: 'PUBLISHED' })).rejects.toThrow('unknown blog post')
    await expect(svc.createBlogPost({ title: ' ' })).rejects.toThrow('blog title')
  })

  it('captures ideas with an optional category and project link', async () => {
    const svc = await service()
    await svc.createProject({ name: 'Forge' })
    const idea = await svc.createIdea({ title: 'MVP', category: 'product', relatedProject: 'Forge' })
    expect(idea.category).toBe('product')
    expect(await svc.findProject('Forge')).toBeDefined()
    await expect(svc.createIdea({ title: '' })).rejects.toThrow('idea title')
  })

  it('records daily logs and registers websites fail-loud', async () => {
    const svc = await service()
    const log = await svc.recordDailyLog({ summary: '平静的一天', rawText: 'raw', date: '2026-09-25' })
    expect(log).toMatchObject({ date: '2026-09-25', summary: '平静的一天' })
    const today = await svc.recordDailyLog({ summary: 'today log' })
    expect(today.date).toBe(todayIso('UTC'))
    const website = await svc.registerWebsite({ name: 'Blog', domain: 'blog.example.com', tags: ['blog'] })
    expect(website.domain).toBe('blog.example.com')
    await expect(svc.registerWebsite({ name: 'Other', domain: 'blog.example.com' })).rejects.toThrow('already exists')
    await expect(svc.registerWebsite({ name: 'No', domain: '' })).rejects.toThrow('website domain')
    expect((await svc.findWebsite('BLOG.example.com'))?.id).toBe(website.id)
    expect((await svc.findWebsite('blog'))?.id).toBe(website.id)
    expect(await svc.findWebsite('nope')).toBeUndefined()
    expect(await svc.findWebsite('   ')).toBeUndefined()
    expect((await svc.findWebsite(website.id))?.id).toBe(website.id)
    const other = await svc.registerWebsite({ name: 'Docs', domain: 'docs.example.com' })
    expect((await svc.findWebsite('DOCS.EXAMPLE.COM'))?.id).toBe(other.id)
    expect(await svc.queryProjectLogs({})).toEqual([])
  })
})

describe('queries and search', () => {
  it('links objects explicitly and queries ideas and daily logs', async () => {
    const svc = await service()
    const website = await svc.registerWebsite({ name: 'Blog', domain: 'blog.example.com' })
    const relation = await svc.linkObjects({ type: 'website', id: website.id }, 'relates-to', { type: 'website', id: website.id })
    expect(relation.relationType).toBe('relates-to')
    await expect(svc.linkObjects({ type: 'website', id: website.id }, '   ', { type: 'website', id: website.id })).rejects.toThrow('relation type')
    const idea = await svc.createIdea({ title: 'idea' })
    expect(await svc.queryIdeas({})).toEqual([idea])
    expect(await svc.queryIdeas({ category: 'nope' })).toEqual([])
    const log = await svc.recordDailyLog({ summary: 'today' })
    expect(await svc.queryDailyLogs({})).toEqual([log])
    expect(await svc.queryDailyLogs({ period: 'this-month' })).toEqual([log])
    // A resolved project id skips the name lookup entirely.
    const project = await svc.createProject({ name: 'P' })
    expect(await svc.queryProjectLogs({ projectId: project.id })).toEqual([])
  })

  it('queries tasks by status and due window', async () => {
    const svc = await service()
    await svc.createTask({ title: 'open', priority: 'LOW' })
    const done = await svc.createTask({ title: 'closed', dueAt: '2026-01-01' })
    await svc.completeTask(done.id)
    const open = await svc.queryTasks({ statuses: ['TODO', 'DOING'] })
    expect(open.map(row => row.title)).toEqual(['open'])
    expect(await svc.queryTasks({ due: 'overdue' })).toEqual([])
  })

  it('searches across types and honors the type filter', async () => {
    const svc = await service()
    await svc.recordMovie({ title: '灵媒', note: '泰剧恐怖片' })
    await svc.recordProjectLog({ project: 'Forge', title: 'Minimax streaming 中文错位' })
    await svc.createIdea({ title: '写一篇 DSH Personal Agent 博客' })
    const hits = await svc.searchPersonal({ text: 'dsh' })
    expect(Object.keys(hits)).toEqual(['idea'])
    const everything = await svc.searchPersonal({ text: '中文' })
    expect(Object.keys(everything)).toEqual(['project_log'])
    const limited = await svc.searchPersonal({ text: '灵媒', types: ['movie', 'task'] })
    expect(Object.keys(limited)).toEqual(['movie'])
    expect(await svc.searchPersonal({ text: 'absent-token' })).toEqual({})
    await expect(svc.searchPersonal({ text: '  ' })).rejects.toThrow('search text')
    await expect(svc.searchPersonal({ text: 'x', limit: 0 })).rejects.toThrow('limit')
    await expect(svc.searchPersonal({ text: 'x', limit: 201 })).rejects.toThrow('limit')
    expect(await svc.searchPersonal({ text: '灵媒', limit: 5 })).toHaveProperty('movie')
  })
})

describe('reviews', () => {
  it('assembles the daily fact bundle from SQLite', async () => {
    const svc = await service()
    const today = todayIso('UTC')
    await svc.recordProjectLog({ project: 'Forge', title: '定位了中文错位问题' })
    await svc.recordProjectLog({ project: 'Forge', title: '修完了适配层' })
    const task = await svc.createTask({ title: 'ship blog' })
    await svc.completeTask(task.id)
    await svc.createTask({ title: 'outstanding' })
    await svc.recordMovie({ title: '灵媒', rating: 7 })
    await svc.createBlogPost({ title: 'DSH Personal Agent' })
    await svc.createIdea({ title: 'idea one' })
    await svc.registerWebsite({ name: 'Blog', domain: 'blog.example.com' })
    await svc.createTask({ title: '续费证书', website: 'blog.example.com' })
    await svc.recordDailyLog({ summary: '今日小结' })

    const review = await svc.generateDailyReview()
    expect(review.date).toBe(today)
    expect(review.work).toHaveLength(1)
    expect(review.work).toHaveLength(1)
    expect([...review.work[0]!.logs.map(log => log.title)].sort()).toEqual(['修完了适配层', '定位了中文错位问题'])
    expect(review.tasksDone.map(row => row.title)).toEqual(['ship blog'])
    expect(review.tasksOpen.map(row => row.title).sort()).toEqual(['outstanding', '续费证书'].sort())
    expect(review.movies.map(row => row.title)).toEqual(['灵媒'])
    expect(review.blogPosts.map(row => row.title)).toEqual(['DSH Personal Agent'])
    expect(review.ideas.map(row => row.title)).toEqual(['idea one'])
    expect(review.websites[0]!.openTasks.map(row => row.title)).toEqual(['续费证书'])
    expect(review.dailyLogs.map(row => row.summary)).toEqual(['今日小结'])
  })

  it('assembles the weekly bundle around the anchor week', async () => {
    const svc = await service()
    const today = todayIso('UTC')
    await svc.recordProjectLog({ project: 'Forge', title: 'week work' })
    const review = await svc.generateWeeklyReview()
    expect(review.from <= today).toBe(true)
    expect(review.to >= today).toBe(true)
    expect(review.activeProjects.map(project => project.name)).toEqual(['Forge'])
    expect(review.movies).toEqual([])
  })

  it('accepts an explicit weekly anchor date', async () => {
    const svc = await service()
    const review = await svc.generateWeeklyReview('2026-09-23')
    expect(review.from).toBe('2026-09-21')
    expect(review.to).toBe('2026-09-27')
    await expect(svc.generateWeeklyReview('2026-02-30')).rejects.toThrow('date')
  })

  it('resolves review dates and closes deterministically', async () => {
    const svc = await service()
    expect(svc.resolveReviewDate('2026-09-25', undefined)).toBe('2026-09-25')
    expect(svc.resolveReviewDate(undefined, 1)).toBe(addDays(todayIso('UTC'), -1))
    expect(svc.resolveReviewDate(undefined, undefined)).toBe(todayIso('UTC'))
    expect(() => svc.resolveReviewDate(undefined, -1)).toThrow('daysAgo')
    await expect(svc.generateDailyReview('2026-02-30')).rejects.toThrow('date')
    svc.close()
    await expect(svc.queryMovies({})).rejects.toThrow('disposed')
  })
})

describe('config resolution', () => {
  it('fills defaults and validates fail-loud', () => {
    const settings = resolvePersonalConfig({})
    expect(settings.databasePath).toContain('personal')
    expect(settings.databasePath.endsWith('personal.db')).toBe(true)
    expect(settings.enableDailyReview).toBe(true)
    expect(settings.enableWeeklyReview).toBe(true)
    expect(settings.timeZone).toBeUndefined()
    expect(resolvePersonalConfig({ timezone: 'Asia/Shanghai' }).timeZone).toBe('Asia/Shanghai')
    expect(() => resolvePersonalConfig({ timezone: 'Mars/Olympus' })).toThrow('timezone')
    expect(() => resolvePersonalConfig({ databasePath: '   ' })).toThrow('databasePath')
    const expanded = resolvePersonalConfig({ databasePath: '~/custom/personal.db' })
    expect(expanded.databasePath).not.toContain('~')
  })
})
