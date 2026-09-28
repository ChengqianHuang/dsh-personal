import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../packages/core/agent-loop/tests/mock-adapter.ts'
import Personal from '../src/index.ts'
import { openPersonalDatabase } from '../src/store/open.ts'
import type { PersonalRecordId } from '../src/types.ts'

it('logs the full read/edit transcript and supplies the same facts to the next model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-personal-transcript-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(Personal, { databasePath: join(root, 'personal.db'), timezone: 'UTC' })
    const db = await openPersonalDatabase(join(root, 'personal.db'))
    try {
      db.exec("INSERT INTO experiences (id, category, action, title, occurred_on, rating, created_at) VALUES ('exp_fixture', 'movie', 'watched', '灵媒', '2026-09-01', 7.5, '2026-09-01T00:00:00.000Z')")
    } finally { db.close() }
    const revision = (await ctx.personal.getRecord('experience', 'exp_fixture' as PersonalRecordId)).revision
    const adapter = new MockAdapter([
      toolCallResponse('read', 'get_personal_record', { type: 'experience', id: 'exp_fixture' }),
      toolCallResponse('edit', 'update_personal_record', { type: 'experience', id: 'exp_fixture', expected_revision: revision, patch: { rating: 8 } }),
      textResponse('已把《灵媒》的评分改成 8 分。'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('personal-edit'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '把《灵媒》的评分改成 8 分。' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result' ? [{
      role: event.data.message.role, source: event.data.message.source, content: event.data.message.content,
    }] : [])
    expect(results).toMatchInlineSnapshot(`
      [
        {
          "content": [
            {
              "content": [
                {
                  "text": "{"type":"experience","row":{"id":"exp_fixture","category":"movie","action":"watched","title":"灵媒","occurredOn":"2026-09-01","rating":7.5,"note":"","tags":[],"createdAt":"2026-09-01T00:00:00.000Z"},"revision":"e32bd00d87c0607c654870d002dcffbf88b75f5364dbe11067f6553651a8b68a"}",
                  "type": "text",
                },
              ],
              "isError": false,
              "toolCallId": "read",
              "type": "tool-result",
            },
          ],
          "role": "user",
          "source": {
            "callId": "read",
            "kind": "tool",
          },
        },
        {
          "content": [
            {
              "content": [
                {
                  "text": "Updated personal record: {"type":"experience","row":{"id":"exp_fixture","category":"movie","action":"watched","title":"灵媒","occurredOn":"2026-09-01","rating":8,"note":"","tags":[],"createdAt":"2026-09-01T00:00:00.000Z"},"revision":"0701a435af902037da8ab8e49e1875288718e854ef98b9e9f234d38140542db5"}",
                  "type": "text",
                },
              ],
              "isError": false,
              "toolCallId": "edit",
              "type": "tool-result",
            },
          ],
          "role": "user",
          "source": {
            "callId": "edit",
            "kind": "tool",
          },
        },
      ]
    `)
    expect(adapter.requests).toHaveLength(3)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain(revision)
    expect(JSON.stringify(adapter.requests[2]!.messages)).toContain('Updated personal record:')
    expect((await ctx.personal.getRecord('experience', 'exp_fixture' as PersonalRecordId)).row.rating).toBe(8)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
