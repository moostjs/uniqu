import { describe, it, expect, vi } from 'vitest'
import {
  BUCKET_MAX_INSTANT,
  BUCKET_MIN_INSTANT,
  BUCKET_UNITS,
  TIME_ZONE_NAME_RE,
  WEEK_STARTS,
  bucketLabel,
  bucketLabelUncached,
  bucketSeries,
  bucketStartInstant,
  bucketer,
  checkTimeZone,
  nextBucketLabel,
} from './calendar'
import type { BucketUnit, WeekStart } from './types'

const at = (iso: string) => Date.parse(iso)

// Every literal below was checked against Intl.DateTimeFormat (ICU 78.3, tzdata 2026c)
// when authored; the oracle property test re-verifies the kernel continuously.

const DST_CASES: Array<[tz: string, instant: string, label: string]> = [
  // Europe/Berlin spring-forward, Sunday 2026-03-29 (CET→CEST at 01:00Z)
  ['Europe/Berlin', '2026-03-28T22:59:59Z', '2026-03-28'],
  ['Europe/Berlin', '2026-03-28T23:00:00Z', '2026-03-29'],
  ['Europe/Berlin', '2026-03-28T23:30:00Z', '2026-03-29'],
  ['Europe/Berlin', '2026-03-29T00:59:59Z', '2026-03-29'], // 01:59:59 CET
  ['Europe/Berlin', '2026-03-29T01:00:00Z', '2026-03-29'], // 03:00 CEST
  ['Europe/Berlin', '2026-03-29T21:59:59Z', '2026-03-29'],
  ['Europe/Berlin', '2026-03-29T22:00:00Z', '2026-03-30'],
  // Europe/Berlin fall-back, Sunday 2026-10-25 (CEST→CET at 01:00Z; 02:00–03:00 local occurs twice)
  ['Europe/Berlin', '2026-10-24T21:59:59Z', '2026-10-24'],
  ['Europe/Berlin', '2026-10-24T22:00:00Z', '2026-10-25'],
  ['Europe/Berlin', '2026-10-25T00:30:00Z', '2026-10-25'], // 02:30 CEST
  ['Europe/Berlin', '2026-10-25T01:00:00Z', '2026-10-25'], // 02:00 CET
  ['Europe/Berlin', '2026-10-25T01:30:00Z', '2026-10-25'], // 02:30 CET
  ['Europe/Berlin', '2026-10-25T22:59:59Z', '2026-10-25'],
  ['Europe/Berlin', '2026-10-25T23:00:00Z', '2026-10-26'],
  // America/Santiago fall-back at local midnight: Sat 2026-04-04 24:00 −03 → 23:00 −04 (03:00Z)
  ['America/Santiago', '2026-04-05T02:59:59Z', '2026-04-04'],
  ['America/Santiago', '2026-04-05T03:00:00Z', '2026-04-04'], // 23:00 −04, the repeated hour
  ['America/Santiago', '2026-04-05T03:59:59Z', '2026-04-04'],
  ['America/Santiago', '2026-04-05T04:00:00Z', '2026-04-05'],
  // America/Santiago spring-forward at local midnight: Sun 2026-09-06 00:00 −04 → 01:00 −03 (04:00Z)
  ['America/Santiago', '2026-09-06T03:59:59Z', '2026-09-05'],
  ['America/Santiago', '2026-09-06T04:00:00Z', '2026-09-06'], // first instant of Sep 6 (01:00 −03)
  ['America/Santiago', '2026-09-07T02:59:59Z', '2026-09-06'],
  ['America/Santiago', '2026-09-07T03:00:00Z', '2026-09-07'],
  // Australia/Sydney DST start, Sunday 2026-10-04 02:00 AEST → 03:00 AEDT
  ['Australia/Sydney', '2026-10-03T13:59:59Z', '2026-10-03'],
  ['Australia/Sydney', '2026-10-03T14:00:00Z', '2026-10-04'],
  ['Australia/Sydney', '2026-10-03T16:00:00Z', '2026-10-04'],
  // America/St_Johns 2010-11-07: fall-back at 00:01 NDT → 23:01 NST; the local date steps backwards
  ['America/St_Johns', '2010-11-07T02:29:59Z', '2010-11-06'],
  ['America/St_Johns', '2010-11-07T02:30:00Z', '2010-11-07'],
  ['America/St_Johns', '2010-11-07T02:30:59Z', '2010-11-07'],
  ['America/St_Johns', '2010-11-07T02:31:00Z', '2010-11-06'],
  ['America/St_Johns', '2010-11-07T03:29:59Z', '2010-11-06'],
  ['America/St_Johns', '2010-11-07T03:30:00Z', '2010-11-07'],
  // Fractional and extreme offsets
  ['Asia/Kolkata', '2026-06-14T18:29:59Z', '2026-06-14'], // +05:30
  ['Asia/Kolkata', '2026-06-14T18:30:00Z', '2026-06-15'],
  ['Pacific/Chatham', '2026-06-14T11:14:59Z', '2026-06-14'], // +12:45
  ['Pacific/Chatham', '2026-06-14T11:15:00Z', '2026-06-15'],
  ['Pacific/Chatham', '2026-01-14T10:14:59Z', '2026-01-14'], // +13:45 (DST)
  ['Pacific/Chatham', '2026-01-14T10:15:00Z', '2026-01-15'],
  ['Pacific/Kiritimati', '2026-06-14T09:59:59Z', '2026-06-14'], // +14
  ['Pacific/Kiritimati', '2026-06-14T10:00:00Z', '2026-06-15'],
  ['Pacific/Pago_Pago', '2026-06-15T10:59:59Z', '2026-06-14'], // −11
  ['Pacific/Pago_Pago', '2026-06-15T11:00:00Z', '2026-06-15'],
]

describe('bucketLabel — DST fixtures (unit: day)', () => {
  it.each(DST_CASES)('%s %s → %s', (tz, instant, label) => {
    expect(bucketLabel(at(instant), 'day', tz)).toBe(label)
    expect(bucketLabelUncached(at(instant), 'day', tz)).toBe(label)
    expect(bucketer('day', tz)(at(instant))).toBe(label)
  })

  it('the same instant differs by zone (Berlin vs UTC)', () => {
    expect(bucketLabel(at('2026-03-28T23:00:00Z'), 'day', 'Europe/Berlin')).toBe('2026-03-29')
    expect(bucketLabel(at('2026-03-28T23:00:00Z'), 'day', 'UTC')).toBe('2026-03-28')
    expect(bucketLabel(at('2026-03-28T23:00:00Z'), 'day')).toBe('2026-03-28')
  })
})

