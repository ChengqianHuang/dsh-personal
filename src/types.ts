/**
 * Personal domain vocabulary: object types, branded ids, durable row shapes,
 * service input and filter types, and review results. Types only — runtime
 * schema logic lives in the store and tools modules.
 * @module @deepseek-ai/dsh-personal/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** A durable experience record id. */
export type ExperienceId = Branded<'PersonalExperienceId'>

/** A durable project record id. */
export type ProjectId = Branded<'PersonalProjectId'>

/** A durable project-log record id. */
export type ProjectLogId = Branded<'PersonalProjectLogId'>

/** A durable task record id. */
export type TaskId = Branded<'PersonalTaskId'>

/** A durable blog-post record id. */
export type BlogPostId = Branded<'PersonalBlogPostId'>

/** A durable website record id. */
export type WebsiteId = Branded<'PersonalWebsiteId'>

/** A durable idea record id. */
export type IdeaId = Branded<'PersonalIdeaId'>

/** A durable daily-log record id. */
export type DailyLogId = Branded<'PersonalDailyLogId'>

/** A durable cross-object relation id. */
export type RelationId = Branded<'PersonalRelationId'>

/** The personal object kinds a relation or search can address. */
export type PersonalObjectType =
  | 'experience'
  | 'project'
  | 'project_log'
  | 'task'
  | 'blog_post'
  | 'website'
  | 'idea'
  | 'daily_log'

/** Lifecycle of a tracked project. */
export type ProjectStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED'

/** Outcome recorded on one project-log entry. */
export type ProjectLogStatus = 'DONE' | 'WIP' | 'BLOCKED'

/** Task workflow states. */
export type TaskStatus = 'TODO' | 'DOING' | 'DONE' | 'CANCELLED'

/** Task urgency ordering. */
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH'

/** Blog-post writing pipeline states. */
export type BlogPostStatus = 'IDEA' | 'OUTLINE' | 'DRAFT' | 'REVIEW' | 'PUBLISHED'

/** One experience the user had: watched a movie, read a book, visited an exhibition. */
export interface ExperienceRow {
  id: ExperienceId
  /** Open object category, stored lowercase: movie, book, album, exhibition, ... */
  category: string
  /** What was done, stored lowercase: watched, read, listened, visited, ... */
  action: string
  /** Name of the experienced thing, e.g. the movie or book title. */
  title: string
  /** Experience date, `YYYY-MM-DD` in the configured zone; never in the future. */
  occurredOn: string
  /** User rating 0-10, or null when unrated. */
  rating: number | null
  note: string
  tags: string[]
  createdAt: string
}

/** A tracked project. */
export interface ProjectRow {
  id: ProjectId
  name: string
  description: string
  status: ProjectStatus
  createdAt: string
  updatedAt: string
}

/** One dated progress entry belonging to a project. */
export interface ProjectLogRow {
  id: ProjectLogId
  projectId: ProjectId
  /** Log date, `YYYY-MM-DD` in the configured zone. */
  date: string
  title: string
  content: string
  status: ProjectLogStatus
  tags: string[]
  createdAt: string
}

/** One task, optionally linked to a project, a website, or a source record. */
export interface TaskRow {
  id: TaskId
  title: string
  status: TaskStatus
  priority: TaskPriority
  /** Due date `YYYY-MM-DD`, or null when undated. */
  dueAt: string | null
  projectId: ProjectId | null
  websiteId: WebsiteId | null
  /** Free-form label of the record this task originated from, or null. */
  sourceType: string | null
  sourceId: string | null
  /** Completion date `YYYY-MM-DD`, set when the task enters `DONE`. */
  doneAt: string | null
  createdAt: string
  updatedAt: string
}

/** One blog post moving through the writing pipeline. */
export interface BlogPostRow {
  id: BlogPostId
  title: string
  status: BlogPostStatus
  summary: string
  content: string
  tags: string[]
  relatedProjectId: ProjectId | null
  createdAt: string
  updatedAt: string
}

