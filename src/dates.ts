/**
 * Calendar helpers for the personal plugin. The service owns all date math —
 * model callers pass ISO dates, named windows, or day offsets, and every
 * "today" is computed in the configured zone, never parsed from prose.
 * @module @deepseek-ai/dsh-personal/dates
 */

import type { DueIn, QueryPeriod } from './types.ts'

/** Strict ISO calendar-date shape. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validate and return an ISO date string as-is.
 * @param value - caller-supplied calendar date.
 * @param label - parameter name for the error message.
 * @returns the validated date string.
 * @throws when the date is not a real ISO calendar date.
 */
export function assertIsoDate(value: string, label: string): string {
  // Round-trip through UTC rejects impossible calendar dates such as
  // 2026-02-30, which `Date.UTC` would silently roll over.
  const parts = parseDateParts(value)
  const roundTripped = parts === undefined ? undefined : formatUtcDate(new Date(dateToUtcMs(value)))
  if (parts === undefined || roundTripped !== value) {
    throw new Error(`dsh-personal: ${label} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Validate a day offset for "N days before today".
 * @param value - caller-supplied offset in days.
 * @param label - parameter name for the error message.
 * @returns the validated offset.
 * @throws when the offset is negative or not an integer.
 */
export function assertDayOffset(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`dsh-personal: ${label} must be a non-negative integer, got ${String(value)}`)
  }
  return value
}

/**
 * Validate a configurable IANA zone by letting `Intl` resolve it.
 * @param timeZone - zone name, or undefined for the process zone.
 * @returns the validated zone name, or undefined when the process zone applies.
 * @throws when the zone cannot be resolved.
 */
export function validateTimeZone(timeZone: string | undefined): string | undefined {
  if (timeZone === undefined) return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
  } catch (error) {
    throw new Error(`dsh-personal: invalid IANA timezone ${JSON.stringify(timeZone)}`, { cause: error })
  }
  return timeZone
}

/**
 * Today's calendar date in the given zone.
 * @param timeZone - IANA zone, or undefined for the process zone.
 * @returns `YYYY-MM-DD`.
 */
export function todayIso(timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/**
 * Shift an ISO date by whole days.
 * @param date - `YYYY-MM-DD`.
 * @param days - positive moves forward, negative backward.
 * @returns the shifted `YYYY-MM-DD`.
 */
export function addDays(date: string, days: number): string {
  const shifted = new Date(dateToUtcMs(date) + days * 86_400_000)
  return formatUtcDate(shifted)
}

/** One parsed calendar date: year, month (1-12), day. */
interface DateParts {
  year: number
  month: number
  day: number
}

/** Parse `YYYY-MM-DD` into numeric parts; invalid shapes return undefined. */
function parseDateParts(date: string): DateParts | undefined {
  if (!ISO_DATE.test(date)) return undefined
  const year = Number.parseInt(date.slice(0, 4), 10)
  const month = Number.parseInt(date.slice(5, 7), 10)
  const day = Number.parseInt(date.slice(8, 10), 10)
  /* v8 ignore next -- the regex guarantees digit runs, so parseInt cannot yield NaN. */
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return undefined
  return { year, month, day }
}

/**
 * Resolve a relative due bucket against today.
 * @param dueIn - named due bucket.
 * @param timeZone - IANA zone, or undefined for the process zone.
 * @returns the resolved due date `YYYY-MM-DD`.
 */
export function resolveDueDate(dueIn: DueIn, timeZone?: string): string {
  return dueDateOn(dueIn, todayIso(timeZone))
}

/**
 * Resolve a relative due bucket against an explicit anchor date — the pure
 * core of {@link resolveDueDate}, so every bucket is testable with fixed
 * anchors.
 *
 * Weekend convention: `this-weekend` is due **Saturday** — the task should be
 * done by the time the weekend begins — and it falls back to today when the
 * anchor is already a weekend day, so a weekend deadline never lands in the
 * past. `next-weekend` is the Saturday of the following week.
 * @param dueIn - named due bucket.
 * @param today - the anchor date `YYYY-MM-DD`.
 * @returns the resolved due date `YYYY-MM-DD`.
 */
export function dueDateOn(dueIn: DueIn, today: string): string {
  switch (dueIn) {
    case 'today': return today
    case 'tomorrow': return addDays(today, 1)
    case 'this-week': return weekRangeOf(today).to
    case 'next-week': return addDays(weekRangeOf(today).from, 7)
    case 'this-weekend': return weekendSaturdayOf(today)
    case 'next-weekend': return addDays(weekendSaturdayOf(today), 7)
    case 'this-month': return monthRangeOf(today).to
    case 'next-month': return nextMonthOf(today)
  }
}

/** The due date for "by the weekend": this week's Saturday, or today on a weekend day. */
function weekendSaturdayOf(date: string): string {
  if (new Date(dateToUtcMs(date)).getUTCDay() === 0) return date
  return addDays(weekRangeOf(date).from, 5)
}

/**
 * The last day of the month after one date's month.
 * @param date - anchor `YYYY-MM-DD`.
 * @returns e.g. `2026-12-01` anchors to `2027-01-31`.
 */
export function nextMonthOf(date: string): string {
  const parts = parseDateParts(date)
  /* v8 ignore next -- callers pass validated or clock-derived ISO dates. */
  if (parts === undefined) throw new Error(`dsh-personal: unparsable date ${JSON.stringify(date)}`)
  const nextMonth = parts.month === 12 ? 1 : parts.month + 1
  const nextYear = parts.month === 12 ? parts.year + 1 : parts.year
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate()
  return `${nextYear}-${pad(nextMonth)}-${pad(lastDay)}`
}

/**
 * Resolve a query date window. Explicit `from`/`to` win over `period`; with
 * neither, the window is unbounded.
 * @param filter - window fields from a query filter.
 * @param timeZone - IANA zone, or undefined for the process zone.
 * @returns inclusive `from`/`to` bounds, each present only when bounded.
 * @throws when `from` is after `to`.
 */
export function resolveWindow(
  filter: { from?: string; to?: string; period?: QueryPeriod },
  timeZone?: string,
): { from?: string; to?: string } {
  const from = filter.from !== undefined ? assertIsoDate(filter.from, 'from') : undefined
  const to = filter.to !== undefined ? assertIsoDate(filter.to, 'to') : undefined
  if (from !== undefined || to !== undefined) {
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error(`dsh-personal: window from ${from} is after to ${to}`)
    }
    return {
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    }
  }
  if (filter.period === undefined) return {}
  const today = todayIso(timeZone)
  switch (filter.period) {
    case 'today': return { from: today, to: today }
    case 'this-week': return weekRangeOf(today)
    case 'this-month': return monthRangeOf(today)
    case 'this-year': return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` }
  }
}

