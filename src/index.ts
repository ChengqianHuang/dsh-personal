/**
 * `dsh-personal`: the personal assistant plugin. It owns one
 * SQLite database of structured personal data (experiences, projects, project
 * logs, tasks, blog posts, websites, ideas, daily logs, relations), exposes
 * deterministic operations through `ctx.personal`, and registers model-facing
 * capture, query, and review tools. The plugin is self-contained: disabling
 * or removing it leaves the harness and every other plugin untouched, and the
 * database file stays a plain, independently readable SQLite file.
 *
 * The Service class is declared in this entry file (the Loader and the config
 * catalog both read it here); the domain stores live under `src/store/`.
 * @module @deepseek-ai/dsh-personal
 */

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The personal-data service: deterministic operations over SQLite. */
    personal: PersonalService
  }
}

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { parseRecordPatch } from './record-edit.ts'
import { RecordStore } from './store/records.ts'
import type { PersonalRecordId, RecordRevision, RecordSnapshot } from './types.ts'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { DatabaseSync } from 'node:sqlite'
import z from '@deepseek-ai/schemastery'
import { resolvePersonalConfig, type Config, type PersonalSettings } from './config.ts'
import { addDays, assertDayOffset, assertIsoDate, resolveDueDate, resolveWindow, todayIso } from './dates.ts'
import { buildDailyReview, buildWeeklyReview, type ReviewStores } from './review.ts'
import { BlogPostStore } from './store/blogs.ts'
import { mintId } from './store/ids.ts'
import { DailyLogStore, IdeaStore } from './store/ideas.ts'
import { ExperienceStore } from './store/experiences.ts'
import { nowIso, withTransaction } from './store/statements.ts'
import { openPersonalDatabase } from './store/open.ts'
import { personalSearchIndex } from './store/search.ts'
import { ProjectLogStore, ProjectStore } from './store/projects.ts'
import { RelationStore } from './store/relations.ts'
import { TaskStore } from './store/tasks.ts'
import { WebsiteStore } from './store/websites.ts'
import { registerPersonalTools } from './tools/index.ts'
import type {
  BlogPostFilter,
  BlogPostId,
  BlogPostRow,
  CreateBlogPostInput,
  CreateIdeaInput,
  CreateProjectInput,
  CreateTaskInput,
  DailyLogFilter,
  DailyLogId,
  DailyLogRow,
  DailyReview,
  ExperienceFilter,
  ExperienceId,
  ExperienceRow,
  IdeaFilter,
  IdeaId,
  IdeaRow,
  PersonalObjectType,
  ProjectId,
  ProjectLogFilter,
  ProjectLogId,
  ProjectLogRow,
  ProjectRow,
  RecordDailyLogInput,
  RecordExperienceInput,
  RecordProjectLogInput,
  RegisterWebsiteInput,
  RelationRow,
  SearchPersonalInput,
  SearchPersonalResult,
  TaskFilter,
  TaskId,
  TaskRow,
  UpdateBlogPostInput,
  UpdateTaskInput,
  WebsiteFilter,
  WebsiteId,
  WebsiteRow,
  WeeklyReview,
} from './types.ts'

/** Initialized store bundle the service reads and writes through. */
interface StoreBundle extends ReviewStores {
  /** The connection every store shares; transactions run on it. */
  db: DatabaseSync
  experiences: ExperienceStore
  relations: RelationStore
  records: RecordStore
}

/** Deterministic personal-domain operations over one SQLite database. */
export class PersonalService extends Service {
  /** Required service: the tool registry every personal tool registers on. */
  static inject = ['tools']

  /** Schemastery validation for the plugin config. */
  static Config: z<Config> = z.object({
    databasePath: z.string(),
    enableDailyReview: z.boolean().default(true),
    enableWeeklyReview: z.boolean().default(true),
    timezone: z.string(),
    searchTitleWeight: z.number(),
    searchTagWeight: z.number(),
    searchBodyWeight: z.number(),
  })

  private db: DatabaseSync | undefined
  private stores: StoreBundle | undefined
  private opening: Promise<StoreBundle> | undefined
  private disposed = false

  /** Resolved deployment settings; defaults were computed once at resolve. */
  private readonly settings: PersonalSettings

