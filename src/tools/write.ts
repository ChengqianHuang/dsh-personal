/**
 * Model-facing capture and mutation tools. Each tool is a thin adapter: the
 * schema states the typed contract, the service normalizes and persists, and
 * the render confirms what was stored. The model never composes SQL, picks
 * storage formats, or sees internal column names beyond the row contract.
 * @module @deepseek-ai/dsh-personal/tools/write
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PersonalService } from '../index.ts'
import type { BlogPostId, TaskId } from '../types.ts'
import {
  BLOG_POST_STATUSES,
  DUE_IN_VALUES,
  PROJECT_LOG_STATUSES,
  PROJECT_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  blogPostRowSchema,
  dateParam,
  dailyLogRowSchema,
  experienceRowSchema,
  ideaRowSchema,
  projectLogRowSchema,
  projectRowSchema,
  renderBlogPost,
  renderDailyLog,
  renderExperience,
  renderIdea,
  renderProject,
  renderProjectLog,
  renderTask,
  taskRowSchema,
  textBlock,
  websiteRowSchema,
} from './common.ts'

/**
 * Build the eleven capture and mutation tools over one service.
 * @param service - the personal service the tools delegate to.
 * @returns the tool definitions for registration.
 */
export function createWriteTools(service: PersonalService): ToolDefinition[] {
  const recordExperience = defineTool({
    name: 'record_experience',
    description:
      'Record something the user already experienced: a movie watched, a book read, an album '
      + 'listened to, an exhibition visited. Use lowercase category keys and past-tense action keys '
      + '(category: movie, book, album, exhibition, ...; action: watched, read, listened, '
      + 'visited, ...). Only for things that already happened — planned items go to '
      + 'create_task. occurred_on defaults to today; pass exactly what the user said and '
      + 'omit the rest.',
    parameters: {
      category: {
        type: 'string',
        required: true,
        description: 'What kind of thing, lowercase singular: movie, book, album, exhibition, ...',
      },
      action: {
        type: 'string',
        required: true,
        description: 'What was done, lowercase past tense: watched, read, listened, visited, ...',
      },
      title: { type: 'string', required: true, description: 'Name of the experienced thing, e.g. the movie or book title.' },
      rating: { type: 'number', description: 'User rating 0-10; decimals like 7.5 are stored as given.' },
      occurred_on: dateParam('Experience date'),
      note: { type: 'string', description: 'Optional short note.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { experience: { ...experienceRowSchema, required: true } },
      },
      render: (_args, value) => textBlock(`Recorded experience: ${renderExperience(value.experience)}`),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const { occurred_on, ...rest } = args
      return {
        experience: await service.recordExperience({
          ...rest,
          ...(occurred_on !== undefined ? { occurredOn: occurred_on } : {}),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Record experience', kind: 'other', rawInput: args.title }),
  })

  const createProject = defineTool({
    name: 'create_project',
    description:
      'Create a named project explicitly. Recording a project log with an unknown project '
      + 'name also creates one, so use this tool when the user sets up a project without '
      + 'logging progress yet.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique project name.' },
      description: { type: 'string', description: 'What the project is.' },
      status: { type: 'string', enum: PROJECT_STATUSES, description: 'Defaults to ACTIVE.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { project: { ...projectRowSchema, required: true } },
      },
      render: (_args, value) => textBlock(`Created project: ${renderProject(value.project)}`),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      return { project: await service.createProject(args) }
    },
    presentCall: args => ({ card: 'generic', title: 'Create project', kind: 'other', rawInput: args.name }),
  })

  const recordProjectLog = defineTool({
    name: 'record_project_log',
    description:
      'Record what was done on a project. The project is found by name and created on first '
      + 'mention, the log date defaults to today, and a status of DONE, WIP, or BLOCKED can '
      + 'be attached. Use for progress updates like “Forge 今天定位了 streaming 中文错位问题”.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project name or id; created on first mention.' },
      title: { type: 'string', required: true, description: 'One-line summary of what was done.' },
      content: { type: 'string', description: 'Optional details.' },
      date: dateParam('Log date'),
      status: { type: 'string', enum: PROJECT_LOG_STATUSES, description: 'Outcome; defaults to DONE.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          log: { ...projectLogRowSchema, required: true },
          projectCreated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => textBlock(
        `Recorded project log${value.projectCreated ? ' (new project)' : ''}: ${renderProjectLog(value.log)}`,
      ),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const { log, projectCreated } = await service.recordProjectLog(args)
      return { log, projectCreated }
    },
    presentCall: args => ({ card: 'generic', title: 'Record project log', kind: 'other', rawInput: args.title }),
  })

  const createTask = defineTool({
    name: 'create_task',
    description:
      'Create a task the user commits to doing — something with a concrete action and, '
      + 'optionally, a deadline. Relative deadlines (“明天”, “下周”, “周末”) map to due_in '
      + 'and are strongly preferred: resolve due_at only from a date the user stated '
      + 'explicitly, never from a guessed weekday. A project or website reference links the task.',
    parameters: {
      title: { type: 'string', required: true, description: 'Imperative task line.' },
      due_at: { type: 'string', description: 'Exact due date YYYY-MM-DD; wins over due_in.' },
      due_in: {
        type: 'string',
        enum: DUE_IN_VALUES,
        description:
          'Relative due bucket: today, tomorrow, this-week (due Sunday), next-week, '
          + 'this-weekend (due Saturday — done before the weekend starts; already-weekend days fall back to today), '
          + 'next-weekend, this-month, or next-month.',
      },
      priority: { type: 'string', enum: TASK_PRIORITIES, description: 'LOW, MEDIUM (default), or HIGH.' },
      project: { type: 'string', description: 'Owning project name or id.' },
      website: { type: 'string', description: 'Related website name, domain, or id.' },
      source_type: { type: 'string', description: 'Kind of record this task came from, e.g. blog_post.' },
      source_id: { type: 'string', description: 'Id of the record this task came from.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { task: { ...taskRowSchema, required: true } },
      },
      render: (_args, value) => textBlock(`Created task: ${renderTask(value.task)}`),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const { due_at, due_in, source_type, source_id, ...rest } = args
      return {
        task: await service.createTask({
          ...rest,
          ...(due_at !== undefined ? { dueAt: due_at } : {}),
          ...(due_in !== undefined ? { dueIn: due_in } : {}),
          ...(source_type !== undefined ? { sourceType: source_type } : {}),
          ...(source_id !== undefined ? { sourceId: source_id } : {}),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Create task', kind: 'other', rawInput: args.title }),
  })

  const updateTask = defineTool({
    name: 'update_task',
    description:
      'Update a task by id: rename, change status (TODO, DOING, DONE, CANCELLED), priority, '
      + 'or due date. Entering DONE stamps the completion date automatically.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id from create_task or query_tasks.' },
      title: { type: 'string', description: 'New title.' },
      status: { type: 'string', enum: TASK_STATUSES, description: 'New status.' },
      priority: { type: 'string', enum: TASK_PRIORITIES, description: 'New priority.' },
      due_at: { type: 'string', description: 'New due date YYYY-MM-DD; wins over due_in.' },
      due_in: {
        type: 'string',
        enum: DUE_IN_VALUES,
        description:
          'Relative due bucket (this-weekend is due Saturday); ignored when due_at is present.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { task: { ...taskRowSchema, required: true } },
      },
      render: (_args, value) => textBlock(`Updated task: ${renderTask(value.task)}`),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const { task_id, due_at, due_in, ...patch } = args
      return {
        task: await service.updateTask(brandString<TaskId>(task_id), {
          ...patch,
          ...(due_at !== undefined ? { dueAt: due_at } : {}),
          ...(due_in !== undefined ? { dueIn: due_in } : {}),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Update task', kind: 'other', rawInput: args.task_id }),
  })

  const completeTask = defineTool({
    name: 'complete_task',
    description: 'Mark a task DONE by id; the completion date is stamped automatically.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id from create_task or query_tasks.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { task: { ...taskRowSchema, required: true } },
      },
      render: (_args, value) => textBlock(`Completed task: ${renderTask(value.task)}`),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      return { task: await service.completeTask(brandString<TaskId>(args.task_id)) }
    },
    presentCall: args => ({ card: 'generic', title: 'Complete task', kind: 'other', rawInput: args.task_id }),
  })

  const createBlogPost = defineTool({
    name: 'create_blog_post',
    description:
      'Create a blog post record. A future writing idea starts at status IDEA; the pipeline '
      + 'is IDEA → OUTLINE → DRAFT → REVIEW → PUBLISHED. Optionally link a related project.',
    parameters: {
      title: { type: 'string', required: true, description: 'Working title.' },
      status: { type: 'string', enum: BLOG_POST_STATUSES, description: 'Pipeline stage; defaults to IDEA.' },
      summary: { type: 'string', description: 'One-line premise.' },
      content: { type: 'string', description: 'Draft content, if any.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      related_project: { type: 'string', description: 'Project name or id this post relates to.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { post: { ...blogPostRowSchema, required: true } },
      },
      render: (_args, value) => textBlock(`Created blog post: ${renderBlogPost(value.post)}`),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const { related_project, ...rest } = args
      return {
        post: await service.createBlogPost({
          ...rest,
          ...(related_project !== undefined ? { relatedProject: related_project } : {}),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Create blog post', kind: 'other', rawInput: args.title }),
  })

  const updateBlogPost = defineTool({
    name: 'update_blog_post',
    description: 'Update a blog post by id: title, pipeline stage, summary, content, or tags.',
    parameters: {
      post_id: { type: 'string', required: true, description: 'Post id from create_blog_post or query_blog_posts.' },
      title: { type: 'string', description: 'New title.' },
      status: { type: 'string', enum: BLOG_POST_STATUSES, description: 'New pipeline stage.' },
      summary: { type: 'string', description: 'New summary.' },
      content: { type: 'string', description: 'New content.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replaces the tag list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { post: { ...blogPostRowSchema, required: true } },
      },
      render: (_args, value) => textBlock(`Updated blog post: ${renderBlogPost(value.post)}`),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const { post_id, ...patch } = args
      return { post: await service.updateBlogPost(brandString<BlogPostId>(post_id), patch) }
    },
    presentCall: args => ({ card: 'generic', title: 'Update blog post', kind: 'other', rawInput: args.post_id }),
  })

  const createIdea = defineTool({
    name: 'create_idea',
    description:
      'Capture an idea worth keeping: a thought, an angle, a research interest, something '
      + 'the user wants to look into someday — recorded WITHOUT any commitment to an action '
      + 'or a date. “想研究 X”“以后了解一下 X” belong here. When the user names a concrete '
      + 'action or a deadline, that is create_task, not an idea.',
    parameters: {
      title: { type: 'string', required: true, description: 'Idea in one line.' },
      content: { type: 'string', description: 'Details.' },
      category: { type: 'string', description: 'Free-form category, e.g. product, writing, life.' },
      related_project: { type: 'string', description: 'Project name or id this idea relates to.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { idea: { ...ideaRowSchema, required: true } },
      },
      render: (_args, value) => textBlock(`Created idea: ${renderIdea(value.idea)}`),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const { related_project, ...rest } = args
      return {
        idea: await service.createIdea({
          ...rest,
          ...(related_project !== undefined ? { relatedProject: related_project } : {}),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Capture idea', kind: 'other', rawInput: args.title }),
  })

  const recordDailyLog = defineTool({
    name: 'record_daily_log',
    description:
      'Record a free-text daily journal entry. Call this ONLY when the user explicitly asks '
      + 'to keep a diary or log of their day (“记一下今天”“写个日记”). Ordinary batch captures '
      + '— several movies, logs, or tasks reported in one message — go to their own structured '
      + 'tools; do not also create a daily log for them. The date defaults to today.',
    parameters: {
      summary: { type: 'string', required: true, description: 'One-paragraph summary of the day.' },
      raw_text: { type: 'string', description: 'The user\'s original words, if dictated.' },
      date: dateParam('Log date'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { log: { ...dailyLogRowSchema, required: true } },
      },
      render: (_args, value) => textBlock(`Recorded daily log: ${renderDailyLog(value.log)}`),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const { raw_text, ...rest } = args
      return {
        log: await service.recordDailyLog({
          ...rest,
          ...(raw_text !== undefined ? { rawText: raw_text } : {}),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Record daily log', kind: 'other', rawInput: args.summary }),
  })

  const registerWebsite = defineTool({
    name: 'register_website',
    description:
      'Register a personal website the user owns or maintains, keyed by its unique domain. '
      + 'Maintenance tasks can then link to it by name or domain.',
    parameters: {
      name: { type: 'string', required: true, description: 'Human name for the site.' },
      domain: { type: 'string', required: true, description: 'Primary domain, e.g. example.com.' },
      repo: { type: 'string', description: 'Repository URL.' },
      hosting: { type: 'string', description: 'Where it is hosted.' },
      description: { type: 'string', description: 'What the site is.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { website: { ...websiteRowSchema, required: true } },
      },
      render: (_args, value) => textBlock(`Registered website: ${value.website.name} (${value.website.domain})`),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      return { website: await service.registerWebsite(args) }
    },
    presentCall: args => ({ card: 'generic', title: 'Register website', kind: 'other', rawInput: args.domain }),
  })

  return [
    recordExperience,
    createProject,
    recordProjectLog,
    createTask,
    updateTask,
    completeTask,
    createBlogPost,
    updateBlogPost,
    createIdea,
    recordDailyLog,
    registerWebsite,
  ]
}

/** Reject a call whose cancellation already arrived. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('dsh-personal: cancelled before execution')
}
