import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPersonalDatabase } from '../src/store/open.ts'
import {
  PERSONAL_APPLICATION_ID,
  PERSONAL_SCHEMA_VERSION,
  SchemaVersionError,
} from '../src/store/schema.ts'
import { BlogPostStore } from '../src/store/blogs.ts'
import { DailyLogStore, IdeaStore } from '../src/store/ideas.ts'
import { ExperienceStore, categoryQueryVariants } from '../src/store/experiences.ts'
import { ProjectLogStore, ProjectStore } from '../src/store/projects.ts'
import { RelationStore } from '../src/store/relations.ts'
import { TaskStore } from '../src/store/tasks.ts'
import { WebsiteStore } from '../src/store/websites.ts'
import { normalizeLimit } from '../src/store/statements.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function tempDb(): Promise<{ path: string; close: () => void }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-personal-store-'))
  const path = join(root, 'personal.db')
  const db = await openPersonalDatabase(path)
  return { path, close: () => { db.close() } }
}

describe('open and migrate', () => {
  it('creates a fresh database stamped with version and application id', async () => {
    const { path, close } = await tempDb()
    const db = await openPersonalDatabase(path)
    const applicationId = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(applicationId.application_id).toBe(PERSONAL_APPLICATION_ID)
    expect(version.user_version).toBe(PERSONAL_SCHEMA_VERSION)
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'",
    ).all() as Array<{ name: string }>).map(row => row.name)
    for (const expected of ['experiences', 'projects', 'project_logs', 'tasks', 'blog_posts', 'websites', 'ideas', 'daily_logs', 'relations']) {
      expect(tables).toContain(expected)
    }
    db.close()
    close()
  })

  it('reopens an existing database without changing the version', async () => {
    const { path, close } = await tempDb()
    const first = await openPersonalDatabase(path)
    first.close()
    const second = await openPersonalDatabase(path)
    const version = second.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(version.user_version).toBe(PERSONAL_SCHEMA_VERSION)
    second.close()
    close()
  })

  it('rejects a database that belongs to another application', async () => {
    const { path, close } = await tempDb()
    close()
    const db = await openPersonalDatabase(path)
    db.exec(`PRAGMA application_id = ${PERSONAL_APPLICATION_ID + 1}`)
    db.close()
    await expect(openPersonalDatabase(path)).rejects.toThrow('belongs to another application')
  })

  it('rejects a database from a newer build instead of guessing', async () => {
    const { path, close } = await tempDb()
    close()
    const db = await openPersonalDatabase(path)
    db.exec(`PRAGMA user_version = ${PERSONAL_SCHEMA_VERSION + 1}`)
    db.close()
    await expect(openPersonalDatabase(path)).rejects.toBeInstanceOf(SchemaVersionError)
  })

  it('rejects an unattributed database that already carries user tables', async () => {
    const { path } = { path: join(tmpdir(), 'dsh-personal-foreign.db') }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE foreign_data (x TEXT) STRICT')
    db.close()
    await expect(openPersonalDatabase(path)).rejects.toThrow('unrecognized user tables')
    await rm(path, { force: true })
  })
})

async function openStores() {
  const { path, close } = await tempDb()
  const db = await openPersonalDatabase(path)
  const experiences = new ExperienceStore(db, 'UTC')
  const projects = new ProjectStore(db)
  const projectLogs = new ProjectLogStore(db, 'UTC')
  const tasks = new TaskStore(db, 'UTC')
  const blogPosts = new BlogPostStore(db)
  const websites = new WebsiteStore(db)
  const ideas = new IdeaStore(db)
  const dailyLogs = new DailyLogStore(db, 'UTC')
  const relations = new RelationStore(db)
  return {
    stores: { experiences, projects, projectLogs, tasks, blogPosts, websites, ideas, dailyLogs, relations },
    close: () => {
      db.close()
      close()
    },
  }
}