  /**
   * Validate config; storage opens in {@link PersonalService.init}.
   * @param ctx - the plugin fiber's context carrying `ctx.tools`.
   * @param config - loader-validated plugin config.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'personal')
    this.settings = resolvePersonalConfig(config)
  }

  /**
   * Open the database, run pending migrations, register the model-facing
   * tools, and arm the close disposer. A foreign database, a newer schema,
   * or an invalid zone fails the plugin load here.
   */
  protected async [Service.init](): Promise<void> {
    await this.ready()
    registerPersonalTools(this.ctx, this, this.settings)
    this.ctx.effect(() => () => { this.close() }, 'dsh-personal: close database')
  }

  /**
   * Open the database and run pending migrations; concurrent callers share
   * one open attempt. Every operation awaits this first.
   * @returns the initialized store bundle.
   * @throws after disposal — a closed service never reopens.
   */
  private ready(): Promise<StoreBundle> {
    if (this.disposed) {
      return Promise.reject(new Error('dsh-personal: service is disposed'))
    }
    if (this.stores !== undefined) return Promise.resolve(this.stores)
    // A failed open clears the shared attempt, so the next call retries with
    // a fresh error instead of replaying the cached rejection forever.
    this.opening ??= openPersonalDatabase(this.settings.databasePath)
      .then((db) => {
        this.db = db
        this.stores = {
          db,
          experiences: new ExperienceStore(db, this.settings.timeZone),
          projects: new ProjectStore(db),
          projectLogs: new ProjectLogStore(db, this.settings.timeZone),
          tasks: new TaskStore(db, this.settings.timeZone),
          blogPosts: new BlogPostStore(db),
          websites: new WebsiteStore(db),
          ideas: new IdeaStore(db),
          dailyLogs: new DailyLogStore(db, this.settings.timeZone),
          relations: new RelationStore(db),
          records: new RecordStore(db),
        }
        return this.stores
      })
      .catch((error: unknown) => {
        this.opening = undefined
        throw error
      })
    return this.opening
  }

  /** Today in the configured zone. */
  private today(): string {
    return todayIso(this.settings.timeZone)
  }

  /** Trimmed non-empty text, rejecting blank payloads at the service seam. */
  private required(value: string, label: string): string {
    const trimmed = value.trim()
    if (trimmed.length === 0) throw new Error(`dsh-personal: ${label} must not be blank`)
    return trimmed
  }

  /** Trimmed optional text, defaulting to empty. */
  private optional(value: string | undefined): string {
    return value === undefined ? '' : value.trim()
  }

  /** Trimmed optional tags; each tag must be non-empty. */
  private tagList(tags: string[] | undefined): string[] {
    if (tags === undefined) return []
    return tags.map(tag => this.required(tag, 'tag'))
  }

  /**
   * Record one completed experience.
   * @param input - capture payload; `occurredOn` defaults to today.
   * @returns the stored experience row.
   */
  async recordExperience(input: RecordExperienceInput): Promise<ExperienceRow> {
    const { experiences } = await this.ready()
    const id = mintId('exp') as ExperienceId
    const occurredOn = input.occurredOn === undefined ? this.today() : assertIsoDate(input.occurredOn, 'occurredOn')
    if (occurredOn > this.today()) {
      throw new Error('dsh-personal: occurredOn must not be in the future; planned items belong in create_task')
    }
    experiences.insert({
      id,
      category: this.required(input.category, 'experience category'),
      action: this.required(input.action, 'experience action'),
      title: this.required(input.title, 'experience title'),
      occurredOn,
      rating: input.rating === undefined ? null : normalizeRating(input.rating),
      note: this.optional(input.note),
      tags: this.tagList(input.tags),
      createdAt: nowIso(),
    })
    return requireRow(experiences.get(id), 'dsh-personal: experience insert lost')
  }

  /**
   * Create a project; names are unique.
   * @param input - creation payload.
   * @returns the stored project row.
   * @throws on a duplicate project name.
   */
  async createProject(input: CreateProjectInput): Promise<ProjectRow> {
    const bundle = await this.ready()
    return withTransaction(bundle.db, () => this.createProjectIn(bundle, input))
  }

