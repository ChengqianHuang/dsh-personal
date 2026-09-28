/**
 * Validation of model-supplied partial record edits. Each object kind has an
 * explicit field allowlist; ids and creation times cannot be patched.
 * @module dsh-personal/record-edit
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { assertIsoDate, dueDateOn } from './dates.ts'
import type { PersonalObjectType } from './types.ts'
import type { SupportedValue } from './store/statements.ts'

interface FieldRule {
  column: string
  kind: 'required' | 'text' | 'key' | 'date' | 'rating' | 'tags' | 'reference' | 'source'
  nullable?: boolean
  values?: readonly string[]
  target?: 'project' | 'website'
}

const text = (column: string): FieldRule => ({ column, kind: 'text' })
const required = (column: string): FieldRule => ({ column, kind: 'required' })
const tags: FieldRule = { column: 'tags', kind: 'tags' }
const project: FieldRule = { column: 'related_project_id', kind: 'reference', target: 'project', nullable: true }
const fields: Record<PersonalObjectType, Record<string, FieldRule>> = {
  experience: {
    category: { column: 'category', kind: 'key' }, action: { column: 'action', kind: 'key' },
    title: required('title'), occurredOn: { column: 'occurred_on', kind: 'date' },
    rating: { column: 'rating', kind: 'rating', nullable: true }, note: text('note'), tags,
  },
  project: { name: required('name'), description: text('description'), status: { ...required('status'), values: ['ACTIVE', 'PAUSED', 'COMPLETED'] } },
  project_log: {
    projectId: { column: 'project_id', kind: 'reference', target: 'project' }, date: { column: 'date', kind: 'date' },
    title: required('title'), content: text('content'), tags,
    status: { ...required('status'), values: ['DONE', 'WIP', 'BLOCKED'] },
  },
  task: {
    title: required('title'), status: { ...required('status'), values: ['TODO', 'DOING', 'DONE', 'CANCELLED'] },
    priority: { ...required('priority'), values: ['LOW', 'MEDIUM', 'HIGH'] },
    dueAt: { column: 'due_at', kind: 'date', nullable: true },
    projectId: { column: 'project_id', kind: 'reference', target: 'project', nullable: true },
    websiteId: { column: 'website_id', kind: 'reference', target: 'website', nullable: true },
    sourceType: { column: 'source_type', kind: 'source', nullable: true },
    sourceId: { column: 'source_id', kind: 'source', nullable: true },
  },
  blog_post: {
    title: required('title'), summary: text('summary'), content: text('content'), tags, relatedProjectId: project,
    status: { ...required('status'), values: ['IDEA', 'OUTLINE', 'DRAFT', 'REVIEW', 'PUBLISHED'] },
  },
  website: { name: required('name'), domain: required('domain'), repo: text('repo'), hosting: text('hosting'), description: text('description'), tags },
  idea: { title: required('title'), content: text('content'), category: text('category'), relatedProjectId: project },
  daily_log: { date: { column: 'date', kind: 'date' }, summary: required('summary'), rawText: text('raw_text') },
}

/**
 * Parse a partial camelCase patch, preserving omission and explicit null.
 * @param type - record kind selecting the editable fields.
 * @param patch - untrusted tool JSON; object with at least one editable field.
 * @param today - current date in the configured timezone.
 * @param exists - exact-id check for project and website references.
 * @returns SQL column/value pairs; no user-supplied identifiers survive.
 */
export function parseRecordPatch(
  type: PersonalObjectType, patch: JsonValue, today: string,
  exists: (type: 'project' | 'website', id: string) => boolean,
): Array<readonly [string, SupportedValue]> {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new Error('dsh-personal: patch must be a non-empty object of editable fields')
  }
  const pairs: Array<readonly [string, SupportedValue]> = []
  for (const [key, value] of Object.entries(patch)) {
    if (type === 'task' && key === 'dueIn') {
      const buckets = ['today', 'tomorrow', 'this-week', 'next-week', 'this-weekend', 'next-weekend', 'this-month', 'next-month'] as const
      if (typeof value !== 'string' || !buckets.some(bucket => bucket === value)) throw new Error('dsh-personal: invalid dueIn')
      if (!Object.hasOwn(patch, 'dueAt')) pairs.push(['due_at', dueDateOn(value as typeof buckets[number], today)])
      continue
    }
    const rule = Object.hasOwn(fields[type], key) ? fields[type][key] : undefined
    if (rule === undefined) throw new Error(`dsh-personal: ${type} field ${JSON.stringify(key)} is not editable`)
    let normalized: SupportedValue
    if (value === null && rule.nullable === true) normalized = null
    else if (rule.kind === 'rating') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) throw new Error('dsh-personal: rating must be a finite number 0-10 or null')
      normalized = value
    } else if (rule.kind === 'tags') {
      if (!Array.isArray(value) || !value.every(tag => typeof tag === 'string' && tag.trim().length > 0)) throw new Error('dsh-personal: tags must be an array of non-blank strings')
      normalized = JSON.stringify(value.map(tag => (tag as string).trim()))
    } else {
      if (typeof value !== 'string') throw new Error(`dsh-personal: ${key} must be a string${rule.nullable === true ? ' or null' : ''}`)
      normalized = value.trim()
      if (rule.kind !== 'text' && normalized.length === 0) throw new Error(`dsh-personal: ${key} must not be blank`)
      if (rule.kind === 'key') normalized = normalized.toLowerCase().replace(/\s+/g, ' ')
      if (rule.kind === 'date') normalized = assertIsoDate(normalized, key)
      if (type === 'experience' && key === 'occurredOn' && normalized > today) throw new Error('dsh-personal: occurredOn must not be in the future; planned items belong in create_task')
      if (rule.values !== undefined && !rule.values.includes(normalized)) throw new Error(`dsh-personal: invalid ${key}: ${normalized}`)
      if (rule.target !== undefined && !exists(rule.target, normalized)) throw new Error(`dsh-personal: unknown ${rule.target} id ${JSON.stringify(normalized)}`)
    }
    pairs.push([rule.column, normalized])
  }
  return pairs
}
