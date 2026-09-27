/**
 * Tool registration for the personal plugin: wires the write, query, and
 * review tool groups onto `ctx.tools`, gated by the review toggles.
 * @module @deepseek-ai/dsh-personal/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PersonalSettings } from '../config.ts'
import type { PersonalService } from '../index.ts'
import { createQueryTools } from './query.ts'
import { createReviewTools } from './review.ts'
import { createWriteTools } from './write.ts'

/**
 * Register every enabled personal tool on `ctx.tools`. Registration is
 * effect-scoped: disposing the plugin fiber unregisters them all.
 * @param ctx - the plugin's registrant context carrying `ctx.tools`.
 * @param service - the personal service the tools delegate to.
 * @param settings - resolved deployment settings gating the review tools.
 */
export function registerPersonalTools(ctx: Context, service: PersonalService, settings: PersonalSettings): void {
  const tools = [
    ...createWriteTools(service),
    ...createQueryTools(service),
    ...settings.enableDailyReview || settings.enableWeeklyReview ? createReviewTools(service) : [],
  ]
  for (const tool of tools) {
    if (!settings.enableDailyReview && tool.name === 'generate_daily_review') continue
    if (!settings.enableWeeklyReview && tool.name === 'generate_weekly_review') continue
    ctx.tools.register(tool)
  }
}
