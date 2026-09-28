import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { PersonalService } from '../src/index.ts'
import { openPersonalDatabase } from '../src/store/open.ts'
import { todayIso, addDays } from '../src/dates.ts'
import type { PersonalObjectType, PersonalRecordId } from '../src/types.ts'

let root: string | undefined
const services: PersonalService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) service.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})
async function boot(): Promise<PersonalService> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-personal-records-'))
  const service = new PersonalService(new Context(), { databasePath: join(root, 'personal.db'), timezone: 'UTC' })
  services.push(service)
  return service
}
async function edit(s: PersonalService, type: PersonalObjectType, id: PersonalRecordId, patch: JsonValue) {
  return s.updateRecord(type, id, (await s.getRecord(type, id)).revision, patch)
}
async function remove(s: PersonalService, type: PersonalObjectType, id: PersonalRecordId) {
  return s.deleteRecord(type, id, (await s.getRecord(type, id)).revision)
}

describe('guarded record editing', () => {
  it('updates all eight kinds and deletes children before parents without cascading', async () => {
    const s = await boot()
    const p = await s.createProject({ name: 'Blog' })
    const w = await s.registerWebsite({ name: 'Site', domain: 'example.com' })
    const e = await s.recordExperience({ category: 'movie', action: 'watched', title: '灵媒', rating: 7.5 })
    const duplicate = await s.recordExperience({ category: 'movie', action: 'watched', title: '灵媒', rating: 6 })
    const l = (await s.recordProjectLog({ project: p.id, title: '日志' })).log
    const t = await s.createTask({ title: '证书任务' })
    const b = await s.createBlogPost({ title: '文章' })
    const i = await s.createIdea({ title: '想法' })
    const d = await s.recordDailyLog({ summary: '日记' })
    const cases: Array<[PersonalObjectType, PersonalRecordId, JsonValue]> = [
      ['experience', e.id, { rating: 8, category: ' Movie ', tags: [' horror '] }],
      ['project', p.id, { name: 'Blog Project', status: 'PAUSED' }],
      ['project_log', l.id, { content: '已修复', status: 'WIP' }],
      ['task', t.id, { status: 'DONE', priority: 'HIGH', projectId: p.id, websiteId: w.id }],
      ['blog_post', b.id, { status: 'DRAFT', relatedProjectId: p.id }],
      ['website', w.id, { description: '我的博客', domain: 'blog.example.com' }],
      ['idea', i.id, { relatedProjectId: p.id, content: '写检索' }],
      ['daily_log', d.id, { summary: '新的小结', rawText: '原话', date: '2026-09-01' }],
    ]
    for (const [type, id, patch] of cases) {
      const before = await s.getRecord(type, id)
      const after = await s.updateRecord(type, id, before.revision, patch)
      expect(after.revision).not.toBe(before.revision)
      expect(after.row.createdAt).toBe(before.row.createdAt)
      expect(after.row.id).toBe(id)
    }
    expect((await s.getRecord('experience', duplicate.id)).row.rating).toBe(6)
    expect((await s.getRecord('experience', e.id)).row).toMatchObject({ rating: 8, category: 'movie', tags: ['horror'] })
    expect((await s.getRecord('task', t.id)).row.doneAt).toBe(todayIso('UTC'))
    for (const [type, id] of cases.filter(([type]) => type !== 'project' && type !== 'website')) {
      const read = await s.getRecord(type, id)
      expect((await s.deleteRecord(type, id, read.revision)).deleted).toEqual(read)
      await expect(s.getRecord(type, id)).rejects.toThrow('unknown')
    }
    await remove(s, 'project', p.id)
    await remove(s, 'website', w.id)
    expect((await s.queryExperiences({})).map(row => row.id)).toEqual([duplicate.id])
  })

  it('supports clearing nullable fields, tags and text; manages completion dates and dueIn', async () => {
    const s = await boot()
    const e = await s.recordExperience({ category: 'movie', action: 'watched', title: '灵媒', rating: 7.5, note: '保留', tags: ['tag'] })
    expect((await edit(s, 'experience', e.id, { rating: null })).row).toMatchObject({ rating: null, note: '保留', tags: ['tag'] })
    expect((await edit(s, 'experience', e.id, { note: '', tags: [] })).row).toMatchObject({ note: '', tags: [] })
    const p = await s.createProject({ name: 'Project' })
    const i = await s.createIdea({ title: 'idea', relatedProject: p.id })
    expect((await edit(s, 'idea', i.id, { relatedProjectId: null })).row.relatedProjectId).toBeNull()
    const t = await s.createTask({ title: 'task', dueIn: 'tomorrow', project: p.id })
    expect((await edit(s, 'task', t.id, { dueAt: null, projectId: null })).row).toMatchObject({ dueAt: null, projectId: null })
    expect((await edit(s, 'task', t.id, { dueIn: 'tomorrow' })).row.dueAt).toBe(addDays(todayIso('UTC'), 1))
    expect((await edit(s, 'task', t.id, { dueAt: null, dueIn: 'tomorrow' })).row.dueAt).toBeNull()
    await edit(s, 'task', t.id, { status: 'DONE' })
    expect((await edit(s, 'task', t.id, { title: 'renamed' })).row.doneAt).toBe(todayIso('UTC'))
    expect((await edit(s, 'task', t.id, { status: 'DOING' })).row.doneAt).toBeNull()
  })

  it('rejects invalid or protected fields and uniqueness conflicts without partial writes', async () => {
    const s = await boot()
    const e = await s.recordExperience({ category: 'movie', action: 'watched', title: 'original', rating: 7 })
    const before = await s.getRecord('experience', e.id)
    const invalid: JsonValue[] = [null, [], {}, 'x', { id: 'other' }, { createdAt: 'x' }, { updatedAt: 'x' },
      { title: ' ' }, { category: '' }, { action: null }, { rating: 11 }, { rating: '8' }, { rating: Infinity },
      { occurredOn: '2026-02-30' }, { occurredOn: addDays(todayIso('UTC'), 1) }, { tags: [' '] }, { tags: null },
      { title: 'changed', status: 'DONE' }, JSON.parse('{"__proto__":{}}') as JsonValue]
    for (const patch of invalid) {
      await expect(s.updateRecord('experience', e.id, before.revision, patch)).rejects.toThrow()
      expect(await s.getRecord('experience', e.id)).toEqual(before)
    }
    await expect(s.getRecord('task', e.id)).rejects.toThrow('unknown task')
    await expect(s.deleteRecord('experience', 'missing' as PersonalRecordId, before.revision)).rejects.toThrow('unknown')
    const t = await s.createTask({ title: 'task' })
    for (const patch of [{ status: 'PAUSED' }, { priority: 'URGENT' }, { doneAt: null }, { projectId: 'ghost' }, { dueIn: 'someday' }, { sourceId: 'x' }]) {
      await expect(edit(s, 'task', t.id, patch)).rejects.toThrow()
    }
    const p = await s.createProject({ name: 'unique' })
    const q = await s.createProject({ name: 'other' })
    const read = await s.getRecord('project', q.id)
    await expect(edit(s, 'project', q.id, { name: p.name })).rejects.toThrow('UNIQUE')
    expect(await s.getRecord('project', q.id)).toEqual(read)
  })

  it('rejects stale updates and deletion after another connection edits, including direct SQLite writes', async () => {
    const s = await boot()
    const t = await s.createTask({ title: 'task' })
    const read = await s.getRecord('task', t.id)
    const other = await boot()
    const db = await openPersonalDatabase(join(root!, 'personal.db'))
    try { db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('external change', t.id) } finally { db.close() }
    await expect(s.updateRecord('task', t.id, read.revision, { status: 'DONE' })).rejects.toThrow('record changed')
    await expect(s.deleteRecord('task', t.id, read.revision)).rejects.toThrow('record changed')
    await edit(s, 'task', t.id, { status: 'DONE' })
    expect((await other.getRecord('task', t.id)).row).toMatchObject({ title: 'external change', status: 'DONE' })
  })

  it('blocks incoming references, permits reassignment and removes explicit relations atomically', async () => {
    const s = await boot()
    const p = await s.createProject({ name: 'P' })
    const q = await s.createProject({ name: 'Q' })
    const w = await s.registerWebsite({ name: 'W', domain: 'example.com' })
    const i = await s.createIdea({ title: 'idea', relatedProject: p.id })
    const l = (await s.recordProjectLog({ project: p.id, title: 'log' })).log
    const t = await s.createTask({ title: 'task', project: p.id, website: w.id, sourceType: 'idea', sourceId: i.id })
    const b = await s.createBlogPost({ title: 'post', relatedProject: p.id })
    await s.linkObjects({ type: 'project', id: p.id }, 'related', { type: 'idea', id: i.id })
    for (const [type, id] of [['project', p.id], ['website', w.id], ['idea', i.id]] as const) {
      await expect(remove(s, type, id)).rejects.toThrow('record is referenced')
    }
    await edit(s, 'task', t.id, { projectId: null, websiteId: null, sourceType: null, sourceId: null })
    await edit(s, 'idea', i.id, { relatedProjectId: q.id })
    await edit(s, 'blog_post', b.id, { relatedProjectId: null })
    await edit(s, 'project_log', l.id, { projectId: q.id })
    expect((await remove(s, 'project', p.id)).removedRelations).toBe(1)
    const db = await openPersonalDatabase(join(root!, 'personal.db'))
    try {
      expect(db.prepare('SELECT * FROM relations').all()).toEqual([])
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 })
    } finally { db.close() }
    expect((await s.getRecord('project_log', l.id)).row.projectId).toBe(q.id)
  })

  it('rolls back relation cleanup on storage failure and updates the search index after edit/delete', async () => {
    const s = await boot()
    const e = await s.recordExperience({ category: 'movie', action: 'watched', title: '旧关键词' })
    const i = await s.createIdea({ title: 'idea' })
    await s.linkObjects({ type: 'idea', id: i.id }, 'related', { type: 'experience', id: e.id })
    expect((await s.searchPersonal({ text: '旧关键词' })).hits).toHaveLength(1)
    const changed = await edit(s, 'experience', e.id, { title: '博客证书' })
    expect((await s.searchPersonal({ text: '旧关键词' })).hits).toHaveLength(0)
    expect((await s.searchPersonal({ text: '博客证书' })).hits).toHaveLength(1)
    const db = await openPersonalDatabase(join(root!, 'personal.db'))
    try {
      db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON experiences BEGIN SELECT RAISE(ABORT, 'blocked by fixture'); END")
      await expect(s.deleteRecord('experience', e.id, changed.revision)).rejects.toThrow('blocked by fixture')
      expect(db.prepare('SELECT COUNT(*) AS n FROM relations').get()).toEqual({ n: 1 })
      expect(await s.getRecord('experience', e.id)).toEqual(changed)
      db.exec('DROP TRIGGER reject_delete')
      await s.deleteRecord('experience', e.id, changed.revision)
      expect((await s.searchPersonal({ text: '博客证书' })).hits).toHaveLength(0)
    } finally { db.close() }
  })

  it('preserves edits, deletion and revision across a cold reopen', async () => {
    const s = await boot()
    const e = await s.recordExperience({ category: 'movie', action: 'watched', title: '灵媒', rating: 7.5 })
    const i = await s.createIdea({ title: '删除的想法' })
    const changed = await edit(s, 'experience', e.id, { rating: 8 })
    await remove(s, 'idea', i.id)
    s.close()
    services.splice(services.indexOf(s), 1)
    const reopened = await boot()
    expect(await reopened.getRecord('experience', e.id)).toEqual(changed)
    await expect(reopened.getRecord('idea', i.id)).rejects.toThrow('unknown')
    expect((await reopened.searchPersonal({ text: '灵媒' })).hits[0]!.row).toMatchObject({ rating: 8 })
  })
})
