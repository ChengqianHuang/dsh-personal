import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PersonalService } from '../src/index.ts'
import { resolveSearchWeights } from '../src/config.ts'
import { openPersonalDatabase } from '../src/store/open.ts'
import { personalSearchIndex, tokenizeSearch } from '../src/store/search.ts'
import { createQueryTools } from '../src/tools/query.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

let root: string | undefined
const disposers: Array<() => void> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function fixture(): Promise<{ service: PersonalService; path: string }> {
  root = await mkdtemp(join(tmpdir(), 'personal-search-'))
  const path = join(root, 'personal.db')
  const service = new PersonalService(new Context(), { databasePath: path, timezone: 'UTC' })
  disposers.push(() => { service.close() })
  return { service, path }
}

function titles(result: Awaited<ReturnType<PersonalService['searchPersonal']>>): string[] {
  return result.hits.map(hit => {
    const row = hit.row as Record<string, JsonValue>
    return String(row.title ?? row.name ?? row.summary)
  })
}

async function corpus(service: PersonalService): Promise<void> {
  await service.createTask({ title: '检查博客的 HTTPS 证书' })
  await service.createTask({ title: '博客域名续费' })
  await service.recordExperience({ category: 'movie', action: 'watched', title: '火星救援', note: '太空科幻电影，视觉出色', tags: ['sci-fi'], occurredOn: '2026-09-25' })
  await service.recordExperience({ category: 'book', action: 'read', title: '失控', note: '读完第一章', occurredOn: '2026-09-24' })
  await service.recordProjectLog({ project: 'Forge', title: '修复 streaming 中文错位', content: '完成流式文本对齐', date: '2026-09-23' })
  await service.createBlogPost({ title: '基于 DSH 构建个人助理', summary: 'SQLite 持久化与工具设计', tags: ['agent'] })
  await service.registerWebsite({ name: '技术博客', domain: 'blog.example.com', description: '部署在 GitHub Pages' })
  await service.createIdea({ title: '个人助理检索优化', content: '中文分词和相关性排序' })
  await service.recordDailyLog({ summary: '读书与写作', rawText: '记录了今天的学习心得', date: '2026-09-22' })
}

