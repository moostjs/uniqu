import { describe, it, expect } from 'vitest'
import { NESTED_STAGE_CONTROLS, resolveNested, type QueryIssue } from './aggregate'

/** Issues of a failed resolution (fails the test when it succeeded). */
function issuesOf(res: ReturnType<typeof resolveNested>): QueryIssue[] {
  expect(res.ok).toBe(false)
  return res.ok ? [] : res.issues
}

/** Daily ticket counts per user, then the average daily count per user. */
const daily = {
  $from: {
    $groupBy: ['userId', 'day'],
    $select: [
      { $bucket: 'day', $field: 'createdAt', $as: 'day' },
      { $fn: 'count', $field: '*', $as: 'n' },
      { $fn: 'count', $field: '*', $as: 'estimated', $where: { status: 'ESTIMATED' } },
      { $fn: 'min', $field: 'createdAt', $as: 'firstAt' },
    ],
  },
  $groupBy: ['userId'],
  $select: ['userId', { $fn: 'avg', $field: 'n', $as: 'avgDaily' }],
}

describe('resolveNested — success', () => {
  it('resolves both levels and lists the inner columns (keys, then computed entries)', () => {
    const res = resolveNested(daily)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.columns).toEqual([
      { name: 'userId', kind: 'key' },
      { name: 'day', kind: 'bucket', numeric: false },
      { name: 'n', kind: 'aggregate', numeric: true },
      { name: 'estimated', kind: 'aggregate', numeric: true },
      { name: 'firstAt', kind: 'aggregate' },
    ])
    expect(res.inner.buckets.map((b) => b.alias)).toEqual(['day'])
    expect(res.outer).toEqual({ buckets: [], exprs: [] })
  })

  it('isNumericField types keys and min/max/first/last columns', () => {
    const res = resolveNested(daily, { isNumericField: (f) => f === 'createdAt' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.columns.find((c) => c.name === 'userId')).toEqual({ name: 'userId', kind: 'key', numeric: false })
      expect(res.columns.find((c) => c.name === 'firstAt')).toEqual({ name: 'firstAt', kind: 'aggregate', numeric: true })
    }
  })

  it('implicit $groupBy keys are columns even when not selected', () => {
    const res = resolveNested({
      $from: { $groupBy: ['userId', 'projectId'], $select: [{ $fn: 'count', $field: '*', $as: 'n' }] },
      $groupBy: ['projectId'],
      $select: ['projectId', { $fn: 'countDistinct', $field: 'userId', $as: 'users' }],
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.columns.map((c) => c.name)).toEqual(['userId', 'projectId', 'n'])
  })

  it('the outer level may group by inner aliases and bucket inner timestamp columns', () => {
    const res = resolveNested({
      $from: { $groupBy: ['userId'], $select: [{ $fn: 'min', $field: 'createdAt', $as: 'firstAt' }, { $fn: 'count', $field: '*', $as: 'n' }] },
      $groupBy: ['cohort', 'n'],
      $select: [
        { $bucket: 'month', $field: 'firstAt', $as: 'cohort' },
        'n',
        { $fn: 'count', $field: '*', $as: 'users' },
      ],
      $sort: { cohort: 1 },
      $having: { users: { $gt: 1 } },
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.outer.buckets).toEqual([expect.objectContaining({ alias: 'cohort', field: 'firstAt', unit: 'month' })])
  })

  it('an empty or absent outer $groupBy is one row over every inner row', () => {
    for (const $groupBy of [undefined, []]) {
      const res = resolveNested({
        $from: { $groupBy: ['day'], $select: [{ $bucket: 'day', $field: 'at', $as: 'day' }, { $fn: 'count', $field: '*', $as: 'n' }] },
        $groupBy,
        $select: [{ $fn: 'avg', $field: 'n', $as: 'avgPerDay' }, { $fn: 'max', $field: 'n', $as: 'peak' }],
      })
      expect(res.ok).toBe(true)
    }
  })

  it('FW-41 field lists and FW-43 conditions work at both levels', () => {
    const res = resolveNested({
      $from: {
        $groupBy: ['userId'],
        $select: [
          { $fn: 'countDistinct', $field: ['projectId', 'day'], $as: 'projectDays' },
          { $fn: 'count', $field: '*', $as: 'open', $where: { status: 'open' } },
          { $fn: 'sum', $expr: { $op: '*', $args: ['price', 'qty'] }, $as: 'revenue', $where: { paid: true } },
        ],
      },
      $groupBy: [],
      $select: [
        { $fn: 'count', $field: '*', $as: 'busyUsers', $where: { open: { $gt: 3 } } },
        { $fn: 'countDistinct', $field: ['userId', 'open'], $as: 'pairs' },
        { $fn: 'sum', $field: 'revenue', $as: 'paidRevenue', $where: { $or: [{ open: 0 }, { projectDays: { $gte: 2 } }] } },
        { $fn: 'avg', $expr: { $op: '/', $args: ['revenue', 'projectDays'] }, $as: 'perDay', $where: { open: { $gt: 0 } } },
        { $expr: { $op: '/', $args: ['paidRevenue', 'busyUsers'] }, $as: 'ratio' },
      ],
    })
    expect(res.ok).toBe(true)
  })

  it('first()/last() at the outer level order inner rows by inner columns', () => {
    const res = resolveNested({
      $from: { $groupBy: ['userId', 'day'], $select: [{ $bucket: 'day', $field: 'at', $as: 'day' }, { $fn: 'count', $field: '*', $as: 'n' }] },
      $groupBy: ['userId'],
      $select: ['userId', { $fn: 'last', $field: 'n', $as: 'lastDayCount' }],
      $rowOrder: { day: 1 },
      $nulls: { day: 'last' },
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.outer.rowOrder).toEqual([{ field: 'day', desc: false, nulls: 'last' }])
  })

  it('lists the controls a $from holds', () => {
    expect(NESTED_STAGE_CONTROLS).toEqual(['$groupBy', '$select', '$having', '$rowOrder', '$nulls'])
  })
})

describe('resolveNested — shape errors', () => {
  it('AGG_NESTED_CONTROL: $from is not an object', () => {
    for (const $from of [undefined, null, 'x', ['a']]) {
      expect(issuesOf(resolveNested({ $from }))).toEqual([
        {
          path: '$from',
          message: '$from must be an object of $groupBy, $select, $having, $rowOrder or $nulls',
          code: 'AGG_NESTED_CONTROL',
        },
      ])
    }
  })

  it('AGG_NESTED_DEPTH: a $from inside $from', () => {
    const issues = issuesOf(
      resolveNested({ $from: { $groupBy: ['a'], $from: { $groupBy: ['b'] } }, $select: [{ $fn: 'count', $field: '*', $as: 'n' }] }),
    )
    expect(issues).toEqual([
      {
        path: '$from.$from',
        message: 'A $from cannot have its own $from — a query has two levels at most',
        code: 'AGG_NESTED_DEPTH',
      },
    ])
  })

  it('AGG_NESTED_CONTROL: a control that is not valid inside $from, or $with at the root', () => {
    const issues = issuesOf(
      resolveNested({
        $from: { $groupBy: ['a'], $sort: { a: 1 }, $limit: 5, $search: 'x', filter: { a: 1 } },
        $with: ['rel'],
      }),
    )
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ['$from.$sort', 'AGG_NESTED_CONTROL'],
      ['$from.$limit', 'AGG_NESTED_CONTROL'],
      ['$from.$search', 'AGG_NESTED_CONTROL'],
      ['$from.filter', 'AGG_NESTED_CONTROL'],
      ['$with', 'AGG_NESTED_CONTROL'],
    ])
    expect(issues[0]!.message).toBe(
      '$sort is not valid inside $from — it takes $groupBy, $select, $having, $rowOrder or $nulls; the query filter applies to the rows it groups',
    )
  })

  it('AGG_NESTED_CONTROL: an object-form $select at either level', () => {
    const issues = issuesOf(
      resolveNested({ $from: { $groupBy: ['a'], $select: { a: 1 } }, $select: { password: 1 } }),
    )
    expect(issues).toEqual([
      {
        path: '$from.$select',
        message: '$from.$select of a two-level aggregate must be a list of columns and computed entries',
        code: 'AGG_NESTED_CONTROL',
      },
      {
        path: '$select',
        message: '$select of a two-level aggregate must be a list of columns and computed entries',
        code: 'AGG_NESTED_CONTROL',
      },
    ])
  })

  it('AGG_NESTED_UNGROUPED: the inner level needs a non-empty $groupBy', () => {
    for (const $groupBy of [undefined, [], 'a']) {
      const issues = issuesOf(resolveNested({ $from: { $groupBy, $select: [{ $fn: 'count', $field: '*', $as: 'n' }] } }))
      expect(issues).toContainEqual({
        path: '$from.$groupBy',
        message: 'The inner level ($from) needs a non-empty $groupBy',
        code: 'AGG_NESTED_UNGROUPED',
      })
    }
  })

  it('AGG_NESTED_DUPLICATE_COLUMN: an alias equal to a $groupBy key, and two equal aliases (reported once)', () => {
    const keyClash = issuesOf(
      resolveNested({ $from: { $groupBy: ['status'], $select: [{ $fn: 'count', $field: '*', $as: 'status' }] } }),
    )
    expect(keyClash).toEqual([
      {
        path: '$from.$select',
        message: 'Inner column "status" is defined twice — each $groupBy key and $select alias of $from needs its own name',
        code: 'AGG_NESTED_DUPLICATE_COLUMN',
      },
    ])
    // count(*) twice defaults to count_star twice; a bucket and an aggregate sharing an alias.
    const aliasClash = issuesOf(
      resolveNested({
        $from: {
          $groupBy: ['g', 'd'],
          $select: [
            { $fn: 'count', $field: '*' },
            { $fn: 'count', $field: '*' },
            { $bucket: 'day', $field: 'at', $as: 'd' },
            { $fn: 'max', $field: 'x', $as: 'd' },
          ],
        },
      }),
    )
    expect(aliasClash.map((i) => [i.code, i.message])).toEqual([
      ['AGG_NESTED_DUPLICATE_COLUMN', 'Inner column "count_star" is defined twice — each $groupBy key and $select alias of $from needs its own name'],
      ['AGG_NESTED_DUPLICATE_COLUMN', 'Inner column "d" is defined twice — each $groupBy key and $select alias of $from needs its own name'],
    ])
  })

  it('a repeated $groupBy key and a bucket alias in $groupBy are one column each', () => {
    const res = resolveNested({
      $from: { $groupBy: ['g', 'g', 'd'], $select: [{ $bucket: 'day', $field: 'at', $as: 'd' }] },
      $select: [{ $fn: 'count', $field: '*', $as: 'n' }],
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.columns.map((c) => c.name)).toEqual(['g', 'd'])
  })

  it('AGG_NESTED_UNKNOWN_COLUMN: every outer name resolves against inner columns only, one message for any non-column', () => {
    const issues = issuesOf(
      resolveNested({
        $from: { $groupBy: ['userId'], $select: [{ $fn: 'count', $field: '*', $as: 'n' }] },
        $groupBy: ['status'],
        $select: [
          'email',
          { $fn: 'sum', $field: 'amount', $as: 's' },
          { $fn: 'countDistinct', $field: ['userId', 'secret'], $as: 'p' },
          { $bucket: 'day', $field: 'createdAt', $as: 'd' },
          { $fn: 'sum', $expr: { $op: '+', $args: ['n', 'salary'] }, $as: 'e' },
          { $fn: 'count', $field: '*', $as: 'c', $where: { $or: [{ n: 1 }, { password: 'x' }] } },
          { $fn: 'count', $field: '*', $as: 'r', $where: { tickets: { $some: { a: 1 } } } },
        ],
        $rowOrder: { createdAt: 1 },
      }),
    )
    const unknown = (name: string) =>
      `"${name}" is not a column of $from — the outer level reads only its columns (userId, n)`
    expect(issues.filter((i) => i.code === 'AGG_NESTED_UNKNOWN_COLUMN').map((i) => [i.path, i.message])).toEqual([
      ['$groupBy', unknown('status')],
      ['$select', unknown('email')],
      ['$select', unknown('amount')],
      ['$select', unknown('secret')],
      ['$select', unknown('createdAt')],
      ['$select', unknown('salary')],
      ['$select', unknown('password')],
      ['$select', unknown('tickets')],
      ['$rowOrder', unknown('createdAt')],
    ])
  })

  it('AGG_NESTED_UNKNOWN_COLUMN: outer $having / $sort name outer columns', () => {
    const issues = issuesOf(
      resolveNested({
        $from: { $groupBy: ['userId'], $select: [{ $fn: 'count', $field: '*', $as: 'n' }] },
        $groupBy: [],
        $select: [{ $fn: 'avg', $field: 'n', $as: 'avgN' }],
        $having: { n: { $gt: 1 } },
        $sort: { userId: 1, avgN: -1 },
      }),
    )
    expect(issues).toEqual([
      {
        path: '$having',
        message: '"n" is not a column of the result — name an outer $groupBy key or $select alias',
        code: 'AGG_NESTED_UNKNOWN_COLUMN',
      },
      {
        path: '$sort',
        message: '"userId" is not a column of the result — name an outer $groupBy key or $select alias',
        code: 'AGG_NESTED_UNKNOWN_COLUMN',
      },
    ])
  })

  it('a relational predicate on an inner column is rejected at the outer level', () => {
    const issues = issuesOf(
      resolveNested({
        $from: { $groupBy: ['userId'], $select: [{ $fn: 'count', $field: '*', $as: 'n' }] },
        $select: [{ $fn: 'count', $field: '*', $as: 'c', $where: { n: { $some: {} } } }],
      }),
    )
    expect(issues).toEqual([
      {
        path: '$select',
        message: '"n" is a column of $from — relational predicates do not apply at the outer level',
        code: 'AGG_NESTED_UNKNOWN_COLUMN',
      },
    ])
  })

  it('AGG_NESTED_NOT_NUMERIC: sum/avg, expression operands and buckets over a known non-numeric column', () => {
    const issues = issuesOf(
      resolveNested(
        {
          $from: {
            $groupBy: ['status', 'day'],
            $select: [
              { $bucket: 'day', $field: 'at', $as: 'day' },
              { $fn: 'max', $field: 'title', $as: 'lastTitle' },
              { $fn: 'count', $field: '*', $as: 'n' },
            ],
          },
          $groupBy: ['status'],
          $select: [
            'status',
            { $fn: 'sum', $field: 'day', $as: 'a' },
            { $fn: 'avg', $field: 'status', $as: 'b' },
            { $fn: 'sum', $expr: { $op: '+', $args: ['n', 'lastTitle'] }, $as: 'c' },
            { $bucket: 'week', $field: 'day', $as: 'wk' },
            { $expr: { $op: '+', $args: ['status', 1] }, $as: 'e' },
            // min / max / count / countDistinct read any column
            { $fn: 'max', $field: 'day', $as: 'lastDay' },
            { $fn: 'countDistinct', $field: 'lastTitle', $as: 'titles' },
          ],
        },
        { isNumericField: (f) => f === 'at' },
      ),
    )
    expect(issues.filter((i) => i.code === 'AGG_NESTED_NOT_NUMERIC').map((i) => i.message)).toEqual([
      'sum() needs a numeric column — "day" is a bucket label',
      'avg() needs a numeric column — "status" does not hold numbers',
      'sum(<expression>) needs a numeric column — "lastTitle" does not hold numbers',
      'Bucket over "day" needs a numeric column — "day" is a bucket label',
      'Expression "e" needs a numeric column — "status" does not hold numbers',
    ])
  })

  it('without isNumericField only bucket labels are known non-numeric', () => {
    const res = resolveNested({
      $from: { $groupBy: ['status'], $select: [{ $fn: 'max', $field: 'title', $as: 'lastTitle' }] },
      $select: [{ $fn: 'sum', $field: 'status', $as: 'a' }, { $fn: 'avg', $field: 'lastTitle', $as: 'b' }],
    })
    expect(res.ok).toBe(true)
  })

  it('inner issues keep their messages under a $from. path; outer aliases cannot shadow inner columns', () => {
    const issues = issuesOf(
      resolveNested({
        $from: { $groupBy: ['g'], $select: [{ $bucket: 'fortnight' as never, $field: 'at', $as: 'd' }, { $fn: 'first', $field: 'x', $as: 'f' }] },
        $select: [{ $bucket: 'day', $field: 'f', $as: 'g' }],
        $groupBy: ['g'],
      }),
    )
    expect(issues.map((i) => [i.path, i.message, i.code])).toEqual([
      ['$from.$select', 'Unknown bucket unit "fortnight" — use hour, day, week, month, quarter or year', undefined],
      ['$from.$rowOrder', '$rowOrder is required when first() or last() is used', undefined],
      ['$select', 'Alias "g" collides with field "g"', 'AGG_ALIAS_COLLISION'],
    ])
  })

  it('checks inner aggregate functions and $where against fns / the shape rules at both levels', () => {
    const issues = issuesOf(
      resolveNested(
        {
          $from: { $groupBy: ['g'], $select: [{ $fn: 'stddev', $field: 'x', $as: 's' }, { $fn: 'count', $field: '*', $where: { a: 1 } }] },
          $select: [{ $fn: 'sum', $field: ['s', 'g'], $as: 't' } as never],
        },
        { fns: ['count', 'sum', 'countDistinct'] },
      ),
    )
    expect(issues.map((i) => [i.path, i.message])).toEqual([
      ['$from.$select', 'Unknown aggregate function "stddev" — use count, sum or countDistinct'],
      ['$from.$select', 'A conditional aggregate ($where) needs an explicit $as'],
      ['$select', 'Aggregate "sum" takes one field — only countDistinct takes a list of fields'],
    ])
  })
})

describe('resolveNested — control shapes fail closed', () => {
  const $from = { $groupBy: ['userId'], $select: [{ $fn: 'count', $field: '*', $as: 'n' }] }
  const controlIssues = (controls: Record<string, unknown>) =>
    issuesOf(resolveNested({ $from, ...controls })).filter((i) => i.code === 'AGG_NESTED_CONTROL').map((i) => [i.path, i.message])

  it('a string root $groupBy', () => {
    expect(controlIssues({ $groupBy: 'cost', $select: [{ $fn: 'count', $field: '*', $as: 'c' }] })).toEqual([
      ['$groupBy', '$groupBy must be a list of inner columns and outer bucket aliases'],
    ])
  })

  it('non-object root $having / $sort / $rowOrder / $nulls, and inner $having / $nulls', () => {
    expect(
      controlIssues({ $select: [{ $fn: 'count', $field: '*', $as: 'c' }], $having: 'cost>1', $sort: ['cost'], $rowOrder: 'x', $nulls: 1 }),
    ).toEqual([
      ['$having', '$having must be an object'],
      ['$sort', '$sort must be an object'],
      ['$rowOrder', '$rowOrder must be an object'],
      ['$nulls', '$nulls must be an object'],
    ])
    expect(
      issuesOf(resolveNested({ $from: { ...$from, $having: [], $nulls: 'x' }, $select: [{ $fn: 'count', $field: '*', $as: 'c' }] }))
        .filter((i) => i.code === 'AGG_NESTED_CONTROL')
        .map((i) => i.path),
    ).toEqual(['$from.$having', '$from.$nulls'])
  })

  it('a structurally malformed $having at either level', () => {
    expect(controlIssues({ $select: [{ $fn: 'count', $field: '*', $as: 'c' }], $having: { $and: 'x' } })).toEqual([
      ['$having', 'Malformed $having: $and must be a list of filter objects'],
    ])
    const inner = issuesOf(resolveNested({ $from: { ...$from, $having: { $not: [1] } }, $select: [{ $fn: 'count', $field: '*', $as: 'c' }] }))
    expect(inner).toContainEqual({
      path: '$from.$having',
      message: 'Malformed $from.$having: $not must be a filter object',
      code: 'AGG_NESTED_CONTROL',
    })
  })

  it('$nulls keys must be ordered by: $sort / $rowOrder outside, $rowOrder inside', () => {
    expect(
      controlIssues({
        $select: [{ $fn: 'count', $field: '*', $as: 'c' }],
        $sort: { c: 1 },
        $nulls: { c: 'last', cost: 'first' },
      }),
    ).toEqual([['$nulls', '$nulls "cost" names a key that is not ordered by — a $nulls key must be a $sort or $rowOrder key']])
    expect(controlIssues({ $select: [{ $fn: 'count', $field: '*', $as: 'c' }], $sort: { c: 1 }, $nulls: { c: 'middle' } })).toEqual([
      ['$nulls', `$nulls "c" must be 'first' or 'last'`],
    ])
    const inner = issuesOf(
      resolveNested({ $from: { ...$from, $nulls: { secret: 'last' } }, $select: [{ $fn: 'count', $field: '*', $as: 'c' }] }),
    )
    expect(inner).toEqual([
      {
        path: '$from.$nulls',
        message: '$from.$nulls "secret" names a key that is not ordered by — a $nulls key must be a $rowOrder key',
        code: 'AGG_NESTED_CONTROL',
      },
    ])
  })

  it('a malformed $where is a validation issue at both levels, never a crash', () => {
    const issues = issuesOf(
      resolveNested({
        $from: { $groupBy: ['u'], $select: [{ $fn: 'count', $field: '*', $as: 'n', $where: { $and: 'x' } as never }] },
        $select: [
          { $fn: 'count', $field: '*', $as: 'c', $where: { $or: [1] } as never },
          { $fn: 'sum', $expr: 'n', $as: 's', $where: [{ a: 1 }] as never },
        ],
      }),
    )
    expect(issues.map((i) => [i.path, i.message])).toEqual([
      ['$from.$select', 'Malformed $where: $and must be a list of filter objects'],
      ['$select', 'Malformed $where: $or must be a list of filter objects'],
      ['$select', '$where must be a filter object'],
    ])
  })

  it('never throws on hostile shapes', () => {
    const bad: unknown[] = [
      { $from: { $groupBy: 'a' } },
      { $from: { $groupBy: [1, null], $select: [null, 1, 'x', { $fn: 1 }, { $bucket: 1 }] } },
      { $from: { $groupBy: ['a'] }, $select: [{ $fn: 'sum', $expr: { $op: '+', $args: 'x' }, $as: 's' }], $having: { $and: [null] } },
      { $from: { $groupBy: ['a'] }, $select: 'x', $groupBy: {}, $sort: 1, $rowOrder: [], $nulls: null, $with: 3 },
      { $from: { $groupBy: ['a'], $rowOrder: 1, $nulls: [], $having: 'x', $select: {} } },
    ]
    for (const c of bad) expect(() => resolveNested(c as never)).not.toThrow()
    for (const c of bad) expect(resolveNested(c as never).ok).toBe(false)
  })

  it('never throws on a deeply nested (well-formed) $where or $having', () => {
    let deep: Record<string, unknown> = { missing: 1 }
    for (let i = 0; i < 100_000; i++) deep = i % 2 ? { $not: deep } : { $and: [deep] }
    const q = {
      $from: { $groupBy: ['a'], $select: [{ $fn: 'count', $field: '*', $as: 'n' }] },
      $groupBy: ['a'],
      $select: ['a', { $fn: 'count', $field: '*', $as: 'c', $where: deep }],
      $having: deep,
    }
    let res: ReturnType<typeof resolveNested> | undefined
    expect(() => (res = resolveNested(q as never))).not.toThrow()
    expect(issuesOf(res!).map((i) => [i.path, i.code])).toEqual([
      ['$select', 'AGG_NESTED_UNKNOWN_COLUMN'],
      ['$having', 'AGG_NESTED_UNKNOWN_COLUMN'],
    ])
  })
})

describe('resolveNested — outer result columns', () => {
  const $from = { $groupBy: ['userId', 'projectId'], $select: [{ $fn: 'count', $field: '*', $as: 'n' }] }

  it('a plain outer $select entry must be an outer $groupBy key', () => {
    const issues = issuesOf(resolveNested({ $from, $groupBy: ['projectId'], $select: ['projectId', 'userId'] }))
    expect(issues).toEqual([
      {
        path: '$select',
        message: '"userId" is not an outer $groupBy key — the outer $select lists $groupBy keys and aggregates',
        code: 'AGG_NESTED_UNKNOWN_COLUMN',
      },
    ])
    // ungrouped outer level: no plain entries at all
    expect(issuesOf(resolveNested({ $from, $select: ['userId', { $fn: 'avg', $field: 'n', $as: 'a' }] })).map((i) => i.code)).toEqual([
      'AGG_NESTED_UNKNOWN_COLUMN',
    ])
  })

  it('duplicate outer result names: an alias equal to a $groupBy key, two equal aliases', () => {
    const issues = issuesOf(
      resolveNested({
        $from,
        $groupBy: ['projectId'],
        $select: [
          'projectId',
          { $fn: 'max', $field: 'n', $as: 'projectId' },
          { $fn: 'avg', $field: 'n', $as: 'a' },
          { $fn: 'sum', $field: 'n', $as: 'a' },
          { $fn: 'min', $field: 'n', $as: 'a' },
        ],
      }),
    )
    expect(issues).toEqual([
      {
        path: '$select',
        message: 'Result column "projectId" is defined twice — each outer $groupBy key and $select alias needs its own name',
        code: 'AGG_NESTED_DUPLICATE_COLUMN',
      },
      {
        path: '$select',
        message: 'Result column "a" is defined twice — each outer $groupBy key and $select alias needs its own name',
        code: 'AGG_NESTED_DUPLICATE_COLUMN',
      },
    ])
  })

  it('a grouped outer bucket is one result column', () => {
    const res = resolveNested({
      $from: { $groupBy: ['userId'], $select: [{ $fn: 'min', $field: 'at', $as: 'firstAt' }] },
      $groupBy: ['cohort'],
      $select: [{ $bucket: 'month', $field: 'firstAt', $as: 'cohort' }, { $fn: 'count', $field: '*', $as: 'users' }],
      $sort: { cohort: 1 },
    })
    expect(res.ok).toBe(true)
  })
})

describe('resolveNested — one coded issue per malformed control', () => {
  it('a non-object $nulls (or $rowOrder) is reported once, with its code', () => {
    const inner = issuesOf(
      resolveNested({
        $from: { $groupBy: ['g'], $select: [{ $fn: 'first', $field: 't', $as: 'f' }], $rowOrder: { t: 1 }, $nulls: 5 },
        $select: [{ $fn: 'count', $field: '*', $as: 'c' }],
      }),
    )
    expect(inner).toEqual([{ path: '$from.$nulls', message: '$from.$nulls must be an object', code: 'AGG_NESTED_CONTROL' }])
    const outer = issuesOf(
      resolveNested({
        $from: { $groupBy: ['g'], $select: [{ $fn: 'count', $field: '*', $as: 'n' }] },
        $select: [{ $fn: 'first', $field: 'n', $as: 'f' }],
        $rowOrder: ['n'],
        $nulls: 'x',
      }),
    )
    expect(outer).toEqual([
      { path: '$rowOrder', message: '$rowOrder must be an object', code: 'AGG_NESTED_CONTROL' },
      { path: '$nulls', message: '$nulls must be an object', code: 'AGG_NESTED_CONTROL' },
    ])
  })

  it('a non-object inner $rowOrder is reported once, with its code (with or without first()/last())', () => {
    const select = [{ $fn: 'count', $field: '*', $as: 'c' }]
    for (const [rowOrder, fn] of [
      ['t', 'first'],
      [['t'], 'last'],
      [1, 'first'],
      [null, 'first'],
      ['t', 'count'],
    ] as const) {
      const field = fn === 'count' ? '*' : 't'
      const issues = issuesOf(
        resolveNested({ $from: { $groupBy: ['g'], $select: [{ $fn: fn, $field: field, $as: 'f' }], $rowOrder: rowOrder }, $select: select }),
      )
      expect(issues, JSON.stringify(rowOrder)).toEqual([
        { path: '$from.$rowOrder', message: '$from.$rowOrder must be an object', code: 'AGG_NESTED_CONTROL' },
      ])
    }
  })
})
