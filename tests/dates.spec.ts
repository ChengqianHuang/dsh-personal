import { describe, expect, it } from 'vitest'
import {
  addDays,
  assertDayOffset,
  assertIsoDate,
  dueDateOn,
  nextMonthOf,
  resolveDueDate,
  resolveWindow,
  todayIso,
  validateTimeZone,
  weekRangeOf,
} from '../src/dates.ts'

describe('ISO date validation', () => {
  it('accepts real calendar dates and rejects malformed or impossible ones', () => {
    expect(assertIsoDate('2026-09-26', 'occurredOn')).toBe('2026-09-26')
    expect(() => assertIsoDate('2026-9-26', 'occurredOn')).toThrow('occurredOn')
    expect(() => assertIsoDate('2026-13-01', 'occurredOn')).toThrow('occurredOn')
    expect(() => assertIsoDate('2026-02-30', 'occurredOn')).toThrow('occurredOn')
    expect(() => assertIsoDate('not-a-date', 'occurredOn')).toThrow('occurredOn')
  })

  it('rejects negative or fractional day offsets', () => {
    expect(assertDayOffset(0, 'daysAgo')).toBe(0)
    expect(() => assertDayOffset(-1, 'daysAgo')).toThrow('daysAgo')
    expect(() => assertDayOffset(1.5, 'daysAgo')).toThrow('daysAgo')
  })

  it('rejects unusable time zones', () => {
    expect(validateTimeZone(undefined)).toBeUndefined()
    expect(validateTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(() => validateTimeZone('Mars/Olympus')).toThrow('timezone')
  })
})

describe('calendar math', () => {
  it('shifts dates across month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('resolves weekend buckets against the 2026-09-26 (Saturday) anchor', () => {
    // Anchor week: Mon 2026-09-21 .. Sun 2026-09-27.
    expect(dueDateOn('this-weekend', '2026-09-23')).toBe('2026-09-26') // Wed -> Saturday
    expect(dueDateOn('this-weekend', '2026-09-26')).toBe('2026-09-26') // already Saturday -> today
    expect(dueDateOn('this-weekend', '2026-09-27')).toBe('2026-09-27') // Sunday -> today, never past
    expect(dueDateOn('next-weekend', '2026-09-26')).toBe('2026-10-03') // next week's Saturday
    expect(dueDateOn('this-week', '2026-09-26')).toBe('2026-09-27') // unchanged: week ends Sunday
  })

  it('rolls next-month across the year boundary', () => {
    expect(nextMonthOf('2026-11-08')).toBe('2026-12-31')
    expect(nextMonthOf('2026-12-31')).toBe('2027-01-31')
  })

  it('returns Monday-based week windows', () => {
    expect(weekRangeOf('2026-09-26')).toEqual({ from: '2026-09-21', to: '2026-09-27' })
    expect(weekRangeOf('2026-09-21')).toEqual({ from: '2026-09-21', to: '2026-09-27' })
    expect(weekRangeOf('2026-09-27')).toEqual({ from: '2026-09-21', to: '2026-09-27' })
    expect(weekRangeOf('2026-09-28')).toEqual({ from: '2026-09-28', to: '2026-10-04' })
  })
})

describe('zone-relative resolutions', () => {
  it('computes today in the requested zone', () => {
    expect(todayIso('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(todayIso('Asia/Shanghai')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('maps due buckets onto calendar facts', () => {
    const today = todayIso('UTC')
    expect(resolveDueDate('today', 'UTC')).toBe(today)
    expect(resolveDueDate('tomorrow', 'UTC')).toBe(addDays(today, 1))
    expect(resolveDueDate('this-week', 'UTC')).toBe(weekRangeOf(today).to)
    expect(resolveDueDate('next-week', 'UTC')).toBe(addDays(weekRangeOf(today).from, 7))
    expect(resolveDueDate('this-month', 'UTC')).toBe(resolveWindow({ period: 'this-month' }, 'UTC').to)
  })

  it('lands next-month on the last day of the following month', () => {
    const today = todayIso('UTC')
    const year = Number(today.slice(0, 4))
    const month = Number(today.slice(5, 7))
    const nextMonth = month === 12 ? 1 : month + 1
    const nextYear = month === 12 ? year + 1 : year
    const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate()
    expect(resolveDueDate('next-month', 'UTC'))
      .toBe(`${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`)
  })
})

describe('window resolution', () => {
  it('accepts one-sided windows', () => {
    expect(resolveWindow({ from: '2026-09-01' }, 'UTC')).toEqual({ from: '2026-09-01' })
    expect(resolveWindow({ to: '2026-09-30' }, 'UTC')).toEqual({ to: '2026-09-30' })
  })

  it('prefers explicit bounds over the named period and rejects inversions', () => {
    expect(resolveWindow({ from: '2026-09-01', to: '2026-09-30' }, 'UTC'))
      .toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(resolveWindow({ from: '2026-09-01', to: '2026-09-30', period: 'today' }, 'UTC'))
      .toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(() => resolveWindow({ from: '2026-09-30', to: '2026-09-01' }, 'UTC')).toThrow('after')
  })

  it('resolves named periods against today', () => {
    const today = todayIso('UTC')
    expect(resolveWindow({ period: 'today' }, 'UTC')).toEqual({ from: today, to: today })
    expect(resolveWindow({ period: 'this-week' }, 'UTC')).toEqual(weekRangeOf(today))
    const year = resolveWindow({ period: 'this-year' }, 'UTC')
    expect(year.from).toBe(`${today.slice(0, 4)}-01-01`)
    expect(year.to).toBe(`${today.slice(0, 4)}-12-31`)
    expect(resolveWindow({}, 'UTC')).toEqual({})
  })
})