  /**
   * Resolve a project by exact id, exact name, then case-insensitive name.
   * @param ref - project id or name from a caller.
   * @returns the project, or undefined when nothing matches.
   */
  async findProject(ref: string): Promise<ProjectRow | undefined> {
    const bundle = await this.ready()
    return this.findProjectIn(bundle, ref)
  }

  /**
   * Resolve a required project reference or throw.
   * @param ref - project id or name.
   * @returns the resolved project.
   * @throws when nothing matches.
   */
  async resolveProject(ref: string): Promise<ProjectRow> {
    const bundle = await this.ready()
    return this.resolveProjectIn(bundle, ref)
  }

  /** Synchronous lookup over an initialized bundle; no awaits inside transactions. */
  private findProjectIn(bundle: StoreBundle, ref: string): ProjectRow | undefined {
    const trimmed = ref.trim()
    if (trimmed.length === 0) return undefined
    const byId = bundle.projects.get(trimmed as ProjectId)
    if (byId !== undefined) return byId
    const byName = bundle.projects.getByName(trimmed)
    if (byName !== undefined) return byName
    return bundle.projects.list().find(project => project.name.toLowerCase() === trimmed.toLowerCase())
  }

  /** Synchronous required lookup; the caller surfaces the failure to the model. */
  private resolveProjectIn(bundle: StoreBundle, ref: string): ProjectRow {
    const project = this.findProjectIn(bundle, ref)
    if (project === undefined) throw new Error(`dsh-personal: unknown project ${JSON.stringify(ref.trim())}`)
    return project
  }

  /** Synchronous create with the duplicate-name check; caller owns the transaction. */
  private createProjectIn(bundle: StoreBundle, input: CreateProjectInput): ProjectRow {
    const name = this.required(input.name, 'project name')
    if (bundle.projects.getByName(name) !== undefined) {
      throw new Error(`dsh-personal: project ${JSON.stringify(name)} already exists`)
    }
    bundle.projects.insert({
      id: mintId('project'),
      name,
      description: this.optional(input.description),
      status: input.status ?? 'ACTIVE',
      createdAt: nowIso(),
    })
    return requireRow(bundle.projects.getByName(name), 'dsh-personal: project insert lost')
  }

  /**
   * Record one dated project log, creating the named project on demand. The
   * log references its project through a foreign key.
   * @param input - capture payload; `date` defaults to today.
   * @returns the stored log, its project, and whether this call created it.
   */
  async recordProjectLog(input: RecordProjectLogInput): Promise<{ project: ProjectRow; log: ProjectLogRow; projectCreated: boolean }> {
    const bundle = await this.ready()
    return withTransaction(bundle.db, () => {
      const existing = this.findProjectIn(bundle, input.project)
      const project = existing ?? this.createProjectIn(bundle, { name: input.project })
      const id = mintId('plog') as ProjectLogId
      bundle.projectLogs.insert({
        id,
        projectId: project.id,
        date: input.date === undefined ? this.today() : assertIsoDate(input.date, 'date'),
        title: this.required(input.title, 'log title'),
        content: this.optional(input.content),
        status: input.status ?? 'DONE',
        tags: this.tagList(input.tags),
        createdAt: nowIso(),
      })
      bundle.projects.touch(project.id)
      return {
        project,
        log: requireRow(bundle.projectLogs.get(id), 'dsh-personal: project log insert lost'),
        projectCreated: existing === undefined,
      }
    })
  }

  /**
   * Create one task. Explicit `dueAt` wins over `dueIn`; project and website
   * references resolve by id, exact name, domain, or case-insensitive name.
   * Links live in the task's foreign-key columns, not in the relations table.
   * @param input - creation payload.
   * @returns the stored task row.
   */
  async createTask(input: CreateTaskInput): Promise<TaskRow> {
    const bundle = await this.ready()
    const project = input.project !== undefined ? this.resolveProjectIn(bundle, input.project) : undefined
    const website = input.website !== undefined ? this.resolveWebsiteIn(bundle, input.website) : undefined
    const id = mintId('task') as TaskId
    const sourceType = this.optional(input.sourceType)
    const sourceId = this.optional(input.sourceId)
    bundle.tasks.insert({
      id,
      title: this.required(input.title, 'task title'),
      status: 'TODO',
      priority: input.priority ?? 'MEDIUM',
      dueAt: input.dueAt !== undefined
        ? assertIsoDate(input.dueAt, 'dueAt')
        : input.dueIn !== undefined ? resolveDueDate(input.dueIn, this.settings.timeZone) : null,
      projectId: project?.id ?? null,
      websiteId: website?.id ?? null,
      sourceType: sourceType.length > 0 ? sourceType : null,
      sourceId: sourceId.length > 0 ? sourceId : null,
      createdAt: nowIso(),
    })
    return requireRow(bundle.tasks.get(id), 'dsh-personal: task insert lost')
  }

