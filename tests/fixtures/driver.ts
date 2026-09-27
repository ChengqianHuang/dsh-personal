#!/usr/bin/env node
/** Test driver that sends the tasks from a JSON env through one headless run. */

import { resolve } from 'node:path'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { bootProductionProfile } from '../../../packages/test-support/loader-smoke/tests/fixtures/production-profile.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('personal driver requires a config path')

const tasks = JSON.parse(process.env.E2E_TASKS ?? '') as string[]
if (!Array.isArray(tasks) || tasks.length === 0) {
  throw new Error('personal driver requires E2E_TASKS as a JSON array of tasks')
}

const ctx = await bootProductionProfile({
  binName: 'personal-e2e',
  profile: 'headless',
  overlayPaths: [configPath],
})
try {
  for (const task of tasks) {
    const result = await runFixtureTurn(ctx, { task })
    console.log(`TASK_RESULT: ${result.output}`)
  }
} finally {
  await ctx.fiber.dispose()
}