describe('stores', () => {
  it('inserts, reads, and filters experiences with category normalization', async () => {
    const { stores, close } = await openStores()
    try {
      stores.experiences.insert({
        id: 'exp_1', category: 'Movie', action: 'Watched', title: '灵媒', occurredOn: '2026-09-26', rating: 7.5, note: '', tags: [' horror '], createdAt: '2026-09-26T00:00:00.000Z',
      })
      stores.experiences.insert({
        id: 'exp_2', category: 'book', action: 'read', title: 'Quiet', occurredOn: '2026-08-01', rating: null, note: 'nice', tags: ['slow'], createdAt: '2026-08-01T00:00:00.000Z',
      })
      expect(stores.experiences.get('exp_1' as never)?.title).toBe('灵媒')
      expect(stores.experiences.get('exp_1' as never)?.category).toBe('movie')
      expect(stores.experiences.get('missing' as never)).toBeUndefined()
      const september = stores.experiences.list({ from: '2026-09-01', to: '2026-09-30' })
      expect(september.map(row => row.id)).toEqual(['exp_1'])
      expect(september[0]!.tags).toEqual([' horror '])
      expect(stores.experiences.list({ tag: 'SLOW' }).map(row => row.id)).toEqual(['exp_2'])
      // Plural query words match singular writes; case differences match too.
      expect(stores.experiences.list({ category: 'movies' }).map(row => row.id)).toEqual(['exp_1'])
      expect(stores.experiences.list({ category: 'BOOK', action: 'reads' }).map(row => row.id)).toEqual(['exp_2'])
      expect(stores.experiences.searchText('quiet', {}, 20)).toHaveLength(1)
      expect(stores.experiences.searchText('%', {}, 20)).toHaveLength(0)
      expect(categoryQueryVariants('movies')).toEqual(['movies', 'movie'])
      expect(categoryQueryVariants('series')).toEqual(['series', 'serie'])
    } finally {
      close()
    }
  })

  it('keeps project names unique and lists logs newest first', async () => {
    const { stores, close } = await openStores()
    try {
      stores.projects.insert({ id: 'p1', name: 'Forge', description: '', status: 'ACTIVE', createdAt: '2026-09-01T00:00:00.000Z' })
      stores.projects.insert({ id: 'p2', name: 'Blog', description: 'd', status: 'PAUSED', createdAt: '2026-09-02T00:00:00.000Z' })
      expect(stores.projects.get('p1' as never)?.name).toBe('Forge')
      expect(stores.projects.getByName('Blog')?.id).toBe('p2')
      expect(stores.projects.getByName('Nope')).toBeUndefined()
      expect(stores.projects.list()).toHaveLength(2)
      stores.projects.touch('p1' as never)
      stores.projectLogs.insert({
        id: 'l1', projectId: 'p1', date: '2026-09-25', title: 'old', content: '', status: 'DONE', tags: [], createdAt: '2026-09-25T00:00:00.000Z',
      })
      stores.projectLogs.insert({
        id: 'l2', projectId: 'p1', date: '2026-09-26', title: 'new', content: '定位了问题', status: 'DONE', tags: ['debug'], createdAt: '2026-09-26T00:00:00.000Z',
      })
      const logs = stores.projectLogs.list({ projectId: 'p1' as never })
      expect(logs.map(row => row.id)).toEqual(['l2', 'l1'])
      expect(stores.projectLogs.searchText('定位', {}, 20)).toHaveLength(1)
      expect(stores.projectLogs.list({ projectId: 'p1' as never, tag: 'debug' })).toHaveLength(1)
      expect(stores.projectLogs.get('missing' as never)).toBeUndefined()
    } finally {
      close()
    }
  })

  it('stamps done_at on DONE transitions and answers due filters', async () => {
    const { stores, close } = await openStores()
    try {
      const today = new Date().toISOString().slice(0, 10)
      stores.tasks.insert({
        id: 't1', title: 'ship', status: 'TODO', priority: 'HIGH', dueAt: today,
        projectId: null, websiteId: null, sourceType: null, sourceId: null, createdAt: '2026-09-26T00:00:00.000Z',
      })
      stores.tasks.insert({
        id: 't2', title: 'late', status: 'TODO', priority: 'LOW', dueAt: '2026-01-01',
        projectId: null, websiteId: null, sourceType: null, sourceId: null, createdAt: '2026-09-26T00:00:00.000Z',
      })
      stores.tasks.insert({
        id: 't3', title: 'done directly', status: 'DONE', priority: 'MEDIUM', dueAt: null,
        projectId: null, websiteId: null, sourceType: 'blog_post', sourceId: 'blog_1', createdAt: '2026-09-26T00:00:00.000Z',
      })
      expect(stores.tasks.get('t3' as never)?.doneAt).toBe(today)
      expect(stores.tasks.list({ statuses: ['TODO'] }).map(row => row.id)).toEqual(['t2', 't1'])
      expect(stores.tasks.list({ due: 'overdue' }).map(row => row.id)).toEqual(['t2'])
      expect(stores.tasks.list({ due: 'today' }).map(row => row.id)).toEqual(['t1'])
      expect(stores.tasks.list({ due: 'this-week' }).map(row => row.id)).toEqual(['t1'])
      expect(stores.tasks.list({ priority: 'HIGH' })).toHaveLength(1)
      expect(stores.tasks.list({ projectId: 'p9' as never })).toEqual([])
      expect(stores.tasks.list({ websiteId: 'w9' as never })).toEqual([])
      expect(stores.tasks.listOpenDueBetween({ from: today, to: today }).map(row => row.id)).toEqual(['t1'])
      expect(stores.tasks.searchText('ship', {}, 20)).toHaveLength(1)

      const done = stores.tasks.update('t1' as never, { status: 'DONE' })
      expect(done?.doneAt).toBe(today)
      const reopened = stores.tasks.update('t1' as never, { status: 'TODO' })
      expect(reopened?.doneAt).toBeNull()
      stores.tasks.update('t1' as never, { title: 'ship v2', priority: 'MEDIUM', dueAt: null })
      expect(stores.tasks.get('t1' as never)).toMatchObject({ title: 'ship v2', priority: 'MEDIUM', dueAt: null })
      expect(stores.tasks.update('missing' as never, { title: 'x' })).toBeUndefined()
      expect(stores.tasks.listDoneOn(today).map(row => row.id)).toEqual(['t3'])
      expect(stores.tasks.listDoneBetween({ from: today, to: today }).map(row => row.id)).toEqual(['t3'])
    } finally {
      close()
    }
  })

  it('updates blog posts and lists by status, tag, and creation window', async () => {
    const { stores, close } = await openStores()
    try {
      stores.blogPosts.insert({
        id: 'b1', title: 'DSH Personal Agent', status: 'IDEA', summary: 's', content: 'c',
        tags: ['dsh'], relatedProjectId: null, createdAt: '2026-09-26T10:00:00.000Z',
      })
      expect(stores.blogPosts.get('b1' as never)?.status).toBe('IDEA')
      expect(stores.blogPosts.list({ status: 'IDEA' })).toHaveLength(1)
      expect(stores.blogPosts.list({ tag: 'DSH' })).toHaveLength(1)
      expect(stores.blogPosts.listCreatedBetween({ from: '2026-09-26', to: '2026-09-26' })).toHaveLength(1)
      expect(stores.blogPosts.searchText('personal', { from: '2026-09-26', to: '2026-09-26' }, 20)).toHaveLength(1)
      const updated = stores.blogPosts.update('b1' as never, { status: 'DRAFT', tags: ['dsh', 'agent'] })
      const renamed = stores.blogPosts.update('b1' as never, { title: 'DSH Personal Agent v2', summary: 's2', content: 'c2' })
      expect(renamed).toMatchObject({ title: 'DSH Personal Agent v2', summary: 's2', content: 'c2' })
      expect(updated).toMatchObject({ status: 'DRAFT', tags: ['dsh', 'agent'] })
      expect(stores.blogPosts.update('missing' as never, { title: 'x' })).toBeUndefined()
    } finally {
      close()
    }
  })

  it('keeps website domains unique and links relations idempotently', async () => {
    const { stores, close } = await openStores()
    try {
      stores.websites.insert({
        id: 'w1', name: 'Blog', domain: 'blog.example.com', repo: '', hosting: '',
        description: '', tags: ['blog'], createdAt: '2026-09-26T00:00:00.000Z',
      })
      expect(stores.websites.get('w1' as never)?.domain).toBe('blog.example.com')
      expect(stores.websites.getByDomain('blog.example.com')?.id).toBe('w1')
      expect(stores.websites.getByDomain('nope')).toBeUndefined()
      expect(stores.websites.list({ tag: 'BLOG' })).toHaveLength(1)
      expect(stores.websites.searchText('blog', 20)).toHaveLength(1)
      stores.projects.insert({ id: 'p1', name: 'Forge Site', description: 'web', status: 'ACTIVE', createdAt: '2026-09-26T00:00:00.000Z' })
      expect(stores.projects.searchText('forge', 20)).toHaveLength(1)

      const first = stores.relations.link({ type: 'task', id: 't1' }, 'maintains', { type: 'website', id: 'w1' })
      const second = stores.relations.link({ type: 'task', id: 't1' }, 'maintains', { type: 'website', id: 'w1' })
      expect(second.id).toBe(first.id)
      expect(stores.relations.listFrom('task', 't1')).toHaveLength(1)
      expect(stores.relations.listTo('website', 'w1')).toHaveLength(1)
    } finally {
      close()
    }
  })

  it('lists ideas by category and daily logs by date', async () => {
    const { stores, close } = await openStores()
    try {
      stores.projects.insert({ id: 'p1', name: 'Forge', description: '', status: 'ACTIVE', createdAt: '2026-09-26T00:00:00.000Z' })
      stores.ideas.insert({ id: 'i1', title: 'Idea', content: '', category: 'product', relatedProjectId: null, createdAt: '2026-09-26T00:00:00.000Z' })
      stores.ideas.insert({ id: 'i2', title: 'Raw', content: 'body', category: '', relatedProjectId: 'p1', createdAt: '2026-09-27T00:00:00.000Z' })
      expect(stores.ideas.get('i1' as never)?.category).toBe('product')
      expect(stores.ideas.get('missing' as never)).toBeUndefined()
      expect(stores.ideas.list({ category: 'PRODUCT' }).map(row => row.id)).toEqual(['i1'])
      expect(stores.ideas.listCreatedBetween({ from: '2026-09-27', to: '2026-09-27' }).map(row => row.id)).toEqual(['i2'])
      expect(stores.ideas.searchText('body', {}, 20)).toHaveLength(1)

      stores.dailyLogs.insert({ id: 'd1', date: '2026-09-26', summary: 'quiet day', rawText: 'r', createdAt: '2026-09-26T00:00:00.000Z' })
      expect(stores.dailyLogs.get('d1' as never)?.summary).toBe('quiet day')
      expect(stores.dailyLogs.get('missing' as never)).toBeUndefined()
      expect(stores.dailyLogs.listOn('2026-09-26')).toHaveLength(1)
      expect(stores.dailyLogs.list({ from: '2026-09-26', to: '2026-09-26' })).toHaveLength(1)
      expect(stores.dailyLogs.searchText('quiet', {}, 20)).toHaveLength(1)
    } finally {
      close()
    }
  })

  it('rolls back and rethrows when a migration fails mid-apply', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-personal-store-rollback-'))
    const path = join(root, 'personal.db')
    const { DatabaseSync } = await import('node:sqlite')
    const foreign = new DatabaseSync(path)
    // Ours by fingerprint, but at version 0 with a table migration 3 creates:
    // the gate passes, migration 3 fails, and the transaction must roll back
    // leaving version 0 stamped.
    foreign.exec(`PRAGMA application_id = ${PERSONAL_APPLICATION_ID}`)
    foreign.exec('CREATE TABLE experiences (id TEXT PRIMARY KEY) STRICT')
    foreign.close()
    await expect(openPersonalDatabase(path)).rejects.toThrow()
    const db = new DatabaseSync(path)
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
    ).all() as Array<{ name: string }>)
    db.close()
    expect(version.user_version).toBe(0)
    expect(tables).toEqual([])
  })

  it('rejects a legacy v2 database with rebuild instructions instead of misreading it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-personal-store-legacy-'))
    const path = join(root, 'personal.db')
    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`PRAGMA application_id = ${PERSONAL_APPLICATION_ID}`)
    legacy.exec('PRAGMA user_version = 2')
    legacy.exec('CREATE TABLE movies (id TEXT PRIMARY KEY) STRICT')
    legacy.close()
    const error = await openPersonalDatabase(path).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SchemaVersionError)
    expect((error as Error).message).toContain('schema version 2')
    expect((error as Error).message).toContain('Move or delete the database file')
    // The legacy file is untouched: no silent deletion, no silent misread.
    const db = new DatabaseSync(path)
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'movies'",
    ).all() as Array<{ name: string }>)
    db.close()
    expect(version.user_version).toBe(2)
    expect(tables).toEqual([{ name: 'movies' }])
  })

  it('opens in-memory databases for tooling', async () => {
    const db = await openPersonalDatabase(':memory:')
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(version.user_version).toBe(PERSONAL_SCHEMA_VERSION)
    db.close()
  })

  it('normalizes limits fail-loud', () => {
    expect(normalizeLimit(undefined)).toBe(20)
    expect(normalizeLimit(500)).toBe(200)
    expect(() => normalizeLimit(0)).toThrow('limit')
    expect(() => normalizeLimit(1.5)).toThrow('limit')
  })
})