  /**
   * Update mutable task fields; entering `DONE` stamps the completion date
   * and any other status clears it.
   * @param id - task id.
   * @param patch - mutable fields; `dueAt` overrides `dueIn` when both are present.
   * @param revision - content token from getRecord; stale tokens reject.
   * @returns the updated task row.
   * @throws when the id is unknown.
   */
  async updateTask(id: TaskId, patch: UpdateTaskInput, revision: RecordRevision): Promise<TaskRow> {
    const result = await this.updateRecord('task', id, revision, patch as JsonValue)
    return result.row as unknown as TaskRow
  }

  /**
   * Mark one task done.
   * @param id - task id.
   * @param revision - content token from getRecord; stale tokens reject.
   * @returns the updated task row.
   * @throws when the id is unknown.
   */
  async completeTask(id: TaskId, revision: RecordRevision): Promise<TaskRow> {
    return this.updateTask(id, { status: 'DONE' }, revision)
  }

  /**
   * Create one blog post; a related-project reference resolves by name or id.
   * @param input - creation payload.
   * @returns the stored blog-post row.
   */
  async createBlogPost(input: CreateBlogPostInput): Promise<BlogPostRow> {
    const bundle = await this.ready()
    const project = input.relatedProject !== undefined
      ? this.resolveProjectIn(bundle, input.relatedProject)
      : undefined
    const id = mintId('blog') as BlogPostId
    bundle.blogPosts.insert({
      id,
      title: this.required(input.title, 'blog title'),
      status: input.status ?? 'IDEA',
      summary: this.optional(input.summary),
      content: this.optional(input.content),
      tags: this.tagList(input.tags),
      relatedProjectId: project?.id ?? null,
      createdAt: nowIso(),
    })
    return requireRow(bundle.blogPosts.get(id), 'dsh-personal: blog post insert lost')
  }

  /**
   * Update mutable blog-post fields.
   * @param id - post id.
   * @param patch - mutable fields.
   * @param revision - content token from getRecord; stale tokens reject.
   * @returns the updated row.
   * @throws when the id is unknown.
   */
  async updateBlogPost(id: BlogPostId, patch: UpdateBlogPostInput, revision: RecordRevision): Promise<BlogPostRow> {
    const result = await this.updateRecord('blog_post', id, revision, patch as JsonValue)
    return result.row as unknown as BlogPostRow
  }

  /**
   * Create one idea; a related-project reference resolves by name or id.
   * @param input - creation payload.
   * @returns the stored idea row.
   */
  async createIdea(input: CreateIdeaInput): Promise<IdeaRow> {
    const bundle = await this.ready()
    const project = input.relatedProject !== undefined
      ? this.resolveProjectIn(bundle, input.relatedProject)
      : undefined
    const id = mintId('idea') as IdeaId
    bundle.ideas.insert({
      id,
      title: this.required(input.title, 'idea title'),
      content: this.optional(input.content),
      category: this.optional(input.category),
      relatedProjectId: project?.id ?? null,
      createdAt: nowIso(),
    })
    return requireRow(bundle.ideas.get(id), 'dsh-personal: idea insert lost')
  }

  /**
   * Record one daily log entry.
   * @param input - capture payload; `date` defaults to today.
   * @returns the stored daily-log row.
   */
  async recordDailyLog(input: RecordDailyLogInput): Promise<DailyLogRow> {
    const { dailyLogs } = await this.ready()
    const id = mintId('day') as DailyLogId
    dailyLogs.insert({
      id,
      date: input.date === undefined ? this.today() : assertIsoDate(input.date, 'date'),
      summary: this.required(input.summary, 'daily summary'),
      rawText: this.optional(input.rawText),
      createdAt: nowIso(),
    })
    return requireRow(dailyLogs.get(id), 'dsh-personal: daily log insert lost')
  }