// Hour buckets: [tz, instant, local wall-clock hour label]. The label is the
// local hour, so a fall-back's repeated hour labels two UTC hours alike and a
// spring-forward's skipped hour labels none.
const HOUR_CASES: Array<[tz: string, instant: string, label: string]> = [
  ['UTC', '2026-03-29T00:00:00Z', '2026-03-29T00:00'],
  ['UTC', '2026-03-29T00:59:59.999Z', '2026-03-29T00:00'],
  ['UTC', '2026-03-29T23:59:59Z', '2026-03-29T23:00'],
  // Europe/Berlin spring-forward 2026-03-29: 02:00 CET → 03:00 CEST at 01:00Z (T02 never exists)
  ['Europe/Berlin', '2026-03-29T00:00:00Z', '2026-03-29T01:00'],
  ['Europe/Berlin', '2026-03-29T00:59:59Z', '2026-03-29T01:00'],
  ['Europe/Berlin', '2026-03-29T01:00:00Z', '2026-03-29T03:00'],
  ['Europe/Berlin', '2026-03-29T01:59:59Z', '2026-03-29T03:00'],
  ['Europe/Berlin', '2026-03-29T02:00:00Z', '2026-03-29T04:00'],
  // Europe/Berlin fall-back 2026-10-25: 03:00 CEST → 02:00 CET at 01:00Z (T02 covers 00:00Z–02:00Z)
  ['Europe/Berlin', '2026-10-24T23:59:59Z', '2026-10-25T01:00'],
  ['Europe/Berlin', '2026-10-25T00:00:00Z', '2026-10-25T02:00'], // 02:00 CEST
  ['Europe/Berlin', '2026-10-25T00:59:59Z', '2026-10-25T02:00'],
  ['Europe/Berlin', '2026-10-25T01:00:00Z', '2026-10-25T02:00'], // 02:00 CET, the repeat
  ['Europe/Berlin', '2026-10-25T01:59:59Z', '2026-10-25T02:00'],
  ['Europe/Berlin', '2026-10-25T02:00:00Z', '2026-10-25T03:00'],
  // America/New_York spring-forward 2026-03-08 (02:00 EST → 03:00 EDT at 07:00Z), fall-back 2026-11-01 (06:00Z)
  ['America/New_York', '2026-03-08T06:59:59Z', '2026-03-08T01:00'],
  ['America/New_York', '2026-03-08T07:00:00Z', '2026-03-08T03:00'],
  ['America/New_York', '2026-11-01T05:00:00Z', '2026-11-01T01:00'], // 01:00 EDT
  ['America/New_York', '2026-11-01T06:00:00Z', '2026-11-01T01:00'], // 01:00 EST, the repeat
  ['America/New_York', '2026-11-01T06:59:59Z', '2026-11-01T01:00'],
  ['America/New_York', '2026-11-01T07:00:00Z', '2026-11-01T02:00'],
  // Non-whole-hour offsets: the hour turns at :30 / :15 / :45 UTC
  ['Asia/Kolkata', '2026-06-14T04:29:59Z', '2026-06-14T09:00'], // +05:30
  ['Asia/Kolkata', '2026-06-14T04:30:00Z', '2026-06-14T10:00'],
  ['Asia/Kolkata', '2026-06-14T18:30:00Z', '2026-06-15T00:00'],
  ['Asia/Kathmandu', '2026-06-14T04:14:59Z', '2026-06-14T09:00'], // +05:45
  ['Asia/Kathmandu', '2026-06-14T04:15:00Z', '2026-06-14T10:00'],
  ['Asia/Kathmandu', '2026-06-14T18:15:00Z', '2026-06-15T00:00'],
  ['Pacific/Chatham', '2026-06-14T11:15:00Z', '2026-06-15T00:00'], // +12:45
  // America/St_Johns −03:30 / −02:30: spring-forward 2026-03-08 02:00 NST → 03:00 NDT at 05:30Z,
  // fall-back 2026-11-01 02:00 NDT → 01:00 NST at 04:30Z
  ['America/St_Johns', '2026-01-15T03:29:59Z', '2026-01-14T23:00'],
  ['America/St_Johns', '2026-01-15T03:30:00Z', '2026-01-15T00:00'],
  ['America/St_Johns', '2026-07-15T02:29:59Z', '2026-07-14T23:00'],
  ['America/St_Johns', '2026-07-15T02:30:00Z', '2026-07-15T00:00'],
  ['America/St_Johns', '2026-03-08T05:29:59Z', '2026-03-08T01:00'],
  ['America/St_Johns', '2026-03-08T05:30:00Z', '2026-03-08T03:00'],
  ['America/St_Johns', '2026-11-01T03:30:00Z', '2026-11-01T01:00'], // 01:00 NDT
  ['America/St_Johns', '2026-11-01T04:29:59Z', '2026-11-01T01:00'],
  ['America/St_Johns', '2026-11-01T04:30:00Z', '2026-11-01T01:00'], // 01:00 NST, the repeat
  ['America/St_Johns', '2026-11-01T05:30:00Z', '2026-11-01T02:00'],
  // Australia/Lord_Howe 30-minute DST shift 2026-10-04: 02:00 +10:30 → 02:30 +11 (15:30Z): T02 is half an hour
  ['Australia/Lord_Howe', '2026-10-03T15:29:59Z', '2026-10-04T01:00'],
  ['Australia/Lord_Howe', '2026-10-03T15:30:00Z', '2026-10-04T02:00'],
  ['Australia/Lord_Howe', '2026-10-03T15:59:59Z', '2026-10-04T02:00'],
  ['Australia/Lord_Howe', '2026-10-03T16:00:00Z', '2026-10-04T03:00'],
]

describe('bucketLabel — hour', () => {
  it.each(HOUR_CASES)('%s %s → %s', (tz, instant, label) => {
    expect(bucketLabel(at(instant), 'hour', tz)).toBe(label)
    expect(bucketLabelUncached(at(instant), 'hour', tz)).toBe(label)
    expect(bucketer('hour', tz)(at(instant))).toBe(label)
  })

  it('ignores the week start and labels the range edges', () => {
    expect(bucketLabel(at('2026-03-29T05:30:00Z'), 'hour', 'UTC', 'sun')).toBe('2026-03-29T05:00')
    expect(bucketLabel(BUCKET_MIN_INSTANT, 'hour')).toBe('1970-01-02T00:00')
    expect(bucketLabel(BUCKET_MIN_INSTANT, 'hour', 'Pacific/Pago_Pago')).toBe('1970-01-01T13:00')
    expect(bucketLabel(BUCKET_MAX_INSTANT - 1, 'hour')).toBe('2999-12-31T23:00')
    expect(bucketLabel(BUCKET_MAX_INSTANT - 1, 'hour', 'Pacific/Kiritimati')).toBe('3000-01-01T13:00')
    expect(bucketLabel(BUCKET_MIN_INSTANT - 1, 'hour')).toBeNull()
    expect(bucketLabel(1_774_746_000_000n, 'hour', 'Europe/Berlin')).toBe('2026-03-29T03:00')
  })
})

