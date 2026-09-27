/**
 * Plugin configuration for `@deepseek-ai/dsh-personal`: database location,
 * review-tool toggles, and the IANA zone every date bucket is computed in.
 * @module @deepseek-ai/dsh-personal/config
 */

import { validateTimeZone } from './dates.ts'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { resolve } from 'node:path'
import type { SearchWeights } from './types.ts'

/** Directory under the Harness home holding the personal database. */
export const PERSONAL_HOME_SEGMENT = 'personal'

/** Default database file name under the personal directory. */
export const PERSONAL_DB_FILE_NAME = 'personal.db'

/** Model-facing tool configuration for the personal assistant plugin. */
export interface Config {
  /**
   * SQLite database file for personal data. Defaults to
   * `<harness home>/personal/personal.db` (`~/.dsh/personal/personal.db`).
   */
  databasePath?: string
  /** Register `generate_daily_review`. Enabled by default. */
  enableDailyReview?: boolean
  /** Register `generate_weekly_review`. Enabled by default. */
  enableWeeklyReview?: boolean
  /**
   * IANA time zone every date bucket (today, this week, this month, due
   * dates) is computed in. Defaults to the process zone.
   */
  timezone?: string
  /** Positive BM25 title weight; defaults to 5. */
  searchTitleWeight?: number
  /** Positive BM25 tag weight; defaults to 3. */
  searchTagWeight?: number
  /** Positive BM25 note/content weight; defaults to 1. */
  searchBodyWeight?: number
}

/** Resolved deployment settings produced once at plugin start. */
export interface PersonalSettings {
  databasePath: string
  enableDailyReview: boolean
  enableWeeklyReview: boolean
  timeZone: string | undefined
  searchWeights: SearchWeights
}

/**
 * Resolve and validate raw plugin config into deployment settings. Defaults
 * are computed here, once, so the rest of the plugin reads a complete spec.
 * @param config - schemastery-validated raw config.
 * @returns the resolved settings.
 * @throws when `timezone` is not a resolvable IANA zone or `databasePath` is blank.
 */
export function resolvePersonalConfig(config: Config): PersonalSettings {
  if (config.databasePath !== undefined && config.databasePath.trim() === '') {
    throw new Error('dsh-personal: databasePath must not be blank')
  }
  return {
    databasePath: config.databasePath === undefined
      ? joinDefaultDatabasePath()
      : resolve(expandHomePath(config.databasePath)),
    enableDailyReview: config.enableDailyReview ?? true,
    enableWeeklyReview: config.enableWeeklyReview ?? true,
    timeZone: validateTimeZone(config.timezone),
    searchWeights: resolveSearchWeights(config),
  }
}

/**
 * Resolve positive finite BM25 weights for every search entry point.
 * @param config - optional deployment weights.
 * @returns title, tag, and body weights.
 */
export function resolveSearchWeights(config: Config): SearchWeights {
  const weights = { title: config.searchTitleWeight ?? 5, tags: config.searchTagWeight ?? 3, body: config.searchBodyWeight ?? 1 }
  for (const [field, value] of Object.entries(weights)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`dsh-personal: search ${field} weight must be a positive finite number`)
  }
  return weights
}

/**
 * Compute the default database location under the Harness home.
 * @returns the absolute default database path.
 */
function joinDefaultDatabasePath(): string {
  return resolve(resolveDshHome(), PERSONAL_HOME_SEGMENT, PERSONAL_DB_FILE_NAME)
}