  /**
   * Register one website; domains are unique.
   * @param input - registration payload.
   * @returns the stored website row.
   * @throws on a duplicate domain.
   */
  async registerWebsite(input: RegisterWebsiteInput): Promise<WebsiteRow> {
    const { websites } = await this.ready()
    const domain = this.required(input.domain, 'website domain')
    if (websites.getByDomain(domain) !== undefined) {
      throw new Error(`dsh-personal: website domain ${JSON.stringify(domain)} already exists`)
    }
    websites.insert({
      id: mintId('site'),
      name: this.required(input.name, 'website name'),
      domain,
      repo: this.optional(input.repo),
      hosting: this.optional(input.hosting),
      description: this.optional(input.description),
      tags: this.tagList(input.tags),
      createdAt: nowIso(),
    })
    return requireRow(websites.getByDomain(domain), 'dsh-personal: website insert lost')
  }

  /**
   * Resolve a website by exact id, exact domain, exact name, then
   * case-insensitive name or domain.
   * @param ref - website id, domain, or name.
   * @returns the website, or undefined when nothing matches.
   */
  async findWebsite(ref: string): Promise<WebsiteRow | undefined> {
    const bundle = await this.ready()
    return this.findWebsiteIn(bundle, ref)
  }

  /**
   * Resolve a required website reference or throw.
   * @param ref - website id, domain, or name.
   * @returns the resolved website.
   * @throws when nothing matches.
   */
  async resolveWebsite(ref: string): Promise<WebsiteRow> {
    const bundle = await this.ready()
    return this.resolveWebsiteIn(bundle, ref)
  }

  /** Synchronous lookup over an initialized bundle; no awaits inside transactions. */
  private findWebsiteIn(bundle: StoreBundle, ref: string): WebsiteRow | undefined {
    const trimmed = ref.trim()
    if (trimmed.length === 0) return undefined
    const byId = bundle.websites.get(trimmed as WebsiteId)
    if (byId !== undefined) return byId
    const byDomain = bundle.websites.getByDomain(trimmed)
    if (byDomain !== undefined) return byDomain
    const lower = trimmed.toLowerCase()
    return bundle.websites.list({ limit: 200 }).find(website =>
      website.name.toLowerCase() === lower || website.domain.toLowerCase() === lower)
  }

  /** Synchronous required lookup; the caller surfaces the failure to the model. */
  private resolveWebsiteIn(bundle: StoreBundle, ref: string): WebsiteRow {
    const website = this.findWebsiteIn(bundle, ref)
    if (website === undefined) throw new Error(`dsh-personal: unknown website ${JSON.stringify(ref.trim())}`)
    return website
  }

  /**
   * Link two personal objects; re-linking an existing pair is idempotent.
   * @param from - source type and id.
   * @param relationType - relation label.
   * @param to - target type and id.
   * @returns the stored relation row.
   */
  async linkObjects(
    from: { type: PersonalObjectType; id: string },
    relationType: string,
    to: { type: PersonalObjectType; id: string },
  ): Promise<RelationRow> {
    const { relations } = await this.ready()
    return relations.link(from, this.required(relationType, 'relation type'), to)
  }

  /**
 * Query experiences by canonical category, action, date, text, and tag.
 * @param filter - query filter.
 * @returns the matching rows.
 */
  async queryExperiences(filter: ExperienceFilter): Promise<ExperienceRow[]> {
    return (await this.ready()).experiences.list({
      ...filter,
      weights: this.settings.searchWeights,
      ...(filter.category === undefined ? {} : { category: this.required(filter.category, 'experience category') }),
      ...(filter.action === undefined ? {} : { action: this.required(filter.action, 'experience action') }),
      ...(filter.text === undefined ? {} : { text: this.required(filter.text, 'experience text') }),
    })
  }

  /**
 * Query tasks by status, priority, due selection, and links.
 * @param filter - query filter.
 * @returns the matching rows.
 */
  async queryTasks(filter: TaskFilter): Promise<TaskRow[]> {
    return (await this.ready()).tasks.list(filter)
  }

