import { describe, it, expect } from 'vitest'
import {
  AGGREGATE_FNS,
  STAR_AGGREGATE_FNS,
  groupByFields,
  isAggregateExpr,
  isAggregateFn,
  isAggregateOfExpr,
  isBucketExpr,
  isSelectArithExpr,
  EXPR_AGGREGATE_FNS,
  ROW_ORDER_FNS,
  resolveAlias,
  resolveBuckets,
  validateAggregateExpr,
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

  it('keeps the function name verbatim for countDistinct (countDistinct_{field})', () => {
    expect(resolveAlias({ $fn: 'countDistinct', $field: 'customerId' })).toBe('countDistinct_customerId')
    expect(resolveAlias({ $fn: 'countDistinct', $field: 'customerId', $as: 'n' })).toBe('n')
  })
})

describe('AGGREGATE_FNS / isAggregateFn', () => {
  it('lists the known aggregate functions', () => {
    expect(AGGREGATE_FNS).toEqual(['sum', 'count', 'countDistinct', 'avg', 'min', 'max', 'first', 'last'])
  })

  it('accepts exactly the known names', () => {
    for (const fn of AGGREGATE_FNS) expect(isAggregateFn(fn)).toBe(true)
    expect(isAggregateFn('stddev')).toBe(false)
    expect(isAggregateFn('countdistinct')).toBe(false)
    expect(isAggregateFn('COUNT')).toBe(false)
    expect(isAggregateFn('')).toBe(false)
    expect(isAggregateFn(undefined)).toBe(false)
    expect(isAggregateFn(1)).toBe(false)
  })

  it('only count accepts *', () => {
    expect(STAR_AGGREGATE_FNS).toEqual(['count'])
  })
})