/**
 * The Monday-through-Sunday window containing one date.
 * @param date - `YYYY-MM-DD` inside the week.
 * @returns inclusive week bounds.
 */
export function weekRangeOf(date: string): { from: string; to: string } {
  const weekday = new Date(dateToUtcMs(date)).getUTCDay()
  const sinceMonday = (weekday + 6) % 7
  const from = addDays(date, -sinceMonday)
  return { from, to: addDays(from, 6) }
}

/** The first-to-last-day window of one date's month. */
function monthRangeOf(date: string): { from: string; to: string } {
  const parts = parseDateParts(date)
  /* v8 ignore next -- callers pass validated or minted ISO dates. */
  if (parts === undefined) throw new Error(`dsh-personal: unparsable date ${JSON.stringify(date)}`)
  const lastDay = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate()
  return { from: `${parts.year}-${pad(parts.month)}-01`, to: `${parts.year}-${pad(parts.month)}-${pad(lastDay)}` }
}

/** Parse `YYYY-MM-DD` to UTC midnight milliseconds; invalid dates become NaN. */
function dateToUtcMs(date: string): number {
  const parts = parseDateParts(date)
  /* v8 ignore next -- every caller passes regex-shaped or previously validated dates. */
  if (parts === undefined) return Number.NaN
  return Date.UTC(parts.year, parts.month - 1, parts.day)
}

/** Format a UTC-date-bearing timestamp as `YYYY-MM-DD`. */
function formatUtcDate(timestamp: Date): string {
  return `${timestamp.getUTCFullYear()}-${pad(timestamp.getUTCMonth() + 1)}-${pad(timestamp.getUTCDate())}`
}

/** Zero-pad a month or day number to two digits. */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}