describe('bucketLabel — week', () => {
  it('week(mon) vs week(sun) at the Sunday-00:30-local row', () => {
    const t = at('2026-03-28T23:30:00Z') // Sun 2026-03-29 00:30 CET
    expect(bucketLabel(t, 'week', 'Europe/Berlin')).toBe('2026-03-23')
    expect(bucketLabel(t, 'week', 'Europe/Berlin', 'mon')).toBe('2026-03-23')
    expect(bucketLabel(t, 'week', 'Europe/Berlin', 'sun')).toBe('2026-03-29')
    expect(bucketLabel(t, 'week', 'UTC', 'sun')).toBe('2026-03-22') // still Saturday in UTC
  })

  it('7×7 week-start × weekday matrix', () => {
    // Mon 2026-03-23 … Sun 2026-03-29, at local noon
    const days = ['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29']
    const expected: Record<WeekStart, string[]> = {
      mon: ['2026-03-23', '2026-03-23', '2026-03-23', '2026-03-23', '2026-03-23', '2026-03-23', '2026-03-23'],
      tue: ['2026-03-17', '2026-03-24', '2026-03-24', '2026-03-24', '2026-03-24', '2026-03-24', '2026-03-24'],
      wed: ['2026-03-18', '2026-03-18', '2026-03-25', '2026-03-25', '2026-03-25', '2026-03-25', '2026-03-25'],
      thu: ['2026-03-19', '2026-03-19', '2026-03-19', '2026-03-26', '2026-03-26', '2026-03-26', '2026-03-26'],
      fri: ['2026-03-20', '2026-03-20', '2026-03-20', '2026-03-20', '2026-03-27', '2026-03-27', '2026-03-27'],
      sat: ['2026-03-21', '2026-03-21', '2026-03-21', '2026-03-21', '2026-03-21', '2026-03-28', '2026-03-28'],
      sun: ['2026-03-22', '2026-03-22', '2026-03-22', '2026-03-22', '2026-03-22', '2026-03-22', '2026-03-29'],
    }
    for (const ws of WEEK_STARTS) {
      const got = days.map(d => bucketLabel(at(`${d}T11:00:00Z`), 'week', 'Europe/Berlin', ws))
      expect(got, ws).toEqual(expected[ws])
      const week = bucketer('week', 'Europe/Berlin', ws)
      expect(days.map(d => week(at(`${d}T11:00:00Z`))), ws).toEqual(expected[ws])
    }
  })

  it('week labels cross the year boundary', () => {
    const thu = at('2026-12-31T12:00:00Z')
    const fri = at('2027-01-01T12:00:00Z')
    const sun = at('2027-01-03T12:00:00Z')
    expect(bucketLabel(thu, 'week', 'UTC', 'mon')).toBe('2026-12-28')
    expect(bucketLabel(thu, 'week', 'UTC', 'sun')).toBe('2026-12-27')
    expect(bucketLabel(thu, 'week', 'UTC', 'sat')).toBe('2026-12-26')
    expect(bucketLabel(fri, 'week', 'UTC', 'mon')).toBe('2026-12-28')
    expect(bucketLabel(fri, 'week', 'UTC', 'sat')).toBe('2026-12-26')
    expect(bucketLabel(fri, 'week', 'UTC', 'fri')).toBe('2027-01-01')
    expect(bucketLabel(sun, 'week', 'UTC', 'sun')).toBe('2027-01-03')
    expect(bucketLabel(sun, 'week', 'UTC', 'mon')).toBe('2026-12-28')
    expect(bucketLabel(sun, 'week', 'UTC', 'sat')).toBe('2027-01-02')
  })
})

describe('bucketLabel — month / quarter / year edges', () => {
  it('month edge in Berlin, UTC and New York', () => {
    expect(bucketLabel(at('2026-08-31T22:30:00Z'), 'month', 'Europe/Berlin')).toBe('2026-09-01')
    expect(bucketLabel(at('2026-08-31T22:30:00Z'), 'month', 'UTC')).toBe('2026-08-01')
    expect(bucketLabel(at('2026-09-01T02:00:00Z'), 'month', 'America/New_York')).toBe('2026-08-01')
    expect(bucketLabel(at('2026-09-01T02:00:00Z'), 'month', 'UTC')).toBe('2026-09-01')
  })

  it('year and quarter edge in Berlin vs UTC', () => {
    const t = at('2026-12-31T23:30:00Z')
    expect(bucketLabel(t, 'year', 'Europe/Berlin')).toBe('2027-01-01')
    expect(bucketLabel(t, 'quarter', 'Europe/Berlin')).toBe('2027-01-01')
    expect(bucketLabel(t, 'month', 'Europe/Berlin')).toBe('2027-01-01')
    expect(bucketLabel(t, 'quarter', 'UTC')).toBe('2026-10-01')
    expect(bucketLabel(t, 'year', 'UTC')).toBe('2026-01-01')
  })

  it('still Dec 31 in New York while already Jan 1 in UTC', () => {
    const t = at('2027-01-01T04:59:59Z') // 2026-12-31 23:59:59 EST
    for (const [unit, ny, utc] of [
      ['day', '2026-12-31', '2027-01-01'],
      ['month', '2026-12-01', '2027-01-01'],
      ['quarter', '2026-10-01', '2027-01-01'],
      ['year', '2026-01-01', '2027-01-01'],
    ] as const) {
      expect(bucketLabel(t, unit, 'America/New_York'), unit).toBe(ny)
      expect(bucketLabel(t, unit, 'UTC'), unit).toBe(utc)
    }
    expect(bucketLabel(at('2027-01-01T05:00:00Z'), 'year', 'America/New_York')).toBe('2027-01-01')
  })

  it('every quarter start', () => {
    const q = (iso: string) => bucketLabel(at(iso), 'quarter', 'UTC')
    expect(q('2026-01-01T00:00:00Z')).toBe('2026-01-01')
    expect(q('2026-03-31T23:59:59Z')).toBe('2026-01-01')
    expect(q('2026-04-01T00:00:00Z')).toBe('2026-04-01')
    expect(q('2026-06-30T12:00:00Z')).toBe('2026-04-01')
    expect(q('2026-07-01T00:00:00Z')).toBe('2026-07-01')
    expect(q('2026-09-30T12:00:00Z')).toBe('2026-07-01')
    expect(q('2026-10-01T00:00:00Z')).toBe('2026-10-01')
    expect(q('2026-12-31T23:59:59Z')).toBe('2026-10-01')
  })

  it('leap day', () => {
    expect(bucketLabel(at('2028-02-29T12:00:00Z'), 'day', 'UTC')).toBe('2028-02-29')
    expect(bucketLabel(at('2028-02-29T12:00:00Z'), 'month', 'UTC')).toBe('2028-02-01')
    expect(bucketLabel(at('2028-02-29T23:30:00Z'), 'day', 'Europe/Berlin')).toBe('2028-03-01')
  })
})