describe('validateAggregateExpr', () => {
  it('accepts count(*) and known functions over a field', () => {
    expect(validateAggregateExpr({ $fn: 'count', $field: '*' })).toEqual({ ok: true })
    for (const fn of AGGREGATE_FNS) expect(validateAggregateExpr({ $fn: fn, $field: 'amount' })).toEqual({ ok: true })
  })

  it('rejects * for known functions other than count', () => {
    expect(validateAggregateExpr({ $fn: 'sum', $field: '*' })).toEqual({
      ok: false,
      message: 'Aggregate "sum" needs a field — only count accepts *',
    })
    expect(validateAggregateExpr({ $fn: 'countDistinct', $field: '*' })).toEqual({
      ok: false,
      message: 'Aggregate "countDistinct" needs a field — only count accepts *',
    })
  })

  it('lets a custom function through without fns, including over *', () => {
    expect(validateAggregateExpr({ $fn: 'stddev', $field: 'score' })).toEqual({ ok: true })
    expect(validateAggregateExpr({ $fn: 'approxCount', $field: '*' })).toEqual({ ok: true })
  })

  it('rejects a function missing from fns', () => {
    expect(validateAggregateExpr({ $fn: 'stddev', $field: 'score' }, { fns: AGGREGATE_FNS })).toEqual({
      ok: false,
      message: 'Unknown aggregate function "stddev" — use sum, count, countDistinct, avg, min, max, first or last',
    })
    expect(validateAggregateExpr({ $fn: 'sum', $field: 'amount' }, { fns: ['count'] })).toEqual({
      ok: false,
      message: 'Unknown aggregate function "sum" — use count',
    })
    expect(validateAggregateExpr({ $fn: 'stddev', $field: 'score' }, { fns: ['stddev'] })).toEqual({ ok: true })
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
      'Unknown bucket unit "fortnight" — use hour, day, week, month, quarter or year',
    )
    expect(fail({ $bucket: 'minute' as never })).toMatch(/^Unknown bucket unit "minute"/)
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
      exprs: [],
    })
  })

  it('is ok with no buckets, object-form $select, or no controls', () => {
    expect(resolveBuckets({ $select: ['a', { $fn: 'sum', $field: 'b' }], $groupBy: ['a'] })).toEqual({
      ok: true,
      buckets: [],
      exprs: [],
    })
    expect(resolveBuckets({ $select: { a: 1 } })).toEqual({ ok: true, buckets: [], exprs: [] })
    expect(resolveBuckets(undefined)).toEqual({ ok: true, buckets: [], exprs: [] })
  })

  it('collects entry-level issues', () => {
    const res = resolveBuckets({
      $select: [{ $bucket: 'fortnight', $field: 'a', $as: 'x' }, { $bucket: 'day', $field: 'b', $tz: 'CET', $as: 'y' }],
      $groupBy: ['x', 'y'],
    })
    expect(res).toEqual({
      ok: false,
      issues: [
        { path: '$select', message: 'Unknown bucket unit "fortnight" — use hour, day, week, month, quarter or year' },
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
      'Unknown bucket unit "eon" — use hour, day, week, month, quarter or year',
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

  it('validates aggregates via validateAggregateExpr, with the optional fns allow-list', () => {
    const select = ['region', { $fn: 'countDistinct', $field: '*', $as: 'n' }, { $fn: 'stddev', $field: 'x' }]
    const res = resolveBuckets({ $select: select, $groupBy: ['region'] })
    expect(!res.ok && res.issues).toEqual([
      { path: '$select', message: 'Aggregate "countDistinct" needs a field — only count accepts *' },
    ])
    const withFns = resolveBuckets({ $select: select, $groupBy: ['region'] }, { fns: AGGREGATE_FNS })
    expect(!withFns.ok && withFns.issues).toEqual([
      { path: '$select', message: 'Aggregate "countDistinct" needs a field — only count accepts *' },
      {
        path: '$select',
        message: 'Unknown aggregate function "stddev" — use sum, count, countDistinct, avg, min, max, first or last',
      },
    ])
    expect(resolveBuckets({ $select: [{ $fn: 'count', $field: '*' }], $groupBy: [] }).ok).toBe(true)
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

describe('expression guards', () => {
  it('isAggregateOfExpr: $fn + $expr, no $field / $bucket', () => {
    expect(isAggregateOfExpr({ $fn: 'sum', $expr: 'a', $as: 'x' })).toBe(true)
    expect(isAggregateOfExpr({ $fn: 'sum', $field: 'a', $expr: 'a' })).toBe(false)
    expect(isAggregateOfExpr({ $expr: 'a', $as: 'x' })).toBe(false)
    expect(isAggregateOfExpr(null)).toBe(false)
  })

  it('isSelectArithExpr: $expr only', () => {
    expect(isSelectArithExpr({ $expr: 'a', $as: 'x' })).toBe(true)
    expect(isSelectArithExpr({ $fn: 'sum', $expr: 'a' })).toBe(false)
    expect(isSelectArithExpr({ $bucket: 'day', $field: 'a', $expr: 1 })).toBe(false)
    expect(isSelectArithExpr('a')).toBe(false)
  })

  it('isAggregateExpr stays strict, resolveAlias reads $as', () => {
    expect(isAggregateExpr({ $fn: 'sum', $expr: 'a', $as: 'x' })).toBe(false)
    expect(resolveAlias({ $expr: 'a', $as: 'x' })).toBe('x')
    expect(resolveAlias({ $fn: 'first', $field: 'at' })).toBe('first_at')
  })

  it('lists first / last and the expression functions', () => {
    expect(ROW_ORDER_FNS).toEqual(['first', 'last'])
    expect(EXPR_AGGREGATE_FNS).toEqual(['sum', 'avg', 'min', 'max'])
    expect(isAggregateFn('first')).toBe(true)
  })
})

describe('resolveBuckets – arithmetic entries', () => {
  const issuesOf = (controls: Parameters<typeof resolveBuckets>[0], opts?: Parameters<typeof resolveBuckets>[1]) => {
    const res = resolveBuckets(controls, opts)
    return res.ok ? [] : res.issues.map((i) => `${i.path}: ${i.message}`)
  }

  it('returns row-level entries first, then group-level in dependency order', () => {
    const res = resolveBuckets({
      $groupBy: ['ticketId'],
      $select: [
        'ticketId',
        { $expr: { $op: '+', $args: [{ $op: '*', $args: ['open', 10] }, 'sevMax'] }, $as: 'rank' },
        { $expr: { $op: '/', $args: ['est', 'open'] }, $as: 'avgEst' },
        { $fn: 'count', $field: '*', $as: 'open' },
        { $fn: 'sum', $field: 'estimate', $as: 'est' },
        { $fn: 'sum', $expr: { $op: '*', $args: ['price', 'qty'] }, $as: 'revenue' },
        { $fn: 'max', $field: 'severity', $as: 'sevMax' },
        { $expr: { $op: '*', $args: ['rank', 2] }, $as: 'double' },
      ],
    })
    expect(res.ok && res.exprs.map((e) => [e.alias, e.level, e.fn])).toEqual([
      ['revenue', 'row', 'sum'],
      ['rank', 'group', undefined],
      ['avgEst', 'group', undefined],
      ['double', 'group', undefined],
    ])
    expect(res.ok && res.exprs.find((e) => e.alias === 'rank')?.names).toEqual(['open', 'sevMax'])
    expect(res.ok && res.rowOrder).toBeUndefined()
  })

  it('orders dependencies even when declared in reverse', () => {
    const res = resolveBuckets({
      $groupBy: ['g'],
      $select: [
        { $expr: { $op: '+', $args: ['b', 1] }, $as: 'c' },
        { $expr: { $op: '*', $args: ['a', 2] }, $as: 'b' },
        { $fn: 'sum', $field: 'x', $as: 'a' },
      ],
    })
    expect(res.ok && res.exprs.map((e) => e.alias)).toEqual(['b', 'c'])
  })

  it('allows a plain $groupBy field as a group-level operand', () => {
    expect(issuesOf({ $groupBy: ['n'], $select: ['n', { $expr: { $op: '*', $args: ['n', 2] }, $as: 'n2' }] })).toEqual([])
  })

  it('rejects expressions outside grouped queries', () => {
    expect(issuesOf({ $select: [{ $fn: 'sum', $expr: 'a', $as: 'x' }] })).toEqual([
      '$select: Expressions and first()/last() are only valid in grouped queries',
    ])
    expect(issuesOf({ $select: [{ $fn: 'first', $field: 'a' }], $rowOrder: { a: 1 } })).toEqual([
      '$select: Expressions and first()/last() are only valid in grouped queries',
    ])
    expect(issuesOf({ $select: [{ $fn: 'sum', $expr: 'a', $as: 'x' }] }, { aggregate: true })).toEqual([])
  })

  it('validates the aggregate function of an expression entry', () => {
    expect(issuesOf({ $groupBy: ['g'], $select: [{ $fn: 'count', $expr: 'a', $as: 'x' }] })).toEqual([
      '$select: Aggregate "count" takes a field, not an expression — use sum, avg, min or max',
    ])
    expect(issuesOf({ $groupBy: ['g'], $select: [{ $fn: 'first', $expr: 'a', $as: 'x' }] })[0]).toMatch(/takes a field/)
  })

  it('requires an identifier alias', () => {
    expect(issuesOf({ $groupBy: ['g'], $select: [{ $fn: 'sum', $expr: 'a' }] })).toEqual([
      '$select: An expression needs an explicit $as',
    ])
    expect(issuesOf({ $groupBy: ['g'], $select: [{ $expr: 'a', $as: 'x.y' }] })[0]).toMatch(/Invalid alias "x.y"/)
    expect(issuesOf({ $groupBy: ['g'], $select: [{ $expr: 'a', $as: '' }] })[0]).toMatch(/Invalid alias/)
  })

  it('reports arithmetic problems (constant, shape, limits)', () => {
    expect(issuesOf({ $groupBy: ['g'], $select: [{ $fn: 'sum', $expr: 3, $as: 'x' }] })).toEqual([
      '$select: Expression has no field or alias — a constant is not allowed',
    ])
    expect(issuesOf({ $groupBy: ['g'], $select: [{ $fn: 'sum', $expr: { $op: '%', $args: ['a', 'b'] }, $as: 'x' }] })[0])
      .toMatch(/Unknown operator/)
  })

  it('rejects an unknown or text operand of a group-level expression', () => {
    expect(
      issuesOf({ $groupBy: ['g'], $select: [{ $expr: { $op: '+', $args: ['nope', 1] }, $as: 'x' }] }),
    ).toEqual(['$select: Expression "x" references "nope" — name an aggregate alias or a $groupBy field'])
    // a non-grouped plain $select field is not an operand either
    expect(
      issuesOf({ $groupBy: ['g'], $select: ['price', { $expr: { $op: '+', $args: ['price', 1] }, $as: 'x' }] }),
    ).toEqual(['$select: Expression "x" references "price" — name an aggregate alias or a $groupBy field'])
    expect(
      issuesOf({
        $groupBy: ['w'],
        $select: [{ $bucket: 'week', $field: 'at', $as: 'w' }, { $expr: { $op: '+', $args: ['w', 1] }, $as: 'x' }],
      }),
    ).toEqual(['$select: Bucket "w" is a text label and cannot be used in arithmetic'])
  })

  it('detects expression cycles', () => {
    expect(
      issuesOf({
        $groupBy: ['g'],
        $select: [
          { $expr: { $op: '+', $args: ['b', 1] }, $as: 'a' },
          { $expr: { $op: '+', $args: ['a', 1] }, $as: 'b' },
        ],
      }),
    ).toEqual(['$select: Expression cycle: a → b → a'])
    expect(issuesOf({ $groupBy: ['g'], $select: [{ $expr: { $op: '+', $args: ['a', 1] }, $as: 'a' }] })).toEqual([
      '$select: Expression cycle: a → a',
    ])
  })

  it('checks alias uniqueness and field collisions of expression entries', () => {
    expect(
      issuesOf({
        $groupBy: ['g'],
        $select: [{ $fn: 'sum', $field: 'a', $as: 'x' }, { $expr: { $op: '+', $args: ['q', 1] }, $as: 'x' }, { $fn: 'max', $field: 'q', $as: 'q' }],
      }),
    ).toEqual(['$select: Duplicate alias "x"'])
    expect(
      issuesOf({
        $groupBy: ['g'],
        $select: ['status', { $fn: 'sum', $expr: 'a', $as: 'status' }],
      }),
    ).toEqual(['$select: Alias "status" collides with field "status"'])
    expect(
      issuesOf(
        { $groupBy: ['g'], $select: [{ $fn: 'sum', $expr: 'a', $as: 'revenue' }] },
        { isField: (n) => n === 'revenue' },
      ),
    ).toEqual(['$select: Alias "revenue" collides with field "revenue"'])
  })

  it('rejects grouping by a computed expression', () => {
    expect(
      issuesOf({ $groupBy: ['x'], $select: [{ $fn: 'sum', $expr: 'a', $as: 'x' }] }),
    ).toEqual(['$groupBy: Cannot group by a computed expression "x"'])
  })

  it('still rejects unsupported entries', () => {
    expect(issuesOf({ $groupBy: ['g'], $select: [{ $fn: 'sum', $field: 3 }] })).toEqual([
      '$select: Unsupported $select entry at index 0',
    ])
    expect(issuesOf({ $groupBy: ['g'], $select: [{ foo: 1 }] })).toEqual(['$select: Unsupported $select entry at index 0'])
  })
})

describe('resolveBuckets – first / last and $rowOrder', () => {
  const issuesOf = (controls: Parameters<typeof resolveBuckets>[0]) => {
    const res = resolveBuckets(controls)
    return res.ok ? [] : res.issues.map((i) => `${i.path}: ${i.message}`)
  }
  const select = ['ticketId', { $fn: 'first', $field: 'title', $as: 'oldest' }]

  it('returns the resolved $rowOrder', () => {
    const res = resolveBuckets({ $groupBy: ['ticketId'], $select: select, $rowOrder: { raisedAt: 1, id: -1 } })
    expect(res.ok && res.rowOrder).toEqual([
      { field: 'raisedAt', desc: false },
      { field: 'id', desc: true },
    ])
  })

  it('requires $rowOrder with first/last and rejects it without', () => {
    expect(issuesOf({ $groupBy: ['ticketId'], $select: select })).toEqual([
      '$rowOrder: $rowOrder is required when first() or last() is used',
    ])
    expect(issuesOf({ $groupBy: ['ticketId'], $select: ['ticketId'], $rowOrder: { a: 1 } })).toEqual([
      '$rowOrder: $rowOrder orders rows for first()/last() only',
    ])
    expect(issuesOf({ $groupBy: ['t'], $select: [{ $fn: 'sum', $field: 'a' }], $rowOrder: { a: 1 } })).toEqual([
      '$rowOrder: $rowOrder orders rows for first()/last() only',
    ])
  })

  it('validates the $rowOrder shape', () => {
    const ctl = (o: unknown) => issuesOf({ $groupBy: ['t'], $select: select, $rowOrder: o })
    expect(ctl({})).toEqual(['$rowOrder: $rowOrder must be a non-empty object of field → 1 | -1'])
    expect(ctl([1])).toEqual(['$rowOrder: $rowOrder must be a non-empty object of field → 1 | -1'])
    expect(ctl('a')).toEqual(['$rowOrder: $rowOrder must be a non-empty object of field → 1 | -1'])
    expect(ctl({ a: 2 })).toEqual(['$rowOrder: $rowOrder "a" must be 1 or -1'])
  })

  it('rejects first(*)', () => {
    expect(issuesOf({ $groupBy: ['t'], $select: [{ $fn: 'last', $field: '*' }], $rowOrder: { a: 1 } })).toEqual([
      '$select: Aggregate "last" needs a field — only count accepts *',
    ])
  })

  it('first/last honour the fns allow-list', () => {
    const res = resolveBuckets(
      { $groupBy: ['t'], $select: select, $rowOrder: { a: 1 } },
      { fns: ['sum', 'count'] },
    )
    expect(!res.ok && res.issues[0].message).toMatch(/Unknown aggregate function "first"/)
  })
})

describe('resolveBuckets — malformed entries', () => {
  it('rejects an entry carrying both $field and $expr', () => {
    const res = resolveBuckets(
      { $select: ['g', { $fn: 'sum', $field: 'a', $expr: 'b', $as: 'x' } as never], $groupBy: ['g'] },
      { aggregate: true },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.issues[0]!.message).toMatch(/both \$field and \$expr/)
  })

  it('rejects an alias in the reserved internal prefix, for every entry kind', () => {
    for (const entry of [
      { $fn: 'sum', $field: 'a', $as: '__as_n_total' },
      { $fn: 'sum', $expr: 'a', $as: '__as_x' },
      { $expr: 'n', $as: '__as_y' },
      { $bucket: 'day', $field: 'at', $as: '__as_d' },
    ]) {
      const res = resolveBuckets(
        { $select: ['g', { $fn: 'count', $field: '*', $as: 'n' }, entry as never], $groupBy: ['g', '__as_d'] },
        { aggregate: true },
      )
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.issues.some((i) => /reserved/.test(i.message))).toBe(true)
    }
  })
})
