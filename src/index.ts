/**
 * `@deepseek-ai/dsh-personal`: the personal assistant plugin. It owns one
 * SQLite database of structured personal data (movies, projects, project
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

import { Service, type Context } from '@deepseek-ai/cordis'
import type { DatabaseSync } from 'node:sqlite'
import z from '@deepseek-ai/schemastery'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolvePersonalConfig, type Config, type PersonalSettings } from './config.ts'
import { addDays, assertDayOffset, assertIsoDate, resolveDueDate, resolveWindow, todayIso } from './dates.ts'
import { buildDailyReview, buildWeeklyReview, type ReviewStores } from './review.ts'
import { BlogPostStore } from './store/blogs.ts'
import { mintId } from './store/ids.ts'
import { DailyLogStore, IdeaStore } from './store/ideas.ts'
import { MovieStore } from './store/movies.ts'
import { openPersonalDatabase } from './store/open.ts'
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
  IdeaFilter,
  IdeaId,
  IdeaRow,
  MovieFilter,
  MovieId,
  MovieRow,
  PersonalObjectType,
  ProjectId,
  ProjectLogFilter,
  ProjectLogId,
  ProjectLogRow,
  ProjectRow,
  RecordDailyLogInput,
  RecordMovieInput,
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
  relations: RelationStore
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
    this.opening ??= openPersonalDatabase(this.settings.databasePath).then((db) => {
      this.db = db
      this.stores = {
        movies: new MovieStore(db, this.settings.timeZone),
        projects: new ProjectStore(db),
        projectLogs: new ProjectLogStore(db, this.settings.timeZone),
        tasks: new TaskStore(db, this.settings.timeZone),
        blogPosts: new BlogPostStore(db),
        websites: new WebsiteStore(db),
        ideas: new IdeaStore(db),
        dailyLogs: new DailyLogStore(db, this.settings.timeZone),
        relations: new RelationStore(db),
      }
      return this.stores
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
   * Record one watched movie.
   * @param input - capture payload; `watchedAt` defaults to today.
   * @returns the stored movie row.
   */
  async recordMovie(input: RecordMovieInput): Promise<MovieRow> {
    const { movies } = await this.ready()
    const id = mintId('movie') as MovieId
    movies.insert({
      id,
      title: this.required(input.title, 'movie title'),
      watchedAt: input.watchedAt === undefined ? this.today() : assertIsoDate(input.watchedAt, 'watchedAt'),
      rating: input.rating === undefined ? null : normalizeRating(input.rating),
      note: this.optional(input.note),
      tags: this.tagList(input.tags),
      createdAt: nowStamp(),
    })
    return requireRow(movies.get(id), 'dsh-personal: movie insert lost')
  }

  /**
   * Create a project; names are unique.
   * @param input - creation payload.
   * @returns the stored project row.
   * @throws on a duplicate project name.
   */
  async createProject(input: CreateProjectInput): Promise<ProjectRow> {
    const { projects } = await this.ready()
    const name = this.required(input.name, 'project name')
    if (projects.getByName(name) !== undefined) {
      throw new Error(`dsh-personal: project ${JSON.stringify(name)} already exists`)
    }
    projects.insert({
      id: mintId('project'),
      name,
      description: this.optional(input.description),
      status: input.status ?? 'ACTIVE',
      createdAt: nowStamp(),
    })
    return requireRow(projects.getByName(name), 'dsh-personal: project insert lost')
  }

  /**
   * Resolve a project by exact id, exact name, then case-insensitive name.
   * @param ref - project id or name from a caller.
   * @returns the project, or undefined when nothing matches.
   */
  async findProject(ref: string): Promise<ProjectRow | undefined> {
    const { projects } = await this.ready()
    const trimmed = ref.trim()
    if (trimmed.length === 0) return undefined
    const byId = projects.get(trimmed as ProjectId)
    if (byId !== undefined) return byId
    const byName = projects.getByName(trimmed)
    if (byName !== undefined) return byName
    return projects.list().find(project => project.name.toLowerCase() === trimmed.toLowerCase())
  }

  /** Resolve a required project reference or throw. */
  private async resolveProjectRef(ref: string): Promise<ProjectRow> {
    const project = await this.findProject(ref)
    if (project === undefined) throw new Error(`dsh-personal: unknown project ${JSON.stringify(ref.trim())}`)
    return project
  }

  /**
   * Record one dated project log, creating the named project on demand. The
   * log links its project through both the foreign key and a `belongs-to`
   * relation.
   * @param input - capture payload; `date` defaults to today.
   * @returns the project (created or existing) and the stored log row.
   */
  async recordProjectLog(input: RecordProjectLogInput): Promise<{ project: ProjectRow; log: ProjectLogRow }> {
    const bundle = await this.ready()
    const project = await this.findProject(input.project)
      ?? await this.createProject({ name: input.project })
    const id = mintId('plog') as ProjectLogId
    bundle.projectLogs.insert({
      id,
      projectId: project.id,
      date: input.date === undefined ? this.today() : assertIsoDate(input.date, 'date'),
      title: this.required(input.title, 'log title'),
      content: this.optional(input.content),
      status: input.status ?? 'DONE',
      tags: this.tagList(input.tags),
      createdAt: nowStamp(),
    })
    bundle.projects.touch(project.id)
    bundle.relations.link({ type: 'project_log', id }, 'belongs-to', { type: 'project', id: project.id })
    return { project, log: requireRow(bundle.projectLogs.get(id), 'dsh-personal: project log insert lost') }
  }

  /**
   * Create one task. Explicit `dueAt` wins over `dueIn`; project and website
   * references resolve by id, exact name, domain, or case-insensitive name,
   * and each resolved link is also recorded as a relation.
   * @param input - creation payload.
   * @returns the stored task row.
   */
  async createTask(input: CreateTaskInput): Promise<TaskRow> {
    const bundle = await this.ready()
    const project = input.project !== undefined ? await this.resolveProjectRef(input.project) : undefined
    const website = input.website !== undefined ? await this.resolveWebsiteRef(input.website) : undefined
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
      createdAt: nowStamp(),
    })
    if (project !== undefined) {
      bundle.relations.link({ type: 'task', id }, 'belongs-to', { type: 'project', id: project.id })
    }
    if (website !== undefined) {
      bundle.relations.link({ type: 'task', id }, 'maintains', { type: 'website', id: website.id })
    }
    return requireRow(bundle.tasks.get(id), 'dsh-personal: task insert lost')
  }

  /**
   * Update mutable task fields; entering `DONE` stamps the completion date
   * and any other status clears it.
   * @param id - task id.
   * @param patch - mutable fields; `dueAt` overrides `dueIn` when both are present.
   * @returns the updated task row.
   * @throws when the id is unknown.
   */
  async updateTask(id: TaskId, patch: UpdateTaskInput): Promise<TaskRow> {
    const { tasks } = await this.ready()
    if (tasks.get(id) === undefined) throw new Error(`dsh-personal: unknown task ${JSON.stringify(id)}`)
    const dueAt = patch.dueAt !== undefined
      ? assertIsoDate(patch.dueAt, 'dueAt')
      : patch.dueIn !== undefined ? resolveDueDate(patch.dueIn, this.settings.timeZone) : undefined
    const updated = tasks.update(id, {
      ...(patch.title !== undefined ? { title: this.required(patch.title, 'task title') } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
    })
    return requireRow(updated, 'dsh-personal: task update lost')
  }

  /**
   * Mark one task done.
   * @param id - task id.
   * @returns the updated task row.
   * @throws when the id is unknown.
   */
  async completeTask(id: TaskId): Promise<TaskRow> {
    return this.updateTask(id, { status: 'DONE' })
  }

  /**
   * Create one blog post; a related-project reference resolves by name or id.
   * @param input - creation payload.
   * @returns the stored blog-post row.
   */
  async createBlogPost(input: CreateBlogPostInput): Promise<BlogPostRow> {
    const bundle = await this.ready()
    const project = input.relatedProject !== undefined
      ? await this.resolveProjectRef(input.relatedProject)
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
      createdAt: nowStamp(),
    })
    if (project !== undefined) {
      bundle.relations.link({ type: 'blog_post', id }, 'belongs-to', { type: 'project', id: project.id })
    }
    return requireRow(bundle.blogPosts.get(id), 'dsh-personal: blog post insert lost')
  }

  /**
   * Update mutable blog-post fields.
   * @param id - post id.
   * @param patch - mutable fields.
   * @returns the updated row.
   * @throws when the id is unknown.
   */
  async updateBlogPost(id: BlogPostId, patch: UpdateBlogPostInput): Promise<BlogPostRow> {
    const { blogPosts } = await this.ready()
    if (blogPosts.get(id) === undefined) throw new Error(`dsh-personal: unknown blog post ${JSON.stringify(id)}`)
    const updated = blogPosts.update(id, {
      ...(patch.title !== undefined ? { title: this.required(patch.title, 'blog title') } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.summary !== undefined ? { summary: this.optional(patch.summary) } : {}),
      ...(patch.content !== undefined ? { content: this.optional(patch.content) } : {}),
      ...(patch.tags !== undefined ? { tags: this.tagList(patch.tags) } : {}),
    })
    return requireRow(updated, 'dsh-personal: blog post update lost')
  }

  /**
   * Create one idea; a related-project reference resolves by name or id.
   * @param input - creation payload.
   * @returns the stored idea row.
   */
  async createIdea(input: CreateIdeaInput): Promise<IdeaRow> {
    const bundle = await this.ready()
    const project = input.relatedProject !== undefined
      ? await this.resolveProjectRef(input.relatedProject)
      : undefined
    const id = mintId('idea') as IdeaId
    bundle.ideas.insert({
      id,
      title: this.required(input.title, 'idea title'),
      content: this.optional(input.content),
      category: this.optional(input.category),
      relatedProjectId: project?.id ?? null,
      createdAt: nowStamp(),
    })
    if (project !== undefined) {
      bundle.relations.link({ type: 'idea', id }, 'belongs-to', { type: 'project', id: project.id })
    }
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
      createdAt: nowStamp(),
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
      createdAt: nowStamp(),
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
    const { websites } = await this.ready()
    const trimmed = ref.trim()
    if (trimmed.length === 0) return undefined
    const byId = websites.get(trimmed as WebsiteId)
    if (byId !== undefined) return byId
    const byDomain = websites.getByDomain(trimmed)
    if (byDomain !== undefined) return byDomain
    const lower = trimmed.toLowerCase()
    return websites.list({ limit: 200 }).find(website =>
      website.name.toLowerCase() === lower || website.domain.toLowerCase() === lower)
  }

  /** Resolve a required website reference or throw. */
  private async resolveWebsiteRef(ref: string): Promise<WebsiteRow> {
    const website = await this.findWebsite(ref)
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
 * Query movies by watch-date window and tag.
 * @param filter - query filter.
 * @returns the matching rows.
 */
  async queryMovies(filter: MovieFilter): Promise<MovieRow[]> {
    return (await this.ready()).movies.list(filter)
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
    const { project, projectId, ...rest } = filter
    const resolvedProjectId = project !== undefined
      ? (await this.resolveProjectRef(project)).id
      : projectId
    return (await this.ready()).projectLogs.list({
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
   * Substring-search every object type (or a selected subset) inside a date
   * window; every fact is read from SQLite.
   * @param input - search text, optional type subset, and window.
   * @returns matches grouped by type; empty groups are omitted.
   */
  async searchPersonal(input: SearchPersonalInput): Promise<SearchPersonalResult> {
    const bundle = await this.ready()
    const win = resolveWindow(input, this.settings.timeZone)
    const text = this.required(input.text, 'search text')
    const limit = normalizeSearchLimit(input.limit)
    const wanted = (type: PersonalObjectType): boolean => input.types === undefined || input.types.includes(type)
    const result: SearchPersonalResult = {}
    const include = (type: PersonalObjectType, rows: unknown[]): void => {
      // Row fields are string | number | null | string[], so the projection
      // is JSON-safe by construction.
      if (wanted(type) && rows.length > 0) result[type] = rows as JsonValue[]
    }
    include('movie', bundle.movies.searchText(text, win, limit))
    include('project', bundle.projects.searchText(text, limit))
    include('project_log', bundle.projectLogs.searchText(text, win, limit))
    include('task', bundle.tasks.searchText(text, win, limit))
    include('blog_post', bundle.blogPosts.searchText(text, win, limit))
    include('website', bundle.websites.searchText(text, limit))
    include('idea', bundle.ideas.searchText(text, win, limit))
    include('daily_log', bundle.dailyLogs.searchText(text, win, limit))
    return result
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

/** Current durable timestamp. */
function nowStamp(): string {
  return new Date().toISOString()
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

/** Search row cap shared across types. */
function normalizeSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return 20
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error(`dsh-personal: limit must be an integer 1-200, got ${String(limit)}`)
  }
  return limit
}