describe('bucketLabel — input and range guard', () => {
  it('returns null for null, undefined and non-numbers', () => {
    expect(bucketLabel(null, 'day')).toBeNull()
    expect(bucketLabel(undefined, 'day', 'Europe/Berlin')).toBeNull()
    expect(bucketLabel('1774738800000' as never, 'day')).toBeNull()
    expect(bucketLabel(Number.NaN, 'day')).toBeNull()
    expect(bucketLabel(Number.POSITIVE_INFINITY, 'day')).toBeNull()
  })

  it('returns null outside [1970-01-02T00:00:00Z, 3000-01-01T00:00:00Z)', () => {
    expect(BUCKET_MIN_INSTANT).toBe(Date.UTC(1970, 0, 2))
    expect(BUCKET_MAX_INSTANT).toBe(Date.UTC(3000, 0, 1))
    for (const tz of ['UTC', 'Europe/Berlin']) {
      expect(bucketLabel(0, 'day', tz)).toBeNull()
      expect(bucketLabel(-1, 'day', tz)).toBeNull()
      expect(bucketLabel(86_399_999, 'day', tz)).toBeNull()
      expect(bucketLabel(32_503_680_000_000, 'day', tz)).toBeNull()
    }
  })

  it('labels the range edges', () => {
    expect(bucketLabel(86_400_000, 'day', 'UTC')).toBe('1970-01-02')
    expect(bucketLabel(86_400_000, 'day', 'Pacific/Pago_Pago')).toBe('1970-01-01') // local date may precede the bound
    expect(bucketLabel(86_400_000, 'year', 'Europe/Berlin')).toBe('1970-01-01')
    expect(bucketLabel(32_503_679_999_999, 'day', 'UTC')).toBe('2999-12-31')
    expect(bucketLabel(32_503_679_999_999, 'day', 'Pacific/Kiritimati')).toBe('3000-01-01')
  })

  it('accepts bigint (e.g. SQLite safe-integer mode)', () => {
    expect(bucketLabel(1_774_738_800_000n, 'day', 'Europe/Berlin')).toBe('2026-03-29')
    expect(bucketLabel(0n, 'day')).toBeNull()
  })

  it('handles sub-second instants', () => {
    expect(bucketLabel(at('2026-03-28T22:59:59.999Z'), 'day', 'Europe/Berlin')).toBe('2026-03-28')
    expect(bucketLabel(at('2026-03-28T22:59:59.999Z') + 0.5, 'day', 'Europe/Berlin')).toBe('2026-03-28')
  })

  it('throws RangeError for an unknown unit, week start or zone', () => {
    expect(() => bucketLabel(at('2026-01-01T00:00:00Z'), 'minute' as BucketUnit)).toThrow(RangeError)
    expect(() => bucketLabel(at('2026-01-01T00:00:00Z'), 'week', 'UTC', 'sunday' as WeekStart)).toThrow(RangeError)
    expect(() => bucketLabel(at('2026-01-01T00:00:00Z'), 'week', 'UTC', 8 as never)).toThrow(RangeError)
    expect(() => bucketLabel(at('2026-01-01T00:00:00Z'), 'day', 'Mars/Olympus')).toThrow(RangeError)
  })
})

// ── Property test: window-cached kernel vs an independent Intl oracle ─────────

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const oracleFormatters = new Map<string, Intl.DateTimeFormat>()
function oracle(t: number, unit: BucketUnit, tz: string, ws: WeekStart): string {
  let f = oracleFormatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
    })
    oracleFormatters.set(tz, f)
  }
  const p: Record<string, number> = {}
  for (const part of f.formatToParts(t)) p[part.type] = Number(part.value)
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour))
  if (unit === 'hour') return d.toISOString().slice(0, 16)
  if (unit === 'week') {
    const wsJs = (WEEK_STARTS.indexOf(ws) + 1) % 7 // JS getUTCDay: 0 = Sunday
    while (d.getUTCDay() !== wsJs) d.setUTCDate(d.getUTCDate() - 1)
  } else if (unit === 'month') {
    d.setUTCDate(1)
  } else if (unit === 'quarter') {
    d.setUTCMonth(d.getUTCMonth() - (d.getUTCMonth() % 3), 1)
  } else if (unit === 'year') {
    d.setUTCMonth(0, 1)
  }
  return d.toISOString().slice(0, 10)
}