describe('keyword retrieval', () => {
  it('retrieves a practical Chinese and English query corpus', async () => {
    const { service } = await fixture()
    await corpus(service)
    const cases: Array<[string, string]> = [
      ['博客证书', '检查博客的 HTTPS 证书'], ['HTTPS 证书', '检查博客的 HTTPS 证书'],
      ['证书 博客', '检查博客的 HTTPS 证书'], ['博客域名', '博客域名续费'],
      ['火星救援', '火星救援'], ['科幻电影', '火星救援'], ['视觉', '火星救援'],
      ['sci-fi', '火星救援'], ['失控 第一章', '失控'], ['第一章', '失控'],
      ['中文错位', '修复 streaming 中文错位'], ['STREAMING 中文', '修复 streaming 中文错位'],
      ['流式对齐', '修复 streaming 中文错位'], ['SQLite 持久化', '基于 DSH 构建个人助理'],
      ['agent', '基于 DSH 构建个人助理'], ['GitHub Pages', '技术博客'],
      ['blog.example.com', '技术博客'], ['相关性排序', '个人助理检索优化'],
      ['学习心得', '读书与写作'], ['Forge', 'Forge'],
    ]
    for (const [query, expected] of cases) {
      expect(titles(await service.searchPersonal({ text: query })), query).toContain(expected)
    }
    expect(tokenizeSearch('博客证书')).toEqual(['博客', '证书'])
  })

  it('requires all terms by default and explicitly broadens with any', async () => {
    const { service } = await fixture()
    await service.createTask({ title: '检查博客的证书' })
    await service.createTask({ title: '续费博客域名' })
    const all = await service.searchPersonal({ text: '博客 证书' })
    expect(titles(all)).toEqual(['检查博客的证书'])
    const any = await service.searchPersonal({ text: '博客 证书', match: 'any' })
    expect(titles(any)).toContain('续费博客域名')
    expect(titles(any)[0]).toBe('检查博客的证书')
    expect((await service.searchPersonal({ text: '不存在证书' })).hits).toEqual([])
  })

  it('ranks title matches above body matches across types and caps globally', async () => {
    const { service } = await fixture()
    await service.createIdea({ title: '整理笔记', content: '证书' })
    await service.createTask({ title: '证书' })
    const ranked = await service.searchPersonal({ text: '证书' })
    expect(ranked.hits.map(hit => hit.type)).toEqual(['task', 'idea'])
    expect(ranked.hits[0]!.score).toBeGreaterThan(ranked.hits[1]!.score)
    expect(titles(await service.searchPersonal({ text: '证书', limit: 1 }))).toEqual(['证书'])
    expect((await service.searchPersonal({ text: '证书', types: ['idea'] })).hits.map(hit => hit.type)).toEqual(['idea'])
    expect((await service.searchPersonal({ text: '证书', types: [] })).hits).toEqual([])
  })

  it('combines relevance with dates, category, action, and exact tags', async () => {
    const { service } = await fixture()
    await service.recordExperience({ category: 'book', action: 'read', title: 'SQLite 检索', tags: ['database'], occurredOn: '2026-09-20' })
    await service.recordExperience({ category: 'movie', action: 'watched', title: '检索', note: 'SQLite', tags: ['database'], occurredOn: '2026-09-21' })
    await service.recordExperience({ category: 'book', action: 'read', title: 'SQLite 检索新篇', tags: ['other'], occurredOn: '2026-09-22' })
    const rows = await service.queryExperiences({ text: 'SQLite 检索', category: ' BOOK ', action: 'READ', tag: 'DATABASE', from: '2026-09-20', to: '2026-09-20' })
    expect(rows.map(row => row.title)).toEqual(['SQLite 检索'])
    expect((await service.queryExperiences({ text: 'SQLite 检索', category: 'book', from: '2026-09-21' })).map(row => row.title)).toEqual(['SQLite 检索新篇'])
    expect(titles(await service.searchPersonal({ text: '检索', to: '2026-09-20' }))).toEqual(['SQLite 检索'])
  })

  it('treats punctuation and FTS syntax as text rather than operators', async () => {
    const { service } = await fixture()
    await service.createTask({ title: '检查证书' })
    expect((await service.searchPersonal({ text: '% _ " * ()' })).hits).toEqual([])
    expect((await service.searchPersonal({ text: '证书 OR 不存在' })).hits).toEqual([])
    expect(titles(await service.searchPersonal({ text: '"证书"' }))).toEqual(['检查证书'])
  })

  it('keeps inserts, updates, deletes, and rollbacks consistent with search', async () => {
    const { service, path } = await fixture()
    const task = await service.createTask({ title: '旧证书' })
    expect(titles(await service.searchPersonal({ text: '旧证书' }))).toEqual(['旧证书'])
    await service.updateTask(task.id, { title: '域名续费' })
    expect((await service.searchPersonal({ text: '旧证书' })).hits).toEqual([])
    expect(titles(await service.searchPersonal({ text: '域名' }))).toEqual(['域名续费'])
    await service.createTask({ title: '博客证书' })
    expect(titles(await service.searchPersonal({ text: '博客证书' }))).toEqual(['博客证书'])
    const db = await openPersonalDatabase(path)
    disposers.push(() => { db.close() })
    const index = personalSearchIndex(db)
    const input = { text: '域名', weights: resolveSearchWeights({}) }
    expect(index.search(input).hits).toHaveLength(1)
    db.exec('BEGIN IMMEDIATE')
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('回滚记录', task.id)
    db.exec('ROLLBACK')
    expect(index.search(input).hits).toHaveLength(1)
    expect(index.search({ ...input, text: '回滚记录' }).hits).toEqual([])
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id)
    expect(index.search(input).hits).toEqual([])
    expect((await service.searchPersonal({ text: '域名' })).hits).toEqual([])
  })

  it('observes other connections and restores an index after restart without changing v4', async () => {
    const { service, path } = await fixture()
    const task = await service.createTask({ title: '博客证书' })
    expect((await service.searchPersonal({ text: '证书' })).hits).toHaveLength(1)
    const second = new PersonalService(new Context(), { databasePath: path, timezone: 'UTC' })
    disposers.push(() => { second.close() })
    await second.updateTask(task.id, { title: '域名续费' })
    expect((await service.searchPersonal({ text: '证书' })).hits).toEqual([])
    expect(titles(await service.searchPersonal({ text: '域名' }))).toEqual(['域名续费'])
    const db = await openPersonalDatabase(path)
    disposers.push(() => { db.close() })
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 })
    expect(db.prepare("SELECT name FROM main.sqlite_schema WHERE name LIKE 'personal_search%'").all()).toEqual([])
    service.close()
    const restarted = new PersonalService(new Context(), { databasePath: path, timezone: 'UTC' })
    disposers.push(() => { restarted.close() })
    expect(titles(await restarted.searchPersonal({ text: '域名' }))).toEqual(['域名续费'])
  })

  it('projects every domain row faithfully and applies windows to projects and websites', async () => {
    const { service } = await fixture()
    await corpus(service)
    for (const type of ['experience', 'project', 'project_log', 'task', 'blog_post', 'website', 'idea', 'daily_log'] as const) {
      const result = await service.searchPersonal({ text: { experience: '火星', project: 'Forge', project_log: '中文', task: '证书', blog_post: 'DSH', website: 'GitHub', idea: '分词', daily_log: '心得' }[type], types: [type] })
      expect(result.hits).toHaveLength(1)
      expect((result.hits[0]!.row as Record<string, JsonValue>).id).toBeTypeOf('string')
    }
    expect((await service.searchPersonal({ text: 'Forge', to: '2020-01-01' })).hits).toEqual([])
    expect((await service.searchPersonal({ text: 'GitHub', to: '2020-01-01' })).hits).toEqual([])
    const experience = (await service.searchPersonal({ text: '火星' })).hits[0]!.row
    expect(experience).toEqual((await service.queryExperiences({ category: 'movie' }))[0])
  })

  it('does not mix rows from an external commit during an index rebuild', async () => {
    const { service, path } = await fixture()
    const task = await service.createTask({ title: '旧证书' })
    const reader = await openPersonalDatabase(path)
    disposers.push(() => { reader.close() })
    const writer = await openPersonalDatabase(path)
    disposers.push(() => { writer.close() })
    const index = personalSearchIndex(reader)
    const input = { text: '证书', weights: resolveSearchWeights({}) }
    expect(index.search(input).hits).toHaveLength(1)
    writer.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('新证书', task.id)
    let injected = false
    reader.function('personal_search_tokens', value => {
      // SQLite invokes this while the reader is rebuilding inside its pinned
      // WAL snapshot. The other connection commits at this exact point.
      if (!injected) {
        injected = true
        writer.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('域名续费', task.id)
      }
      return tokenizeSearch(String(value), true).join(' ')
    })
    expect(titles(index.search(input))).toEqual(['新证书'])
    expect(injected).toBe(true)
    expect(index.search(input).hits).toEqual([])
    expect(titles(index.search({ ...input, text: '域名' }))).toEqual(['域名续费'])
  })

  it('retries a failed rebuild without publishing a stale version counter', async () => {
    const { service, path } = await fixture()
    const task = await service.createTask({ title: '证书' })
    const reader = await openPersonalDatabase(path)
    disposers.push(() => { reader.close() })
    const index = personalSearchIndex(reader)
    const input = { text: '证书', weights: resolveSearchWeights({}) }
    expect(index.search(input).hits).toHaveLength(1)
    await service.updateTask(task.id, { title: '域名续费' })
    reader.function('personal_search_tokens', (_value) => { throw new Error('index build interrupted') })
    expect(() => index.search(input)).toThrow('index build interrupted')
    reader.function('personal_search_tokens', value => tokenizeSearch(String(value), true).join(' '))
    expect(index.search(input).hits).toEqual([])
    expect(titles(index.search({ ...input, text: '域名' }))).toEqual(['域名续费'])
  })

  it('renders a stable, ranked model-visible result', async () => {
    const { service, path } = await fixture()
    await service.createTask({ title: '博客证书' })
    await service.createIdea({ title: '博客证书续期流程' })
    const db = await openPersonalDatabase(path)
    try {
      db.exec("UPDATE tasks SET id = 'task_fixture', created_at = '2026-09-20T00:00:00.000Z', updated_at = '2026-09-20T00:00:00.000Z'")
      db.exec("UPDATE ideas SET id = 'idea_fixture', created_at = '2026-09-20T00:00:00.000Z'")
    } finally { db.close() }
    const tool = createQueryTools(service).find(tool => tool.name === 'search_personal_data')!
    const args = { text: '博客证书' }
    const value = await tool.execute(args, { signal: new AbortController().signal } as ToolRunContext)
    expect(tool.output.render(args, value).filter(block => block.type === 'text').map(block => block.text).join('')).toMatchInlineSnapshot(`
      "Found 2 matches for "博客证书" (relevance order).
      Keywords: 博客, 证书
      1. task: TODO [MEDIUM] 博客证书
         Record: {"id":"task_fixture","title":"博客证书","status":"TODO","priority":"MEDIUM","dueAt":null,"doneAt":null,"projectId":null,"websiteId":null,"sourceType":null,"sourceId":null,"createdAt":"2026-09-20T00:00:00.000Z","updatedAt":"2026-09-20T00:00:00.000Z"}
      2. idea: 博客证书续期流程
         Record: {"id":"idea_fixture","title":"博客证书续期流程","content":"","category":"","relatedProjectId":null,"createdAt":"2026-09-20T00:00:00.000Z"}"
    `)
  })

  it('validates configurable field weights', () => {
    expect(resolveSearchWeights({ searchTitleWeight: 8 })).toEqual({ title: 8, tags: 3, body: 1 })
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveSearchWeights({ searchBodyWeight: value })).toThrow('positive finite')
    }
  })
})