/** One personal website and where it lives. */
export interface WebsiteRow {
  id: WebsiteId
  name: string
  domain: string
  repo: string
  hosting: string
  description: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

/** One captured idea, optionally tied to a project. */
export interface IdeaRow {
  id: IdeaId
  title: string
  content: string
  category: string
  relatedProjectId: ProjectId | null
  createdAt: string
}

/** One daily log entry: a summary of the day plus optional raw text. */
export interface DailyLogRow {
  id: DailyLogId
  /** Log date, `YYYY-MM-DD` in the configured zone. */
  date: string
  summary: string
  rawText: string
  createdAt: string
}

/** One directed link between two personal objects. */
export interface RelationRow {
  id: RelationId
  fromType: PersonalObjectType
  fromId: string
  /** Free-form relation label, e.g. `relates-to`. */
  relationType: string
  toType: PersonalObjectType
  toId: string
  createdAt: string
}

/** Input for {@link PersonalService.recordExperience}. */
export interface RecordExperienceInput {
  /** Open object category, lowercase singular: movie, book, album, exhibition, ... */
  category: string
  /** What was done, lowercase singular: watched, read, listened, visited, ... */
  action: string
  /** Name of the experienced thing. */
  title: string
  /** Experience date `YYYY-MM-DD`; omitted means today in the configured zone. */
  occurredOn?: string
  rating?: number
  note?: string
  tags?: string[]
}

/** Input for the project-log capture path: the project may be created on demand. */
export interface RecordProjectLogInput {
  /** Existing project name, or the name of a project to create on the fly. */
  project: string
  title: string
  content?: string
  /** Log date `YYYY-MM-DD`; omitted means today in the configured zone. */
  date?: string
  status?: ProjectLogStatus
  tags?: string[]
}

/** Input for {@link PersonalService.createProject}. */
export interface CreateProjectInput {
  name: string
  description?: string
  status?: ProjectStatus
}

/** Input for {@link PersonalService.createTask}. */
export interface CreateTaskInput {
  title: string
  priority?: TaskPriority
  /** Due date `YYYY-MM-DD`, overriding `dueIn` when both are given. */
  dueAt?: string
  /** Relative due bucket resolved against today in the configured zone. */
  dueIn?: DueIn
  /** Owning project by name or id; resolved and linked on insert. */
  project?: string
  /** Related website by name, domain, or id; resolved and linked on insert. */
  website?: string
  sourceType?: string
  sourceId?: string
}

/** Relative due buckets a tool caller can use without knowing the calendar. */
export type DueIn =
  | 'today'
  | 'tomorrow'
  | 'this-week'
  | 'next-week'
  | 'this-weekend'
  | 'next-weekend'
  | 'this-month'
  | 'next-month'

/** Mutable task fields; `undefined` leaves a field unchanged. */
export interface UpdateTaskInput {
  title?: string
  status?: TaskStatus
  priority?: TaskPriority
  /** Due date `YYYY-MM-DD`. */
  dueAt?: string
  /** Relative due bucket; ignored when `dueAt` is present. */
  dueIn?: DueIn
}

/** Input for {@link PersonalService.createBlogPost}. */
export interface CreateBlogPostInput {
  title: string
  status?: BlogPostStatus
  summary?: string
  content?: string
  tags?: string[]
  /** Related project by name or id; resolved to a project id. */
  relatedProject?: string
}

/** Mutable blog-post fields; `undefined` leaves a field unchanged. */
export interface UpdateBlogPostInput {
  title?: string
  status?: BlogPostStatus
  summary?: string
  content?: string
  tags?: string[]
}

/** Input for {@link PersonalService.createIdea}. */
export interface CreateIdeaInput {
  title: string
  content?: string
  category?: string
  /** Related project by name or id; resolved to a project id. */
  relatedProject?: string
}

/** Input for {@link PersonalService.recordDailyLog}. */
export interface RecordDailyLogInput {
  summary: string
  rawText?: string
  /** Log date `YYYY-MM-DD`; omitted means today in the configured zone. */
  date?: string
}

/** Input for {@link PersonalService.registerWebsite}. */
export interface RegisterWebsiteInput {
  name: string
  domain: string
  repo?: string
  hosting?: string
  description?: string
  tags?: string[]
}

/** Named date window resolved by the service from the configured zone. */
export type QueryPeriod = 'today' | 'this-week' | 'this-month' | 'this-year'

/** Shared date-window fields on query filters. */
export interface DateWindowFilter {
  /** Window start `YYYY-MM-DD` inclusive; overrides `period`. */
  from?: string
  /** Window end `YYYY-MM-DD` inclusive; overrides `period`. */
  to?: string
  /** Named window resolved against today in the configured zone. */
  period?: QueryPeriod
}

/** Experience query filter; category and action use the keys stored on records. */
export interface ExperienceFilter extends DateWindowFilter {
  /** Object category, e.g. movie, book, album, exhibition. */
  category?: string
  /** What was done, e.g. watched, read, listened, visited. */
  action?: string
  /** Segmented keywords; results with text are ordered by relevance. */
  text?: string
  /** Match all keywords by default; any returns partial keyword matches. */
  match?: 'all' | 'any'
  /** Case-insensitive exact tag match. */
  tag?: string
  limit?: number
}

/** Due-date window a task filter can select. */
export type TaskDueFilter = 'overdue' | 'today' | 'this-week'

/** Task query filter. */
export interface TaskFilter {
  statuses?: TaskStatus[]
  priority?: TaskPriority
  /** Due-date selection resolved against today in the configured zone. */
  due?: TaskDueFilter
  projectId?: ProjectId
  websiteId?: WebsiteId
  limit?: number
}

/** Project-log query filter. */
export interface ProjectLogFilter extends DateWindowFilter {
  /** Project by name or id; resolved to a project id. */
  project?: string
  tag?: string
  limit?: number
}

/** Blog-post query filter. */
export interface BlogPostFilter {
  status?: BlogPostStatus
  tag?: string
  limit?: number
}

/** Website query filter. */
export interface WebsiteFilter {
  tag?: string
  limit?: number
}

/** Idea query filter. */
export interface IdeaFilter {
  category?: string
  limit?: number
}

/** Daily-log query filter. */
export interface DailyLogFilter extends DateWindowFilter {
  limit?: number
}

/** Text search across all personal object types. */
export interface SearchPersonalInput extends DateWindowFilter {
  /** Chinese or Latin keywords, segmented and matched case-insensitively. */
  text: string
  /** Match all keywords by default; any broadens to partial matches. */
  match?: 'all' | 'any'
  /** Object types to search; omitted means every type. */
  types?: PersonalObjectType[]
  /** Global cap across every selected object type. */
  limit?: number
}

/** Positive BM25 field weights resolved from plugin configuration. */
export interface SearchWeights {
  title: number
  tags: number
  body: number
}

/** One search hit, in descending relevance order. */
export interface PersonalSearchHit {
  type: PersonalObjectType
  /** Positive relevance strength; comparisons apply only within this query. */
  score: number
  row: JsonValue
}

/** Query terms and globally ranked, JSON-safe domain records. */
export interface SearchPersonalResult {
  terms: string[]
  hits: PersonalSearchHit[]
}

/** One project's logs inside a daily review. */
export interface DailyReviewWork {
  project: ProjectRow
  logs: ProjectLogRow[]
}

/** One website's open tasks inside a review. */
export interface ReviewWebsiteTasks {
  website: WebsiteRow
  openTasks: TaskRow[]
}

/** Deterministic daily review: every fact is read from SQLite. */
export interface DailyReview {
  /** Reviewed date, `YYYY-MM-DD`. */
  date: string
  work: DailyReviewWork[]
  /** Tasks completed on the reviewed date. */
  tasksDone: TaskRow[]
  /** Tasks still open (TODO or DOING) as of the review. */
  tasksOpen: TaskRow[]
  experiences: ExperienceRow[]
  blogPosts: BlogPostRow[]
  ideas: IdeaRow[]
  websites: ReviewWebsiteTasks[]
  dailyLogs: DailyLogRow[]
}

/** Deterministic weekly review: every fact is read from SQLite. */
export interface WeeklyReview {
  /** Week window, Monday through Sunday, `YYYY-MM-DD` both ends. */
  from: string
  to: string
  /** Projects with at least one log in the week. */
  activeProjects: ProjectRow[]
  tasksDone: TaskRow[]
  tasksOpen: TaskRow[]
  experiences: ExperienceRow[]
  blogPosts: BlogPostRow[]
  ideas: IdeaRow[]
  websites: ReviewWebsiteTasks[]
}

/** Exact id of one editable personal record; names are never mutation targets. */
export type PersonalRecordId = ExperienceId | ProjectId | ProjectLogId | TaskId | BlogPostId | WebsiteId | IdeaId | DailyLogId

/** Content-derived token for comparing a record before a mutation. */
export type RecordRevision = Branded<'PersonalRecordRevision'>

/** Complete durable row and the revision required for a guarded mutation. */
export interface RecordSnapshot {
  type: PersonalObjectType
  row: Record<string, JsonValue>
  revision: RecordRevision
}
