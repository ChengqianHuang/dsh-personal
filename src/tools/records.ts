/**
 * Exact-id read, partial update, and deletion tools with snapshot revisions.
 * Model-selected targets must come from prior record results, never a guessed id.
 * @module dsh-personal/tools/records
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PersonalService } from '../index.ts'
import type { PersonalRecordId, RecordRevision } from '../types.ts'
import { PERSONAL_TYPES, textBlock } from './common.ts'

const target = {
  type: { type: 'string', enum: PERSONAL_TYPES, required: true, description: 'Kind from the selected record result.' },
  id: { type: 'string', required: true, description: 'Exact id from capture, query, or search. Never use a name or guess an id.' },
} as const

/** Shared revision parameter for every model-facing mutation path. */
export const revisionParameter = {
  type: 'string', required: true,
  description: 'Copy revision exactly from a fresh get_personal_record result for this target.',
} as const

const selectionRule = 'Use only after the user requests this operation. Resolve the target from conversation record ids '
  + 'or query/search results. If multiple records fit and the conversation does not distinguish them, ask the user '
  + 'which one; relevance rank alone does not identify the target. Read get_personal_record before mutating. '
  + 'On a stale revision, read again and reconsider; do not blindly retry. '

/**
 * Build the three guarded record tools.
 * @param service - service owning validation, revision checks, and transactions.
 * @returns tools with complete snapshot output visible to the model.
 */
export function createRecordTools(service: PersonalService): ToolDefinition[] {
  const get = defineTool({
    name: 'get_personal_record',
    description: 'Read one personal record by exact type and id, returning its complete row and revision. '
      + 'Use after capture/query/search to inspect a selected target before update or deletion. '
      + 'Ambiguous references require asking the user; do not choose solely by search rank.',
    parameters: target,
    output: { schema: { type: 'json', description: 'type, full row, and content revision.' }, render: (_args, value) => textBlock(JSON.stringify(value)) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      return await service.getRecord(args.type, brandString<PersonalRecordId>(args.id)) as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Read personal record', kind: 'other', rawInput: args }),
  })
  const update = defineTool({
    name: 'update_personal_record',
    description: selectionRule + 'Edit one record; omitted fields stay unchanged, null clears nullable fields, [] clears tags. '
      + 'Use camelCase fields copied from the row. Allowed fields: experience(category,action,title,occurredOn,rating,note,tags); '
      + 'project(name,description,status ACTIVE/PAUSED/COMPLETED); '
      + 'project_log(projectId,date,title,content,status DONE/WIP/BLOCKED,tags); '
      + 'task(title,status TODO/DOING/DONE/CANCELLED,priority LOW/MEDIUM/HIGH,dueAt,dueIn,projectId,websiteId,sourceType,sourceId); '
      + 'blog_post(title,status IDEA/OUTLINE/DRAFT/REVIEW/PUBLISHED,summary,content,tags,relatedProjectId); '
      + 'website(name,domain,repo,hosting,description,tags); idea(title,content,category,relatedProjectId); '
      + 'daily_log(date,summary,rawText). Reference fields require existing exact ids; nullable links can be cleared. '
      + 'Task dueIn uses today/tomorrow/this-week/next-week/this-weekend/next-weekend/this-month/next-month; dueAt wins. '
      + 'Entering DONE stamps doneAt; leaving DONE clears it. id, createdAt, updatedAt, doneAt cannot be patched.',
    parameters: {
      ...target, expected_revision: revisionParameter,
      patch: { type: 'json', required: true, description: 'Non-empty object of only requested editable camelCase fields, e.g. {"rating":8} or {"relatedProjectId":"project_..."}. null only for rating, dueAt, nullable links and task source fields.' },
    },
    output: { schema: { type: 'json', description: 'Updated complete snapshot with a new revision.' }, render: (_args, value) => textBlock(`Updated personal record: ${JSON.stringify(value)}`) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      return await service.updateRecord(args.type, brandString<PersonalRecordId>(args.id), brandString<RecordRevision>(args.expected_revision), args.patch) as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Update personal record', kind: 'other', rawInput: args }),
  })
  const remove = defineTool({
    name: 'delete_personal_record',
    description: selectionRule + 'Permanently delete exactly one record. Never delete merely because it looks duplicated; '
      + 'the user must request deletion. Return the deleted row and removed relation count. '
      + 'Incoming project/website links and task source references block deletion: report them and let the user '
      + 'decide whether to unlink or reassign; do not cascade. Explicit relation links are removed atomically. No undo.',
    parameters: { ...target, expected_revision: revisionParameter },
    output: { schema: { type: 'json', description: 'deleted snapshot and removedRelations count.' }, render: (_args, value) => textBlock(`Deleted personal record: ${JSON.stringify(value)}`) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      return await service.deleteRecord(args.type, brandString<PersonalRecordId>(args.id), brandString<RecordRevision>(args.expected_revision)) as unknown as JsonValue
    },
    presentCall: args => ({ card: 'generic', title: 'Delete personal record', kind: 'other', rawInput: args }),
  })
  return [get, update, remove]
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('dsh-personal: cancelled before execution')
}