describe('bucketLabel — property test against an Intl oracle', () => {
  const zones = [
    'UTC', 'Europe/Berlin', 'Europe/London', 'Europe/Moscow', 'Europe/Kyiv', 'America/New_York',
    'America/Los_Angeles', 'America/Santiago', 'America/St_Johns', 'America/Sao_Paulo', 'America/Havana',
    'America/Asuncion', 'America/Godthab', 'Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Tehran', 'Asia/Gaza',
    'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney', 'Australia/Lord_Howe', 'Australia/Eucla',
    'Pacific/Chatham', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Pacific/Apia', 'Pacific/Auckland',
    'Africa/Casablanca', 'Africa/Cairo', 'Antarctica/Troll', 'Etc/GMT+12',
  ]
  const MIN = Date.UTC(1970, 0, 2)
  const MAX = Date.UTC(2100, 0, 1)

  it.each(zones)('%s: random and clustered instants 1970–2100', tz => {
    const rand = mulberry32(tz.length * 7919 + tz.charCodeAt(0))
    let checked = 0
    for (let i = 0; i < 150; i++) {
      // a random base, then a cluster of nearby instants to exercise cache hits and day edges
      const base = MIN + Math.floor(rand() * (MAX - MIN))
      for (let j = 0; j < 12; j++) {
        const t = Math.min(MAX, base + Math.floor((rand() - 0.5) * 3 * 86_400_000))
        if (t < MIN) continue
        const unit = BUCKET_UNITS[Math.floor(rand() * BUCKET_UNITS.length)]
        const ws = WEEK_STARTS[Math.floor(rand() * 7)]
        const expected = oracle(t, unit, tz, ws)
        const got = bucketLabel(t, unit, tz, ws)
        if (got !== expected) {
          throw new Error(`${tz} ${new Date(t).toISOString()} ${unit}/${ws}: got ${got}, expected ${expected}`)
        }
        checked++
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })

  it('every minute around the DST fixtures matches the oracle', () => {
    const windows: Array<[string, string]> = [
      ['Europe/Berlin', '2026-03-28T20:00:00Z'],
      ['Europe/Berlin', '2026-10-24T20:00:00Z'],
      ['America/Santiago', '2026-04-04T20:00:00Z'],
      ['America/Santiago', '2026-09-05T20:00:00Z'],
      ['America/St_Johns', '2010-11-06T20:00:00Z'],
      ['Pacific/Apia', '2011-12-29T00:00:00Z'], // Samoa skipped 2011-12-30
      ['Australia/Lord_Howe', '2026-10-03T12:00:00Z'], // 30-minute DST shift
    ]
    for (const [tz, start] of windows) {
      const t0 = at(start)
      for (let m = 0; m < 36 * 60; m += 1) {
        const t = t0 + m * 60_000
        expect(bucketLabel(t, 'day', tz)).toBe(oracle(t, 'day', tz, 'mon'))
        expect(bucketLabel(t, 'hour', tz)).toBe(oracle(t, 'hour', tz, 'mon'))
      }
    }
    // Transitions only ~6.96 days apart (the tightest pairs in tzdata 1970–2100)
    for (const [tz, start] of [
      ['America/Boa_Vista', '2000-10-05T00:00:00Z'],
      ['America/Noronha', '2000-10-05T00:00:00Z'],
      ['Asia/Gaza', '2040-10-16T00:00:00Z'],
    ] as const) {
      const t0 = at(start)
      for (let h = 0; h < 16 * 24; h++) {
        const t = t0 + h * 3_600_000 + 1_800_000
        expect(bucketLabel(t, 'day', tz), `${tz} ${new Date(t).toISOString()}`).toBe(oracle(t, 'day', tz, 'mon'))
      }
    }
    // Samoa's skipped day never appears
    expect(bucketLabel(at('2011-12-30T10:00:00Z'), 'day', 'Pacific/Apia')).toBe('2011-12-31')
    expect(bucketLabel(at('2011-12-30T09:59:59Z'), 'day', 'Pacific/Apia')).toBe('2011-12-29')
  })
})

// ── nextBucketLabel ──────────────────────────────────────────────────────────

describe('nextBucketLabel', () => {
  it('steps days across month, year and leap boundaries', () => {
    expect(nextBucketLabel('2026-03-29', 'day')).toBe('2026-03-30')
    expect(nextBucketLabel('2026-01-31', 'day')).toBe('2026-02-01')
    expect(nextBucketLabel('2026-12-31', 'day')).toBe('2027-01-01')
    expect(nextBucketLabel('2028-02-28', 'day')).toBe('2028-02-29')
    expect(nextBucketLabel('2028-02-29', 'day')).toBe('2028-03-01')
    expect(nextBucketLabel('2027-02-28', 'day')).toBe('2027-03-01')
    expect(nextBucketLabel('2100-02-28', 'day')).toBe('2100-03-01') // not a leap year
    expect(nextBucketLabel('2000-02-28', 'day')).toBe('2000-02-29') // is one
  })

  it('steps weeks, truncating a mid-week label with the week start', () => {
    expect(nextBucketLabel('2026-12-28', 'week')).toBe('2027-01-04')
    expect(nextBucketLabel('2026-12-31', 'week')).toBe('2027-01-04')
    expect(nextBucketLabel('2026-12-31', 'week', 'mon')).toBe('2027-01-04')
    expect(nextBucketLabel('2026-12-31', 'week', 'sun')).toBe('2027-01-03')
    expect(nextBucketLabel('2026-12-26', 'week', 'sat')).toBe('2027-01-02')
    expect(() => nextBucketLabel('2026-12-31', 'week', 7 as never)).toThrow(RangeError) // names only
  })

  it('steps months from any day of the month', () => {
    expect(nextBucketLabel('2026-01-01', 'month')).toBe('2026-02-01')
    expect(nextBucketLabel('2026-01-31', 'month')).toBe('2026-02-01')
    expect(nextBucketLabel('2028-02-29', 'month')).toBe('2028-03-01')
    expect(nextBucketLabel('2026-12-01', 'month')).toBe('2027-01-01')
    expect(nextBucketLabel('2026-12-31', 'month')).toBe('2027-01-01')
  })

  it('steps quarters and years', () => {
    expect(nextBucketLabel('2026-01-01', 'quarter')).toBe('2026-04-01')
    expect(nextBucketLabel('2026-05-31', 'quarter')).toBe('2026-07-01')
    expect(nextBucketLabel('2026-07-01', 'quarter')).toBe('2026-10-01')
    expect(nextBucketLabel('2026-11-15', 'quarter')).toBe('2027-01-01')
    expect(nextBucketLabel('2026-01-01', 'year')).toBe('2027-01-01')
    expect(nextBucketLabel('2028-02-29', 'year')).toBe('2029-01-01')
  })

  it('steps hours across day, month, year and leap boundaries', () => {
    expect(nextBucketLabel('2026-03-29T05:00', 'hour')).toBe('2026-03-29T06:00')
    expect(nextBucketLabel('2026-03-29T23:00', 'hour')).toBe('2026-03-30T00:00')
    expect(nextBucketLabel('2026-12-31T23:00', 'hour')).toBe('2027-01-01T00:00')
    expect(nextBucketLabel('2028-02-28T23:00', 'hour')).toBe('2028-02-29T00:00')
    expect(nextBucketLabel('2026-03-29', 'hour')).toBe('2026-03-29T01:00') // a date label is its 00 hour
    expect(nextBucketLabel('2026-03-29T05:00', 'day')).toBe('2026-03-30') // an hour label is its date
    expect(nextBucketLabel('2026-03-29T05:00', 'hour', 'sun')).toBe('2026-03-29T06:00') // week start ignored
  })

  it('without tz the hour step is zone-free; with tz it skips the hour a spring-forward removes', () => {
    expect(nextBucketLabel('2026-03-29T01:00', 'hour')).toBe('2026-03-29T02:00')
    expect(nextBucketLabel('2026-03-29T01:00', 'hour', { tz: 'Europe/Berlin' })).toBe('2026-03-29T03:00')
    expect(nextBucketLabel('2026-03-08T01:00', 'hour', { tz: 'America/New_York' })).toBe('2026-03-08T03:00')
    expect(nextBucketLabel('2026-03-08T01:00', 'hour', { tz: 'America/St_Johns' })).toBe('2026-03-08T03:00')
    // a repeated (fall-back) hour is one label: stepping over it is plain
    expect(nextBucketLabel('2026-10-25T01:00', 'hour', { tz: 'Europe/Berlin' })).toBe('2026-10-25T02:00')
    expect(nextBucketLabel('2026-10-25T02:00', 'hour', { tz: 'Europe/Berlin' })).toBe('2026-10-25T03:00')
    // a half-hour gap leaves the hour in place (Lord Howe 02:00 → 02:30)
    expect(nextBucketLabel('2026-10-04T01:00', 'hour', { tz: 'Australia/Lord_Howe' })).toBe('2026-10-04T02:00')
    // a skipped date (Samoa 2011-12-30), for hours and days
    expect(nextBucketLabel('2011-12-29T23:00', 'hour', { tz: 'Pacific/Apia' })).toBe('2011-12-31T00:00')
    expect(nextBucketLabel('2011-12-29', 'day', { tz: 'Pacific/Apia' })).toBe('2011-12-31')
    expect(nextBucketLabel('2011-12-29', 'day')).toBe('2011-12-30')
    // options object carries the week start too; tz is validated
    expect(nextBucketLabel('2026-12-31', 'week', { weekStart: 'sun', tz: 'Europe/Berlin' })).toBe('2027-01-03')
    expect(() => nextBucketLabel('2026-03-29T01:00', 'hour', { tz: 'Mars/Olympus' })).toThrow(RangeError)
  })

  it('fills gaps between labels without zone math', () => {
    const labels = ['2026-03-23']
    while (labels.length < 5) labels.push(nextBucketLabel(labels[labels.length - 1], 'week'))
    expect(labels).toEqual(['2026-03-23', '2026-03-30', '2026-04-06', '2026-04-13', '2026-04-20'])
  })

  it('agrees with bucketLabel: the next label is the bucket of the first instant after this one', () => {
    for (const unit of BUCKET_UNITS) {
      let label = bucketLabel(at('2026-01-01T00:00:00Z'), unit, 'UTC', 'wed')!
      for (let i = 0; i < 30; i++) {
        const next = nextBucketLabel(label, unit, 'wed')
        const start = bucketStartInstant(next)
        expect(bucketLabel(start - 1, unit, 'UTC', 'wed')).toBe(label)
        expect(bucketLabel(start, unit, 'UTC', 'wed')).toBe(next)
        label = next
      }
    }
  })

  it('throws RangeError for malformed labels', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-2-3', '26-01-01', 'x', '', '2026-01-01T00:00:00']) {
      expect(() => nextBucketLabel(bad, 'day'), bad).toThrow(RangeError)
    }
    expect(() => nextBucketLabel('2026-01-01', 'minute' as BucketUnit)).toThrow(RangeError)
    for (const bad of ['2026-01-01T24:00', '2026-01-01T7:00', '2026-01-01T07', '2026-01-01T07:30', '2026-02-30T01:00']) {
      expect(() => nextBucketLabel(bad, 'hour'), bad).toThrow(RangeError)
      expect(() => bucketStartInstant(bad, 'Europe/Berlin'), bad).toThrow(RangeError)
    }
  })
})

