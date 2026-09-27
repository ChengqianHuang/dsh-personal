/**
 * Model-facing review tools: deterministic fact bundles assembled from the
 * stores, rendered as sections. The model narrates the result; it cannot
 * invent facts because the bundle is the only input it receives.
 * @module @deepseek-ai/dsh-personal/tools/review
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PersonalService } from '../index.ts'
import type { DailyReview, WeeklyReview } from '../types.ts'
import { renderBlogPost, renderIdea, renderMovie, renderProjectLog, renderTask, textBlock } from './common.ts'

/**
 * Build the two review tools over one service.
 * @param service - the personal service the tools delegate to.
 * @returns the tool definitions for registration.
 */
export function createReviewTools(service: PersonalService): ToolDefinition[] {
  const generateDailyReview = defineTool({
    name: 'generate_daily_review',
    description:
      'Assemble the day\'s facts from the personal database: project logs, tasks done and '
      + 'still open, movies watched, blog posts and ideas created, websites with open tasks, '
      + 'and daily-log entries. Narrate the result; do not invent facts beyond it.',
    parameters: {
      date: { type: 'string', description: 'Reviewed date YYYY-MM-DD; omit for today.' },
      days_ago: { type: 'integer', description: 'Whole days before today, e.g. 1 for yesterday; ignored when date is given.' },
    },
    output: {
      schema: { type: 'json', description: 'The full daily fact bundle, keyed by section.' },
      render: (_args, value) => textBlock(renderDailyReview(value as unknown as DailyReview)),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('dsh-personal: cancelled before execution')
      const date = service.resolveReviewDate(args.date, args.days_ago)
      // Review bundles are JSON-safe by construction (strings, numbers,
      // nulls, and arrays); the tool returns the bundle as its JSON view.
      return await service.generateDailyReview(date) as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Daily review', kind: 'other', rawInput: args.date ?? 'today' }),
  })

  const generateWeeklyReview = defineTool({
    name: 'generate_weekly_review',
    description:
      'Assemble one week\'s facts (Monday through Sunday) from the personal database: active '
      + 'projects, tasks done and still open, movies watched, blog posts and ideas created, '
      + 'and websites with open tasks. Narrate the result; do not invent facts beyond it.',
    parameters: {
      date: { type: 'string', description: 'Any date inside the reviewed week, YYYY-MM-DD; omit for the current week.' },
    },
    output: {
      schema: { type: 'json', description: 'The full weekly fact bundle, keyed by section.' },
      render: (_args, value) => textBlock(renderWeeklyReview(value as unknown as WeeklyReview)),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('dsh-personal: cancelled before execution')
      return await service.generateWeeklyReview(args.date) as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Weekly review', kind: 'other', rawInput: args.date ?? 'this week' }),
  })

  return [generateDailyReview, generateWeeklyReview]
}

/**
 * Render the daily fact bundle as review sections.
 * @param review - the deterministic fact bundle.
 * @returns the sectioned review text.
 */
export function renderDailyReview(review: DailyReview): string {
  const sections: string[] = [`Daily review ${review.date}`]
  if (review.work.length > 0) {
    sections.push('Work:')
    for (const entry of review.work) {
      sections.push(`  ${entry.project.name}:`)
      for (const log of entry.logs) sections.push(`    - ${renderProjectLog(log)}`)
    }
  }
  pushCoreFacts(sections, review)
  pushWebsites(sections, review.websites)
  if (review.dailyLogs.length > 0) {
    sections.push('Daily logs:')
    for (const log of review.dailyLogs) sections.push(`  - ${log.summary}`)
  }
  return sections.join('\n')
}

/**
 * Render the weekly fact bundle as review sections.
 * @param review - the deterministic fact bundle.
 * @returns the sectioned review text.
 */
export function renderWeeklyReview(review: WeeklyReview): string {
  const sections: string[] = [`Weekly review ${review.from} .. ${review.to}`]
  if (review.activeProjects.length > 0) {
    sections.push('Active projects:')
    for (const project of review.activeProjects) sections.push(`  - ${project.name}`)
  }
  pushCoreFacts(sections, review)
  pushWebsites(sections, review.websites)
  return sections.join('\n')
}

/** Append the task and creation sections shared by both review shapes. */
function pushCoreFacts(
  sections: string[],
  review: Pick<DailyReview, 'tasksDone' | 'tasksOpen' | 'movies' | 'blogPosts' | 'ideas'>,
): void {
  pushTasks(sections, 'Tasks done', review.tasksDone)
  pushTasks(sections, 'Tasks open', review.tasksOpen)
  pushRows(sections, 'Movies watched', review.movies, renderMovie)
  pushRows(sections, 'Blog posts created', review.blogPosts, renderBlogPost)
  pushRows(sections, 'Ideas captured', review.ideas, renderIdea)
}

/** Append the website-tasks section when non-empty. */
function pushWebsites(sections: string[], websites: ReadonlyArray<DailyReview['websites'][number]>): void {
  if (websites.length === 0) return
  sections.push('Websites with open tasks:')
  for (const entry of websites) {
    sections.push(`  ${entry.website.name} (${entry.website.domain}): ${entry.openTasks.length} open`)
    for (const task of entry.openTasks) sections.push(`    - ${renderTask(task)}`)
  }
}

/** Append a task section when non-empty. */
function pushTasks(sections: string[], title: string, tasks: ReadonlyArray<Parameters<typeof renderTask>[0]>): void {
  pushRows(sections, title, tasks, renderTask)
}

/** Append a rendered-row section when non-empty. */
function pushRows<T>(
  sections: string[],
  title: string,
  rows: readonly T[],
  render: (row: T) => string,
): void {
  if (rows.length === 0) return
  sections.push(`${title}:`)
  for (const row of rows) sections.push(`  - ${render(row)}`)
}
