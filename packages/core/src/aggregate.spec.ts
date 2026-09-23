import { describe, it, expect } from 'vitest'
import {
  groupByFields,
  isAggregateExpr,
  isBucketExpr,
  resolveAlias,
  resolveBuckets,
} from './aggregate'
import { WEEK_STARTS } from './calendar'
import type { BucketExpr } from './types'

describe('type guards', () => {
  it('isAggregateExpr: $fn + $field strings, no $bucket', () => {
    expect(isAggregateExpr({ $fn: 'sum', $field: 'amount' })).toBe(true)
    expect(isAggregateExpr({ $fn: 'count', $field: '*', $as: 'n' })).toBe(true)
    expect(isAggregateExpr({ $fn: 'sum' })).toBe(false)
    expect(isAggregateExpr({ $bucket: 'day', $field: 'at' })).toBe(false)
    expect(isAggregateExpr({ $fn: 'sum', $bucket: 'day', $field: 'at' })).toBe(false)
    expect(isAggregateExpr('amount')).toBe(false)
    expect(isAggregateExpr(null)).toBe(false)
  })

  it('isBucketExpr: $bucket + $field strings, no $fn', () => {
    expect(isBucketExpr({ $bucket: 'day', $field: 'at' })).toBe(true)
    expect(isBucketExpr({ $bucket: 'fortnight', $field: 'at' })).toBe(true) // shape only; validation rejects the unit
    expect(isBucketExpr({ $bucket: 'day' })).toBe(false)
    expect(isBucketExpr({ $bucket: 1, $field: 'at' })).toBe(false)
    expect(isBucketExpr({ $fn: 'sum', $field: 'at' })).toBe(false)
    expect(isBucketExpr({ $fn: 'sum', $bucket: 'day', $field: 'at' })).toBe(false)
    expect(isBucketExpr(undefined)).toBe(false)
  })
})

describe('resolveAlias', () => {
  it('prefers $as', () => {
    expect(resolveAlias({ $fn: 'sum', $field: 'amount', $as: 'total' })).toBe('total')
    expect(resolveAlias({ $bucket: 'week', $field: 'openedAt', $as: 'wk' })).toBe('wk')
  })

  it('defaults to {fn}_{field} / {unit}_{field}', () => {
    expect(resolveAlias({ $fn: 'sum', $field: 'amount' })).toBe('sum_amount')
    expect(resolveAlias({ $bucket: 'week', $field: 'openedAt' })).toBe('week_openedAt')
  })

  it("spells '*' as star, matching the URL parser (count(*) → count_star)", () => {
    expect(resolveAlias({ $fn: 'count', $field: '*' })).toBe('count_star')
  })
})

describe('groupByFields', () => {
  it('maps bucket aliases to their source field and keeps plain fields', () => {
    expect(
      groupByFields({
        $select: [
          { $bucket: 'day', $field: 'openedAt', $as: 'day' },
          { $bucket: 'month', $field: 'closedAt' },
          'status',
          { $fn: 'count', $field: '*', $as: 'n' },
        ],
        $groupBy: ['day', 'status', 'month_closedAt'],
      }),
    ).toEqual(['openedAt', 'status', 'closedAt'])
  })

  it('deduplicates and skips non-strings', () => {
    expect(
      groupByFields({
        $select: [{ $bucket: 'day', $field: 'openedAt', $as: 'day' }],
        $groupBy: ['day', 'openedAt', 5, 'day'],
      }),
    ).toEqual(['openedAt'])
  })

  it('does not map aggregate aliases (they are not grouping keys)', () => {
    expect(
      groupByFields({ $select: [{ $fn: 'sum', $field: 'amount', $as: 'total' }], $groupBy: ['total'] }),
    ).toEqual(['total'])
  })

  it('returns [] without $groupBy', () => {
    expect(groupByFields({})).toEqual([])
    expect(groupByFields(undefined)).toEqual([])
  })
})