// ── bucketSeries ─────────────────────────────────────────────────────────────

describe('bucketSeries', () => {
  it('lists every bucket from the one holding first to the one holding last, inclusive', () => {
    expect(bucketSeries('2026-03-29T22:00', '2026-03-30T01:00', 'hour')).toEqual([
      '2026-03-29T22:00', '2026-03-29T23:00', '2026-03-30T00:00', '2026-03-30T01:00',
    ])
    expect(bucketSeries('2026-12-31', '2027-01-15', 'week', { weekStart: 'sun' })).toEqual(['2026-12-27', '2027-01-03', '2027-01-10'])
    expect(bucketSeries('2026-02-14', '2026-05-01', 'month')).toEqual(['2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'])
    expect(bucketSeries('2026-03-29', '2026-03-29', 'day')).toEqual(['2026-03-29'])
    expect(bucketSeries('2026-03-30', '2026-03-29', 'day')).toEqual([])
  })

  it('with tz, leaves out the labels that never occur in the zone', () => {
    expect(bucketSeries('2026-03-29T00:00', '2026-03-29T04:00', 'hour', { tz: 'Europe/Berlin' })).toEqual([
      '2026-03-29T00:00', '2026-03-29T01:00', '2026-03-29T03:00', '2026-03-29T04:00',
    ])
    expect(bucketSeries('2026-03-29T00:00', '2026-03-29T04:00', 'hour')).toHaveLength(5)
    expect(bucketSeries('2011-12-29', '2011-12-31', 'day', { tz: 'Pacific/Apia' })).toEqual(['2011-12-29', '2011-12-31'])
    expect(bucketSeries('2026-09-05', '2026-09-07', 'day', { tz: 'America/Santiago' })).toEqual(['2026-09-05', '2026-09-06', '2026-09-07'])
  })

  it('guards the length', () => {
    expect(bucketSeries('2026-01-01T00:00', '2026-01-01T09:00', 'hour', { maxLength: 10 })).toHaveLength(10)
    expect(() => bucketSeries('2026-01-01T00:00', '2026-01-01T10:00', 'hour', { maxLength: 10 })).toThrow(RangeError)
    expect(() => bucketSeries('2000-01-01T00:00', '2030-01-01T00:00', 'hour')).toThrow(RangeError) // > 100 000
    expect(() => bucketSeries('2026-01-01', 'x', 'day')).toThrow(RangeError)
  })

  it('a year of hours with tz is exactly the labelled set, and every label round-trips with bucketStartInstant', () => {
    for (const tz of ['Europe/Berlin', 'America/New_York', 'America/St_Johns', 'Asia/Kathmandu', 'Australia/Lord_Howe']) {
      const seen = new Set<string>()
      for (let t = at('2026-01-01T00:00:00Z'); t < at('2027-01-01T00:00:00Z'); t += 15 * 60_000) seen.add(bucketLabel(t, 'hour', tz)!)
      const first = bucketLabel(at('2026-01-01T00:00:00Z'), 'hour', tz)!
      const last = bucketLabel(at('2027-01-01T00:00:00Z') - 1, 'hour', tz)!
      const series = bucketSeries(first, last, 'hour', { tz })
      expect(series, tz).toEqual([...seen].toSorted())
      for (const label of series) {
        const start = bucketStartInstant(label, tz)
        expect(bucketLabel(start, 'hour', tz), `${tz} ${label}`).toBe(label)
        expect(bucketLabel(start - 1, 'hour', tz), `${tz} ${label}`).not.toBe(label)
      }
    }
  })
})

// ── bucketStartInstant ───────────────────────────────────────────────────────

