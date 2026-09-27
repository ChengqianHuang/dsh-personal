/**
 * Plugin configuration for `@deepseek-ai/dsh-personal`: database location,
 * review-tool toggles, and the IANA zone every date bucket is computed in.
 * @module @deepseek-ai/dsh-personal/config
 */

import { validateTimeZone } from './dates.ts'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { resolve } from 'node:path'

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
}

/** Resolved deployment settings produced once at plugin start. */
export interface PersonalSettings {
  databasePath: string
  enableDailyReview: boolean
  enableWeeklyReview: boolean
  timeZone: string | undefined
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
  }
}

/**
 * Compute the default database location under the Harness home.
 * @returns the absolute default database path.
 */
function joinDefaultDatabasePath(): string {
  return resolve(resolveDshHome(), PERSONAL_HOME_SEGMENT, PERSONAL_DB_FILE_NAME)
}
