/**
 * Deterministic review assembly: daily and weekly facts read from the stores.
 * No summarization here — the tools layer hands these facts to the model,
 * which narrates while the facts stay SQLite-sourced.
 * @module @deepseek-ai/dsh-personal/review
 */

import { weekRangeOf } from './dates.ts'
import type { DailyReview, ProjectId, ProjectLogRow, WeeklyReview } from './types.ts'
import type { BlogPostStore } from './store/blogs.ts'
import type { DailyLogStore, IdeaStore } from './store/ideas.ts'
import type { MovieStore } from './store/movies.ts'
import type { ProjectLogStore, ProjectStore } from './store/projects.ts'
import type { TaskStore } from './store/tasks.ts'
import type { WebsiteStore } from './store/websites.ts'

/** Store bundle a review reads from; the service owns and closes them. */
export interface ReviewStores {
  movies: MovieStore
  projects: ProjectStore
  projectLogs: ProjectLogStore
  tasks: TaskStore
  blogPosts: BlogPostStore
  websites: WebsiteStore
  ideas: IdeaStore
  dailyLogs: DailyLogStore
}

/**
 * Assemble one day's review facts.
 * @param stores - the personal stores.
 * @param date - reviewed date `YYYY-MM-DD`.
 * @returns the deterministic fact bundle.
 */
export function buildDailyReview(stores: ReviewStores, date: string): DailyReview {
  const logs = stores.projectLogs.list({ from: date, to: date, limit: 200 })
  const logsByProject = new Map<ProjectId, ProjectLogRow[]>()
  for (const log of logs) {
    const existing = logsByProject.get(log.projectId)
    if (existing === undefined) logsByProject.set(log.projectId, [log])
    else existing.push(log)
  }
  const work = [...logsByProject.entries()]
    .map(([projectId, projectLogs]) => {
      const project = stores.projects.get(projectId)
      /* v8 ignore next -- foreign keys plus the no-delete v1 surface mean a
         log's project always resolves; the undefined arm guards only against
         a hand-edited database. */
      return project === undefined ? undefined : { project, logs: projectLogs }
    })
    .filter(entry => entry !== undefined)
  return {
    date,
    work,
    tasksDone: stores.tasks.listDoneOn(date),
    tasksOpen: stores.tasks.listOpen(),
    movies: stores.movies.list({ from: date, to: date, limit: 200 }),
    blogPosts: stores.blogPosts.listCreatedBetween({ from: date, to: date }),
    ideas: stores.ideas.listCreatedBetween({ from: date, to: date }),
    websites: openTasksByWebsite(stores),
    dailyLogs: stores.dailyLogs.listOn(date),
  }
}

/**
 * Assemble one week's review facts, Monday through Sunday.
 * @param stores - the personal stores.
 * @param anchor - any date `YYYY-MM-DD` inside the reviewed week.
 * @returns the deterministic fact bundle with its resolved window.
 */
export function buildWeeklyReview(stores: ReviewStores, anchor: string): WeeklyReview {
  const week = weekRangeOf(anchor)
  const logs = stores.projectLogs.list({ from: week.from, to: week.to, limit: 200 })
  const activeProjectIds = new Set(logs.map(log => log.projectId))
  return {
    from: week.from,
    to: week.to,
    activeProjects: stores.projects.list().filter(project => activeProjectIds.has(project.id)),
    tasksDone: stores.tasks.listDoneBetween(week),
    tasksOpen: stores.tasks.listOpen(),
    movies: stores.movies.list({ from: week.from, to: week.to, limit: 200 }),
    blogPosts: stores.blogPosts.listCreatedBetween(week),
    ideas: stores.ideas.listCreatedBetween(week),
    websites: openTasksByWebsite(stores),
  }
}

/** Each website with its open (TODO or DOING) tasks. */
function openTasksByWebsite(stores: ReviewStores): DailyReview['websites'] {
  return stores.websites.list({ limit: 200 })
    .map(website => ({
      website,
      openTasks: stores.tasks.list({ statuses: ['TODO', 'DOING'], websiteId: website.id, limit: 200 }),
    }))
    .filter(entry => entry.openTasks.length > 0)
}