describe('resolveBuckets — one bucket', () => {
  /** The resolved bucket of a single valid `BucketExpr`, grouped by its alias. */
  const ok = (e: Partial<BucketExpr> & Record<string, unknown>) => {
    const expr = { $bucket: 'day', $field: 'openedAt', ...e } as BucketExpr
    const res = resolveBuckets({ $select: [expr], $groupBy: [resolveAlias(expr)] })
    if (!res.ok) throw new Error(res.issues[0].message)
    expect(res.buckets).toHaveLength(1)
    return res.buckets[0]
  }
  /** The single issue of an invalid `BucketExpr`. */
  const fail = (e: Partial<BucketExpr> & Record<string, unknown>) => {
    const res = resolveBuckets({ $select: [{ $bucket: 'day', $field: 'openedAt', ...e }] }, { aggregate: true })
    if (res.ok) throw new Error('expected a validation failure')
    expect(res.issues).toHaveLength(1)
    return res.issues[0].message
  }

  it('normalizes defaults', () => {
    expect(ok({})).toEqual({
      alias: 'day_openedAt',
      field: 'openedAt',
      unit: 'day',
      tz: 'UTC',
      weekStart: 'mon',
      weekStartIso: 1,
    })
  })

  it('resolves every week start to its ISO weekday', () => {
    expect(WEEK_STARTS.map(ws => ok({ $bucket: 'week', $weekStart: ws }).weekStartIso)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(ok({ $bucket: 'week' })).toMatchObject({ weekStart: 'mon', weekStartIso: 1 })
  })

  it('canonicalizes the time zone and resolves the week start', () => {
    expect(ok({ $bucket: 'week', $tz: 'europe/berlin', $weekStart: 'sun', $as: 'wk' })).toEqual({
      alias: 'wk',
      field: 'openedAt',
      unit: 'week',
      tz: 'Europe/Berlin',
      weekStart: 'sun',
      weekStartIso: 7,
    })
  })

  it('rejects an unknown unit', () => {
    expect(fail({ $bucket: 'fortnight' as never })).toBe(
      'Unknown bucket unit "fortnight" — use day, week, month, quarter or year',
    )
    expect(fail({ $bucket: 'hour' as never })).toMatch(/^Unknown bucket unit "hour"/)
  })

  it('rejects an empty $field', () => {
    expect(fail({ $field: '' })).toBe('Bucket needs a $field')
  })

  it('rejects bad time zones with the checkTimeZone message', () => {
    expect(fail({ $tz: 'Mars/Olympus' })).toBe('Unknown time zone "Mars/Olympus"')
    expect(fail({ $tz: 'US/Eastern' })).toBe('Time zone "US/Eastern" is an alias — use "America/New_York"')
    expect(fail({ $tz: 5 as never })).toBe('Time zone must be a string')
  })

  it('rejects an unknown week start, and a week start on a non-week unit', () => {
    expect(fail({ $bucket: 'week', $weekStart: 'sunday' as never })).toBe(
      'Unknown week start "sunday" — use mon, tue, wed, thu, fri, sat or sun',
    )
    expect(fail({ $bucket: 'month', $weekStart: 'sun' })).toBe(
      '$weekStart is only valid with unit "week", not "month"',
    )
    expect(fail({ $bucket: 'day', $weekStart: 'mon' })).toMatch(/only valid with unit "week"/)
  })

  it('rejects malformed aliases', () => {
    for (const bad of ['a.b', '1day', 'day-1', '', 'da y']) {
      expect(fail({ $as: bad })).toBe(
        `Invalid alias "${bad}" — use letters, digits and underscores, not starting with a digit`,
      )
    }
    expect(fail({ $as: 7 as never })).toMatch(/^Invalid alias "7"/)
    expect(fail({ $as: null as never })).toMatch(/^Invalid alias "null"/)
    expect(ok({ $as: '_day2' }).alias).toBe('_day2')
  })

  it('requires an explicit $as for a dotted source', () => {
    expect(fail({ $field: 'stats.firstSeenAt' })).toBe('Bucket over "stats.firstSeenAt" needs an explicit $as')
    expect(ok({ $field: 'stats.firstSeenAt', $as: 'firstSeen' })).toMatchObject({
      alias: 'firstSeen',
      field: 'stats.firstSeenAt',
    })
  })
})

describe('resolveBuckets', () => {
  it('returns the normalized buckets of a valid grouped query', () => {
    const res = resolveBuckets({
      $select: [
        { $bucket: 'week', $field: 'openedAt', $tz: 'Europe/Berlin', $weekStart: 'sun', $as: 'week' },
        'status',
        { $fn: 'count', $field: '*', $as: 'n' },
      ],
      $groupBy: ['week', 'status'],
    })
    expect(res).toEqual({
      ok: true,
      buckets: [
        { alias: 'week', field: 'openedAt', unit: 'week', tz: 'Europe/Berlin', weekStart: 'sun', weekStartIso: 7 },
      ],
    })
  })

  it('is ok with no buckets, object-form $select, or no controls', () => {
    expect(resolveBuckets({ $select: ['a', { $fn: 'sum', $field: 'b' }], $groupBy: ['a'] })).toEqual({
      ok: true,
      buckets: [],
    })
    expect(resolveBuckets({ $select: { a: 1 } })).toEqual({ ok: true, buckets: [] })
    expect(resolveBuckets(undefined)).toEqual({ ok: true, buckets: [] })
  })

  it('collects entry-level issues', () => {
    const res = resolveBuckets({
      $select: [{ $bucket: 'fortnight', $field: 'a', $as: 'x' }, { $bucket: 'day', $field: 'b', $tz: 'CET', $as: 'y' }],
      $groupBy: ['x', 'y'],
    })
    expect(res).toEqual({
      ok: false,
      issues: [
        { path: '$select', message: 'Unknown bucket unit "fortnight" — use day, week, month, quarter or year' },
        { path: '$select', message: 'Time zone "CET" is an alias — use "Europe/Brussels"' },
      ],
    })
  })

  it('rejects unsupported $select entries (instead of silently dropping them)', () => {
    const res = resolveBuckets({
      $select: ['a', { $field: 'b' }, 42, null, { $fn: 'sum', $bucket: 'day', $field: 'c' }],
      $groupBy: ['a'],
    })
    expect(res.ok).toBe(false)
    expect(!res.ok && res.issues).toEqual([
      { path: '$select', message: 'Unsupported $select entry at index 1' },
      { path: '$select', message: 'Unsupported $select entry at index 2' },
      { path: '$select', message: 'Unsupported $select entry at index 3' },
      { path: '$select', message: 'Unsupported $select entry at index 4' },
    ])
  })

  it('allows buckets only in aggregate mode', () => {
    const sel = [{ $bucket: 'day', $field: 'openedAt', $as: 'day' }]
    expect(resolveBuckets({ $select: sel })).toEqual({
      ok: false,
      issues: [{ path: '$select', message: 'Calendar buckets are only valid in grouped queries' }],
    })
    expect(resolveBuckets({ $select: sel, $groupBy: [] }).ok).toBe(false)
    // the caller's explicit mode wins
    expect(resolveBuckets({ $select: sel, $groupBy: ['day'] }, { aggregate: false }).ok).toBe(false)
    expect(resolveBuckets({ $select: sel, $groupBy: ['day'] }, { aggregate: true }).ok).toBe(true)
    // an invalid bucket outside aggregate mode reports both problems
    const res = resolveBuckets({ $select: [{ $bucket: 'eon', $field: 'openedAt' }] })
    expect(!res.ok && res.issues.map(i => i.message)).toEqual([
      'Unknown bucket unit "eon" — use day, week, month, quarter or year',
      'Calendar buckets are only valid in grouped queries',
    ])
  })

  it('requires each bucket alias in $groupBy', () => {
    const res = resolveBuckets({
      $select: [{ $bucket: 'day', $field: 'openedAt', $as: 'day' }, { $bucket: 'week', $field: 'openedAt' }, 'status'],
      $groupBy: ['status', 'week_openedAt'],
    })
    expect(res).toEqual({
      ok: false,
      issues: [{ path: '$select', message: 'Bucket "day" in $select must also appear in $groupBy' }],
    })
  })

  it('rejects duplicate aliases and a bucket alias that repeats a selected field', () => {
    const dup = resolveBuckets({
      $select: [
        { $bucket: 'day', $field: 'openedAt', $as: 'd' },
        { $bucket: 'week', $field: 'openedAt', $as: 'd' },
      ],
      $groupBy: ['d'],
    })
    expect(!dup.ok && dup.issues).toEqual([{ path: '$select', message: 'Duplicate alias "d"' }])

    const vsAggregate = resolveBuckets({
      $select: [{ $fn: 'count', $field: '*', $as: 'n' }, { $bucket: 'day', $field: 'openedAt', $as: 'n' }],
      $groupBy: ['n'],
    })
    expect(!vsAggregate.ok && vsAggregate.issues).toEqual([{ path: '$select', message: 'Duplicate alias "n"' }])

    const vsDefaultAggregate = resolveBuckets({
      $select: [{ $fn: 'count', $field: '*' }, { $bucket: 'day', $field: 'x', $as: 'count_star' }],
      $groupBy: ['count_star'],
    })
    expect(!vsDefaultAggregate.ok && vsDefaultAggregate.issues).toEqual([
      { path: '$select', message: 'Duplicate alias "count_star"' },
    ])

    const vsField = resolveBuckets({
      $select: ['status', { $bucket: 'day', $field: 'openedAt', $as: 'status' }],
      $groupBy: ['status'],
    })
    expect(!vsField.ok && vsField.issues).toEqual([
      { path: '$select', message: 'Alias "status" collides with field "status"' },
    ])
  })

  it('checks alias collisions against the caller\'s field universe (isField)', () => {
    const controls = {
      $select: ['status', { $bucket: 'day', $field: 'openedAt', $as: 'createdAt' }],
      $groupBy: ['status', 'createdAt'],
    }
    // default: only the selected plain fields count
    expect(resolveBuckets(controls).ok).toBe(true)
    const tableFields = new Set(['id', 'status', 'openedAt', 'createdAt'])
    const res = resolveBuckets(controls, { isField: name => tableFields.has(name) })
    expect(!res.ok && res.issues).toEqual([{ path: '$select', message: 'Alias "createdAt" collides with field "createdAt"' }])
    // isField replaces the default: a selected field it does not know is not a collision
    const vsSelected = resolveBuckets(
      { $select: ['status', { $bucket: 'day', $field: 'openedAt', $as: 'status' }], $groupBy: ['status'] },
      { isField: () => false },
    )
    expect(vsSelected.ok).toBe(true)
    // combines with the aggregate option
    const outsideAggregate = resolveBuckets(controls, { aggregate: false, isField: name => tableFields.has(name) })
    expect(!outsideAggregate.ok && outsideAggregate.issues.map(i => i.message)).toEqual([
      'Calendar buckets are only valid in grouped queries',
      'Alias "createdAt" collides with field "createdAt"',
    ])
  })

  it('leaves duplicate aggregate-only aliases alone (pre-existing behaviour)', () => {
    expect(
      resolveBuckets({
        $select: [{ $fn: 'sum', $field: 'a', $as: 'x' }, { $fn: 'max', $field: 'a', $as: 'x' }],
        $groupBy: ['g'],
      }).ok,
    ).toBe(true)
  })

  it('rejects non-string $groupBy entries', () => {
    const res = resolveBuckets({ $groupBy: ['a', { $bucket: 'day', $field: 'b' }] })
    expect(res).toEqual({
      ok: false,
      issues: [
        { path: '$groupBy', message: 'Unsupported $groupBy entry at index 1 — expected a field name or bucket alias' },
      ],
    })
  })
})