describe('bucketStartInstant', () => {
  it('UTC is the date at 00:00Z', () => {
    expect(bucketStartInstant('2026-03-29')).toBe(at('2026-03-29T00:00:00Z'))
    expect(bucketStartInstant('2026-03-29', 'UTC')).toBe(at('2026-03-29T00:00:00Z'))
  })

  it('local midnight across Berlin DST days', () => {
    expect(bucketStartInstant('2026-03-29', 'Europe/Berlin')).toBe(at('2026-03-28T23:00:00Z'))
    expect(bucketStartInstant('2026-03-30', 'Europe/Berlin')).toBe(at('2026-03-29T22:00:00Z'))
    expect(bucketStartInstant('2026-10-25', 'Europe/Berlin')).toBe(at('2026-10-24T22:00:00Z'))
    expect(bucketStartInstant('2026-10-26', 'Europe/Berlin')).toBe(at('2026-10-25T23:00:00Z'))
  })

  it('a midnight DST gap resolves to the transition instant (America/Santiago 2026-09-06)', () => {
    expect(bucketStartInstant('2026-09-06', 'America/Santiago')).toBe(at('2026-09-06T04:00:00Z'))
    expect(bucketStartInstant('2026-09-07', 'America/Santiago')).toBe(at('2026-09-07T03:00:00Z'))
  })

  it('a midnight fall-back (America/Santiago 2026-04-05) has one midnight', () => {
    expect(bucketStartInstant('2026-04-04', 'America/Santiago')).toBe(at('2026-04-04T03:00:00Z'))
    expect(bucketStartInstant('2026-04-05', 'America/Santiago')).toBe(at('2026-04-05T04:00:00Z'))
  })

  it('when the local date repeats, returns its first occurrence (America/St_Johns 2010-11-07)', () => {
    expect(bucketStartInstant('2010-11-07', 'America/St_Johns')).toBe(at('2010-11-07T02:30:00Z'))
  })

  it('fractional and extreme offsets', () => {
    expect(bucketStartInstant('2026-06-15', 'Asia/Kolkata')).toBe(at('2026-06-14T18:30:00Z'))
    expect(bucketStartInstant('2026-06-15', 'Pacific/Chatham')).toBe(at('2026-06-14T11:15:00Z'))
    expect(bucketStartInstant('2026-06-15', 'Pacific/Kiritimati')).toBe(at('2026-06-14T10:00:00Z'))
    expect(bucketStartInstant('2026-06-15', 'Pacific/Pago_Pago')).toBe(at('2026-06-15T11:00:00Z'))
  })

  it('round-trips with bucketLabel: first instant of the day, and the instant before is the previous day', () => {
    const zones = ['Europe/Berlin', 'America/Santiago', 'America/Havana', 'Asia/Tehran', 'Australia/Lord_Howe', 'Pacific/Apia']
    for (const tz of zones) {
      let label = '2026-01-01'
      for (let i = 0; i < 365; i++) {
        const start = bucketStartInstant(label, tz)
        expect(bucketLabel(start, 'day', tz), `${tz} ${label}`).toBe(label)
        expect(bucketLabel(start - 1, 'day', tz), `${tz} ${label}`).not.toBe(label)
        label = nextBucketLabel(label, 'day')
      }
    }
  })

  it('hour labels: the first instant of the local hour', () => {
    expect(bucketStartInstant('2026-03-29T05:00')).toBe(at('2026-03-29T05:00:00Z'))
    expect(bucketStartInstant('2026-06-14T10:00', 'Asia/Kolkata')).toBe(at('2026-06-14T04:30:00Z'))
    expect(bucketStartInstant('2026-06-14T10:00', 'Asia/Kathmandu')).toBe(at('2026-06-14T04:15:00Z'))
    expect(bucketStartInstant('2026-01-15T00:00', 'America/St_Johns')).toBe(at('2026-01-15T03:30:00Z'))
    expect(bucketStartInstant('2026-07-15T00:00', 'America/St_Johns')).toBe(at('2026-07-15T02:30:00Z'))
  })

  it('a repeated hour starts at its first occurrence; a skipped hour at the transition', () => {
    expect(bucketStartInstant('2026-10-25T02:00', 'Europe/Berlin')).toBe(at('2026-10-25T00:00:00Z'))
    expect(bucketStartInstant('2026-10-25T03:00', 'Europe/Berlin')).toBe(at('2026-10-25T02:00:00Z'))
    expect(bucketStartInstant('2026-11-01T01:00', 'America/New_York')).toBe(at('2026-11-01T05:00:00Z'))
    expect(bucketStartInstant('2026-11-01T01:00', 'America/St_Johns')).toBe(at('2026-11-01T03:30:00Z'))
    expect(bucketStartInstant('2026-03-29T02:00', 'Europe/Berlin')).toBe(at('2026-03-29T01:00:00Z'))
    expect(bucketStartInstant('2026-03-29T03:00', 'Europe/Berlin')).toBe(at('2026-03-29T01:00:00Z'))
    expect(bucketStartInstant('2026-03-08T02:00', 'America/St_Johns')).toBe(at('2026-03-08T05:30:00Z'))
    expect(bucketStartInstant('2026-10-04T02:00', 'Australia/Lord_Howe')).toBe(at('2026-10-03T15:30:00Z'))
  })

  it('throws RangeError for a malformed label', () => {
    expect(() => bucketStartInstant('2026-02-30', 'Europe/Berlin')).toThrow(RangeError)
  })
})

// ── Time zones ───────────────────────────────────────────────────────────────

/** The canonical spelling `checkTimeZone` accepts `tz` as, or undefined. */
function canonicalZone(tz: string): string | undefined {
  const res = checkTimeZone(tz)
  return res.ok ? res.tz : undefined
}

describe('checkTimeZone', () => {
  it("'UTC' in any case → 'UTC'", () => {
    for (const tz of ['UTC', 'utc', 'Utc', 'uTC']) expect(canonicalZone(tz)).toBe('UTC')
  })

  it('canonicalizes case to the listed spelling', () => {
    expect(canonicalZone('europe/berlin')).toBe('Europe/Berlin')
    expect(canonicalZone('EUROPE/BERLIN')).toBe('Europe/Berlin')
    expect(canonicalZone('america/port-au-prince')).toBe('America/Port-au-Prince')
    expect(canonicalZone('america/argentina/buenos_aires')).toBe('America/Argentina/Buenos_Aires')
    expect(checkTimeZone('Europe/Berlin')).toEqual({ ok: true, tz: 'Europe/Berlin' })
  })

  it('accepts current IANA spellings of renamed zones and rejects the old ones', () => {
    expect(canonicalZone('asia/kolkata')).toBe('Asia/Kolkata')
    expect(canonicalZone('Europe/Kyiv')).toBe('Europe/Kyiv')
    expect(canonicalZone('Asia/Ho_Chi_Minh')).toBe('Asia/Ho_Chi_Minh')
    expect(checkTimeZone('Asia/Calcutta')).toEqual({
      ok: false,
      message: 'Time zone "Asia/Calcutta" is an alias — use "Asia/Kolkata"',
    })
    expect(checkTimeZone('europe/kiev')).toEqual({
      ok: false,
      message: 'Time zone "europe/kiev" is an alias — use "Europe/Kyiv"',
    })
  })

  it('accepts fixed-offset Etc/GMT±N zones', () => {
    expect(canonicalZone('Etc/GMT+5')).toBe('Etc/GMT+5')
    expect(canonicalZone('etc/gmt-14')).toBe('Etc/GMT-14')
    expect(bucketLabel(at('2026-06-15T04:59:59Z'), 'day', 'Etc/GMT+5')).toBe('2026-06-14')
  })

  it('rejects aliases with a hint naming the canonical zone', () => {
    expect(checkTimeZone('US/Eastern')).toEqual({
      ok: false,
      message: 'Time zone "US/Eastern" is an alias — use "America/New_York"',
    })
    expect(checkTimeZone('Etc/UTC')).toEqual({ ok: false, message: 'Time zone "Etc/UTC" is an alias — use "UTC"' })
    expect(checkTimeZone('GMT')).toEqual({ ok: false, message: 'Time zone "GMT" is an alias — use "UTC"' })
    expect(canonicalZone('US/Eastern')).toBeUndefined()
  })

  it('rejects abbreviations', () => {
    for (const tz of ['CET', 'EST', 'PST8PDT']) {
      const res = checkTimeZone(tz)
      expect(res.ok, tz).toBe(false)
      expect(!res.ok && res.message, tz).toMatch(new RegExp(`^(Time zone "${tz}" is an alias|Unknown time zone "${tz}")`))
    }
  })

  it('rejects unknown names and offsets', () => {
    expect(checkTimeZone('Mars/Olympus')).toEqual({ ok: false, message: 'Unknown time zone "Mars/Olympus"' })
    expect(checkTimeZone('+0200')).toEqual({ ok: false, message: 'Unknown time zone "+0200"' })
    expect(checkTimeZone('+02:00')).toEqual({
      ok: false,
      message: 'Invalid time zone "+02:00" — use an IANA name such as "Europe/Berlin"',
    })
  })

  it('rejects anything outside the SQL-safe charset', () => {
    for (const tz of [
      "UTC'; DROP TABLE x;--",
      "Europe/Berlin'",
      'Europe/Berlin ',
      'Europe\\Berlin',
      'Europe/Berlin"',
      'Europe/Berlin\n',
      '',
      'A'.repeat(65),
    ]) {
      expect(checkTimeZone(tz)).toEqual({
        ok: false,
        message: `Invalid time zone "${tz}" — use an IANA name such as "Europe/Berlin"`,
      })
    }
  })

  it('rejects non-strings', () => {
    expect(checkTimeZone(undefined)).toEqual({ ok: false, message: 'Time zone must be a string' })
    expect(checkTimeZone(1)).toEqual({ ok: false, message: 'Time zone must be a string' })
  })

  it('every listed runtime zone is accepted as-is or rejected as a renamed alias whose hint is accepted', () => {
    for (const tz of Intl.supportedValuesOf('timeZone')) {
      const res = checkTimeZone(tz)
      if (res.ok) {
        expect(res.tz).toBe(tz)
        expect(TIME_ZONE_NAME_RE.test(res.tz)).toBe(true)
        expect(typeof bucketLabel(at('2026-06-15T12:00:00Z'), 'day', res.tz)).toBe('string')
      } else {
        const hint = /use "([^"]+)"$/.exec(res.message)?.[1]
        expect(hint, tz).toBeDefined()
        expect(canonicalZone(hint!), tz).toBe(hint)
      }
    }
  })
})