  /**
   * Query project logs by resolved project, date window, and tag.
   * @param filter - query filter; `project` resolves by id or name.
   * @returns the matching rows.
   */
  async queryProjectLogs(
    filter: ProjectLogFilter & { projectId?: ProjectId },
  ): Promise<ProjectLogRow[]> {
    const bundle = await this.ready()
    const { project, projectId, ...rest } = filter
    const resolvedProjectId = project !== undefined
      ? this.resolveProjectIn(bundle, project).id
      : projectId
    return bundle.projectLogs.list({
      ...rest,
      ...(resolvedProjectId !== undefined ? { projectId: resolvedProjectId } : {}),
    })
  }

  /**
 * Query blog posts by status and tag.
 * @param filter - query filter.
 * @returns the matching rows.
 */
  async queryBlogPosts(filter: BlogPostFilter): Promise<BlogPostRow[]> {
    return (await this.ready()).blogPosts.list(filter)
  }

  /**
 * Query websites by tag.
 * @param filter - query filter.
 * @returns the matching rows.
 */
  async queryWebsites(filter: WebsiteFilter): Promise<WebsiteRow[]> {
    return (await this.ready()).websites.list(filter)
  }

  /**
 * Query ideas by category.
 * @param filter - query filter.
 * @returns the matching rows.
 */
  async queryIdeas(filter: IdeaFilter): Promise<IdeaRow[]> {
    return (await this.ready()).ideas.list(filter)
  }

  /**
 * Query daily logs by date window.
 * @param filter - query filter.
 * @returns the matching rows.
 */
  async queryDailyLogs(filter: DailyLogFilter): Promise<DailyLogRow[]> {
    return (await this.ready()).dailyLogs.list(filter)
  }

  /**
   * Search segmented keywords across selected types within a date window.
   * Every result comes from SQLite and shares one BM25 relevance order.
   * @param input - keywords, match mode, type subset, window, and global limit.
   * @returns query terms and ranked domain rows.
   */
  async searchPersonal(input: SearchPersonalInput): Promise<SearchPersonalResult> {
    const bundle = await this.ready()
    const win = resolveWindow(input, this.settings.timeZone)
    const text = this.required(input.text, 'search text')
    return personalSearchIndex(bundle.db).search({
      text, ...win, types: input.types, match: input.match,
      limit: input.limit, weights: this.settings.searchWeights,
    })
  }

  /**
   * Read one record by exact id, including the token required to edit it.
   * @param type - record kind.
   * @param id - exact id from a capture or query result.
   * @returns complete durable row and revision.
   * @throws when the id is unknown for this kind.
   */
  async getRecord(type: PersonalObjectType, id: PersonalRecordId): Promise<RecordSnapshot> {
    const { records } = await this.ready()
    const record = records.get(type, id)
    if (record === undefined) throw new Error(`dsh-personal: unknown ${type} id ${JSON.stringify(id)}`)
    return record
  }

  /**
   * Update only supplied fields after checking the caller's snapshot revision.
   * Task completion dates and record timestamps are managed by the service.
   * @param type - record kind.
   * @param id - exact record id.
   * @param revision - token from getRecord.
   * @param patch - untrusted camelCase partial fields; null clears nullable fields.
   * @returns complete updated row and its new revision.
   * @throws for stale revisions, invalid patches, references, or uniqueness conflicts.
   */
  async updateRecord(type: PersonalObjectType, id: PersonalRecordId, revision: RecordRevision, patch: JsonValue): Promise<RecordSnapshot> {
    const bundle = await this.ready()
    return withTransaction(bundle.db, () => {
      const before = bundle.records.requireCurrent(type, id, revision)
      const today = this.today()
      const pairs = parseRecordPatch(type, patch, today,
        (kind, ref) => bundle.records.get(kind, ref as PersonalRecordId) !== undefined)
      const status = pairs.find(([column]) => column === 'status')?.[1]
      if (type === 'task' && status !== undefined) {
        pairs.push(['done_at', status === 'DONE' ? before.row.status === 'DONE' ? before.row.doneAt as string : today : null])
      }
      if (type === 'task' && pairs.some(([column]) => column === 'source_type' || column === 'source_id')) {
        const value = (column: string, field: string): JsonValue | undefined => {
          const pair = pairs.find(([key]) => key === column)
          return pair === undefined ? before.row[field] : pair[1] as JsonValue
        }
        if ((value('source_type', 'sourceType') === null) !== (value('source_id', 'sourceId') === null)) {
          throw new Error('dsh-personal: sourceType and sourceId must both be set or both be null')
        }
      }
      if (['project', 'task', 'blog_post', 'website'].includes(type)) pairs.push(['updated_at', nowIso()])
      bundle.records.update(type, id, pairs)
      if (type === 'project_log') {
        bundle.projects.touch(before.row.projectId as ProjectId)
        const nextProject = pairs.find(([column]) => column === 'project_id')?.[1]
        if (typeof nextProject === 'string' && nextProject !== before.row.projectId) bundle.projects.touch(nextProject as ProjectId)
      }
      return requireRow(bundle.records.get(type, id), 'dsh-personal: record update lost')
    })
  }

