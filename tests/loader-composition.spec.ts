// Real Loader composition: boots `@deepseek-ai/dsh-personal` through a
// cordis.yml, proves the tools and service activate, and proves disposal
// unregisters the tools and closes the database (HMR-safety contract).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { openPersonalDatabase } from '../src/store/open.ts'
import * as Personal from '../src/index.ts'

const TOOL_NAMES = [
  'record_experience',
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
  'query_experiences',
  'query_tasks',
  'query_project_logs',
  'query_blog_posts',
  'query_websites',
  'search_personal_data',
  'generate_daily_review',
  'generate_weekly_review',
]

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-personal-loader-'))
  const databasePath = join(root, 'personal.db')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-personal'",
    '  config:',
    `    databasePath: ${JSON.stringify(databasePath)}`,
    ...configLines,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-personal', Personal],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('dsh-personal real Loader composition', () => {
  it('activates the service, registers every tool, and persists through one', async () => {
    const ctx = await boot([])
    expect(ctx.personal).toBeInstanceOf(Personal.PersonalService)
    const names = ctx.tools.schemas().map(schema => schema.name).sort()
    expect(names).toEqual([...TOOL_NAMES].sort())

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'compose-1' as never,
      name: 'record_experience',
      arguments: { category: 'movie', action: 'watched', title: '灵媒', rating: 7 },
    })
    expect(result.isError).toBe(false)

    // Source of truth check: the row is in SQLite, not only in memory.
    const db = await openPersonalDatabase(join(root!, 'personal.db'))
    const rows = db.prepare('SELECT title, rating FROM experiences').all() as Array<{ title: string; rating: number }>
    db.close()
    expect(rows).toEqual([{ title: '灵媒', rating: 7 }])
  }, 30_000)

  it('disposal unregisters the tools and closes the database', async () => {
    const ctx = await boot([])
    const tools = ctx.tools
    const personal = ctx.personal
    await tools.execute({
      signal: new AbortController().signal,
      callId: 'compose-2' as never,
      name: 'record_experience',
      arguments: { category: 'movie', action: 'watched', title: 'Quiet' },
    })
    expect(tools.get('record_experience')).toBeDefined()
    await ctx.fiber.dispose()
    context = undefined
    expect(tools.get('record_experience')).toBeUndefined()
    await expect(personal.queryExperiences({})).rejects.toThrow('disposed')
    // The file lock is released: an independent open succeeds and sees the row.
    const db = await openPersonalDatabase(join(root!, 'personal.db'))
    const rows = db.prepare('SELECT title FROM experiences').all() as Array<{ title: string }>
    db.close()
    expect(rows).toEqual([{ title: 'Quiet' }])
  }, 30_000)

  it('gates the review tools through config', async () => {
    const ctx = await boot(['    enableDailyReview: false'])
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).not.toContain('generate_daily_review')
    expect(names).toContain('generate_weekly_review')
  }, 30_000)

  it('fails load on an invalid timezone', async () => {
    await expect(boot(['    timezone: "Mars/Olympus"'])).rejects.toThrow('timezone')
  }, 30_000)

  it('ranks registered search-tool results using configured field weights', async () => {
    const ctx = await boot(['    searchTitleWeight: 1', '    searchBodyWeight: 20'])
    const db = await openPersonalDatabase(join(root!, 'personal.db'))
    try {
      db.exec("INSERT INTO tasks (id, title, status, priority, created_at, updated_at) VALUES ('task_fixture', '证书', 'TODO', 'MEDIUM', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z')")
      db.exec("INSERT INTO ideas (id, title, content, category, created_at) VALUES ('idea_fixture', '整理笔记', '证书', '', '2026-09-20T00:00:00.000Z')")
    } finally { db.close() }
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'search-compose' as never,
      name: 'search_personal_data',
      arguments: { text: '证书', limit: 2 },
    })
    expect(result.isError).toBe(false)
    expect(result.content.filter(block => block.type === 'text').map(block => block.text).join('')).toMatchInlineSnapshot(`
      "Found 2 matches for "证书" (relevance order).
      Keywords: 证书
      1. idea: 整理笔记
         Record: {"id":"idea_fixture","title":"整理笔记","content":"证书","category":"","relatedProjectId":null,"createdAt":"2026-09-20T00:00:00.000Z"}
      2. task: TODO [MEDIUM] 证书
         Record: {"id":"task_fixture","title":"证书","status":"TODO","priority":"MEDIUM","dueAt":null,"doneAt":null,"projectId":null,"websiteId":null,"sourceType":null,"sourceId":null,"createdAt":"2026-09-20T00:00:00.000Z","updatedAt":"2026-09-20T00:00:00.000Z"}"
    `)
  }, 30_000)

  it('fails load on invalid search weights', async () => {
    await expect(boot(['    searchTagWeight: 0'])).rejects.toThrow('positive finite')
  }, 30_000)
})