describe('week start', () => {
  it('accepts WeekStart names only, and only for unit "week"', () => {
    const t = at('2026-01-01T12:00:00Z')
    for (const bad of [0, 1, 7, 'constructor', 'sunday', 'Sun']) {
      expect(() => bucketer('week', 'UTC', bad as never), String(bad)).toThrow(RangeError)
      expect(() => bucketLabel(t, 'week', 'Europe/Berlin', bad as never), String(bad)).toThrow(RangeError)
      expect(() => nextBucketLabel('2026-01-01', 'week', bad as never), String(bad)).toThrow(RangeError)
    }
    // ignored by the other units
    expect(bucketer('day', 'UTC', 'bogus' as never)(t)).toBe('2026-01-01')
    expect(bucketLabel(t, 'month', 'UTC', 'bogus' as never)).toBe('2026-01-01')
    expect(nextBucketLabel('2026-01-01', 'year', 'bogus' as never)).toBe('2027-01-01')
  })
})

// ── bucketer ─────────────────────────────────────────────────────────────────

describe('bucketer', () => {
  it('matches bucketLabel (and the uncached path) for every unit and week start around the DST fixtures', () => {
    const zones = [...new Set(DST_CASES.map(([tz]) => tz)), 'UTC']
    for (const unit of BUCKET_UNITS) {
      for (const ws of WEEK_STARTS) {
        for (const tz of zones) {
          const label = bucketer(unit, tz, ws)
          for (const [caseTz, instant] of DST_CASES) {
            if (caseTz !== tz && tz !== 'UTC') continue
            for (const d of [-86_400_000, -3_600_000, -1, 0, 1, 3_600_000, 86_400_000]) {
              const t = at(instant) + d
              const expected = bucketLabelUncached(t, unit, tz, ws)
              const msg = `${unit}/${ws} ${tz} ${new Date(t).toISOString()}`
              expect(label(t), msg).toBe(expected)
              expect(bucketLabel(t, unit, tz, ws), msg).toBe(expected)
            }
          }
        }
      }
    }
  })

  it('defaults to UTC and a Monday week start', () => {
    const t = at('2026-03-28T23:30:00Z')
    expect(bucketer('week')(t)).toBe(bucketLabel(t, 'week', 'UTC', 'mon'))
    expect(bucketer('day')(t)).toBe('2026-03-28')
  })

  it("has bucketLabel's input contract", () => {
    const label = bucketer('day', 'Europe/Berlin')
    expect(label(null)).toBeNull()
    expect(label(undefined)).toBeNull()
    expect(label('1774738800000' as never)).toBeNull()
    expect(label(Number.NaN)).toBeNull()
    expect(label(0)).toBeNull()
    expect(label(BUCKET_MAX_INSTANT)).toBeNull()
    expect(label(1_774_738_800_000n)).toBe('2026-03-29')
  })

  it('throws RangeError up front for an unknown unit, zone or week start', () => {
    expect(() => bucketer('minute' as BucketUnit)).toThrow(RangeError)
    expect(() => bucketer('day', 'Mars/Olympus')).toThrow(RangeError)
    expect(() => bucketer('week', 'UTC', 'sunday' as WeekStart)).toThrow(RangeError)
  })

  it('keeps working after its zone is evicted from the zone cache', () => {
    const label = bucketer('day', 'Asia/Tokyo')
    expect(label(at('2026-06-14T15:00:00Z'))).toBe('2026-06-15')
    // touch more zones than the cache holds
    for (const tz of Intl.supportedValuesOf('timeZone').slice(0, 64)) bucketLabel(at('2026-06-14T12:00:00Z'), 'day', tz)
    expect(label(at('2026-06-14T14:59:59Z'))).toBe('2026-06-14')
    expect(label(at('2026-06-14T15:00:00Z'))).toBe('2026-06-15')
    expect(bucketLabel(at('2026-06-14T15:00:00Z'), 'day', 'Asia/Tokyo')).toBe('2026-06-15')
  })
})

describe('label cache', () => {
  it('a fresh module labels day -1 (1969-12-31) correctly', async () => {
    vi.resetModules()
    const fresh = await import('./calendar')
    expect(fresh.bucketLabel(at('2026-01-01T00:00:00Z'), 'day')).toBe('2026-01-01') // allocates the cache
    // 1970-01-02 (Fri) in a Wednesday-start week → 1969-12-31, day number -1
    expect(fresh.bucketLabel(BUCKET_MIN_INSTANT, 'week', 'UTC', 'wed')).toBe('1969-12-31')
  })
})