  /**
   * Delete an exact snapshot and its explicit relation links. Durable incoming
   * references block deletion; no dependent records are cascaded.
   * @param type - record kind.
   * @param id - exact record id.
   * @param revision - token from getRecord.
   * @returns the deleted snapshot and count of removed relation links.
   * @throws for missing ids, stale revisions, or referring records.
   */
  async deleteRecord(type: PersonalObjectType, id: PersonalRecordId, revision: RecordRevision): Promise<{ deleted: RecordSnapshot; removedRelations: number }> {
    const bundle = await this.ready()
    return withTransaction(bundle.db, () => {
      const deleted = bundle.records.requireCurrent(type, id, revision)
      const removedRelations = bundle.records.delete(type, id)
      if (type === 'project_log') bundle.projects.touch(deleted.row.projectId as ProjectId)
      return { deleted, removedRelations }
    })
  }

  /**
   * Assemble one day's deterministic review facts.
   * @param date - reviewed date; defaults to today.
   * @returns the fact bundle.
   */
  async generateDailyReview(date?: string): Promise<DailyReview> {
    const stores = await this.ready()
    return buildDailyReview(stores, date === undefined ? this.today() : assertIsoDate(date, 'date'))
  }

  /**
   * Assemble one week's deterministic review facts (Monday through Sunday).
   * @param anchor - any date inside the reviewed week; defaults to today.
   * @returns the fact bundle.
   */
  async generateWeeklyReview(anchor?: string): Promise<WeeklyReview> {
    const stores = await this.ready()
    return buildWeeklyReview(stores, anchor === undefined ? this.today() : assertIsoDate(anchor, 'date'))
  }

  /**
   * Resolve a review date from an explicit date or a day offset.
   * @param date - explicit `YYYY-MM-DD`.
   * @param daysAgo - non-negative whole days before today.
   * @returns the resolved ISO date.
   */
  resolveReviewDate(date: string | undefined, daysAgo: number | undefined): string {
    if (date !== undefined) return assertIsoDate(date, 'date')
    if (daysAgo !== undefined) return addDays(this.today(), -assertDayOffset(daysAgo, 'daysAgo'))
    return this.today()
  }

  /**
   * Close the database handle and mark the service disposed: the plugin fiber
   * owns one service lifetime, and a disposed service never reopens. A plugin
   * reload builds a fresh instance.
   */
  close(): void {
    this.disposed = true
    this.db?.close()
    this.db = undefined
    this.stores = undefined
    this.opening = undefined
  }
}

/** Rating bounds enforced ahead of the SQL CHECK; any finite decimal stores. */
function normalizeRating(rating: number): number {
  if (!Number.isFinite(rating) || rating < 0 || rating > 10) {
    throw new Error(`dsh-personal: rating must be a number 0-10, got ${String(rating)}`)
  }
  return rating
}

export default PersonalService

/** Unwrap a just-written row; a lost insert is a storage fault, not a domain case. */
function requireRow<T>(row: T | undefined, message: string): T {
  /* v8 ignore next -- the read follows the insert of the same minted id in the
     same connection; only a storage fault loses the row, which is not a
     testable domain case. */
  if (row === undefined) throw new Error(message)
  return row
}
