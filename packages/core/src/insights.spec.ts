import { describe, it, expect } from 'vitest'
import { computeInsights, getInsights } from './insights'
import type { FilterExpr, UniqueryControls, Uniquery } from './types'

describe('computeInsights', () => {
  it('computes insights from a flat filter', () => {
    const filter: FilterExpr = {
      age: { $gte: 18, $lte: 30 },
      status: { $ne: 'DELETED' },
    }
    const insights = computeInsights(filter)

    expect(insights.get('age')).toEqual(new Set(['$gte', '$lte']))
    expect(insights.get('status')).toEqual(new Set(['$ne']))
    expect(insights.size).toBe(2)
  })

  it('computes insights from bare primitives as $eq', () => {
    const filter: FilterExpr = { name: 'John', active: true }
    const insights = computeInsights(filter)

    expect(insights.get('name')).toEqual(new Set(['$eq']))
    expect(insights.get('active')).toEqual(new Set(['$eq']))
  })

  it('computes insights from $and/$or trees', () => {
    const filter: FilterExpr = {
      $or: [
        { age: { $gte: 18 }, status: { $ne: 'DELETED' } },
        { role: { $in: ['Admin', 'Editor'] } },
      ],
    }
    const insights = computeInsights(filter)

    expect(insights.get('age')).toEqual(new Set(['$gte']))
    expect(insights.get('status')).toEqual(new Set(['$ne']))
    expect(insights.get('role')).toEqual(new Set(['$in']))
  })

  it('captures both sides of a mixed comparison + logical node', () => {
    const filter: FilterExpr = {
      id: 101,
      nextRefreshAt: { $lte: 1000 },
      $or: [{ status: 'a' }, { attempts: { $gt: 3 } }],
    }
    const insights = computeInsights(filter)

    expect(insights.get('id')).toEqual(new Set(['$eq']))
    expect(insights.get('nextRefreshAt')).toEqual(new Set(['$lte']))
    expect(insights.get('status')).toEqual(new Set(['$eq']))
    expect(insights.get('attempts')).toEqual(new Set(['$gt']))
    expect(insights.size).toBe(4)
  })

  it('includes $select from controls', () => {
    const filter: FilterExpr = { age: { $gte: 18 } }
    const controls: UniqueryControls = {
      $select: { name: 1, password: 0 },
    }
    const insights = computeInsights(filter, controls)

    expect(insights.get('age')).toEqual(new Set(['$gte']))
    expect(insights.get('name')).toEqual(new Set(['$select']))
    expect(insights.get('password')).toEqual(new Set(['$select']))
  })

  it('includes $order from controls', () => {
    const filter: FilterExpr = {}
    const controls: UniqueryControls = {
      $sort: { createdAt: -1, score: 1 },
    }
    const insights = computeInsights(filter, controls)

    expect(insights.get('createdAt')).toEqual(new Set(['$order']))
    expect(insights.get('score')).toEqual(new Set(['$order']))
  })

  it('merges filter and control insights for same field', () => {
    const filter: FilterExpr = { score: { $gt: 550 } }
    const controls: UniqueryControls = {
      $sort: { score: 1 },
      $select: { score: 1 },
    }
    const insights = computeInsights(filter, controls)

    expect(insights.get('score')).toEqual(new Set(['$gt', '$order', '$select']))
  })

  it('computes insights through $not', () => {
    const filter: FilterExpr = {
      $not: { age: { $gt: 18 }, status: 'active' },
    }
    const insights = computeInsights(filter)

    expect(insights.get('age')).toEqual(new Set(['$gt']))
    expect(insights.get('status')).toEqual(new Set(['$eq']))
  })

  it('includes $select from array controls', () => {
    const filter: FilterExpr = { age: { $gte: 18 } }
    const controls: UniqueryControls = {
      $select: ['name', 'email'],
    }
    const insights = computeInsights(filter, controls)

    expect(insights.get('age')).toEqual(new Set(['$gte']))
    expect(insights.get('name')).toEqual(new Set(['$select']))
    expect(insights.get('email')).toEqual(new Set(['$select']))
  })

  it('handles empty filter and no controls', () => {
    const insights = computeInsights({})
    expect(insights.size).toBe(0)
  })

  it('includes $with from controls', () => {
    const filter: FilterExpr = { status: 'active' }
    const controls: UniqueryControls = {
      $with: [
        { name: 'posts', filter: {}, controls: {} },
        { name: 'posts.author', filter: {}, controls: {} },
      ],
    }
    const insights = computeInsights(filter, controls)

    expect(insights.get('status')).toEqual(new Set(['$eq']))
    expect(insights.get('posts')).toEqual(new Set(['$with']))
    expect(insights.get('posts.author')).toEqual(new Set(['$with']))
  })

  it('bubbles nested $with insights with dot-notation prefix', () => {
    const filter: FilterExpr = {}
    const controls: UniqueryControls = {
      $with: [
        { name: 'owner', filter: {}, controls: {} },
        {
          name: 'tasks',
          filter: {},
          controls: {
            $with: [
              {
                name: 'comments',
                filter: { body: { $regex: 'Great' } },
                controls: {},
              },
            ],
          },
        },
      ],
    }
    const insights = computeInsights(filter, controls)

    expect(insights.get('owner')).toEqual(new Set(['$with']))
    expect(insights.get('tasks')).toEqual(new Set(['$with']))
    expect(insights.get('tasks.comments')).toEqual(new Set(['$with']))
    expect(insights.get('tasks.comments.body')).toEqual(new Set(['$regex']))

    // scoped insights on each relation
    const tasks = controls.$with![1]
    expect(tasks.insights?.get('comments')).toEqual(new Set(['$with']))
    expect(tasks.insights?.get('comments.body')).toEqual(new Set(['$regex']))

    const comments = tasks.controls!.$with![0]
    expect(comments.insights?.get('body')).toEqual(new Set(['$regex']))

    // simple relation has no insights
    expect(controls.$with![0].insights).toBeUndefined()
  })

  it('deep nesting populates insights at every level', () => {
    const controls: UniqueryControls = {
      $with: [
        {
          name: 'tasks',
          filter: {},
          controls: {
            $with: [
              {
                name: 'comments',
                filter: { body: { $regex: 'Great' } },
                controls: {
                  $with: [
                    {
                      name: 'likes',
                      filter: { user: 'admin' },
                      controls: { $limit: 3 },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    }
    const insights = computeInsights({}, controls)

    // top-level bubbles everything
    expect(insights.get('tasks')).toEqual(new Set(['$with']))
    expect(insights.get('tasks.comments')).toEqual(new Set(['$with']))
    expect(insights.get('tasks.comments.body')).toEqual(new Set(['$regex']))
    expect(insights.get('tasks.comments.likes')).toEqual(new Set(['$with']))
    expect(insights.get('tasks.comments.likes.user')).toEqual(new Set(['$eq']))

    // each level has scoped insights
    const tasks = controls.$with![0]
    expect(tasks.insights?.get('comments')).toEqual(new Set(['$with']))
    expect(tasks.insights?.get('comments.likes')).toEqual(new Set(['$with']))
    expect(tasks.insights?.get('comments.likes.user')).toEqual(new Set(['$eq']))

    const comments = tasks.controls!.$with![0]
    expect(comments.insights?.get('body')).toEqual(new Set(['$regex']))
    expect(comments.insights?.get('likes')).toEqual(new Set(['$with']))
    expect(comments.insights?.get('likes.user')).toEqual(new Set(['$eq']))

    const likes = comments.controls!.$with![0]
    expect(likes.insights?.get('user')).toEqual(new Set(['$eq']))
  })

  it('handles $exists operator', () => {
    const filter: FilterExpr = {
      phone: { $exists: true },
      deletedAt: { $exists: false },
    }
    const insights = computeInsights(filter)

    expect(insights.get('phone')).toEqual(new Set(['$exists']))
    expect(insights.get('deletedAt')).toEqual(new Set(['$exists']))
  })

  it('captures $groupBy fields', () => {
    const controls: UniqueryControls = {
      $groupBy: ['currency', 'region'],
    }
    const insights = computeInsights({}, controls)

    expect(insights.get('currency')).toEqual(new Set(['$groupBy']))
    expect(insights.get('region')).toEqual(new Set(['$groupBy']))
  })

  it('captures aggregate functions in $select with bare fn names', () => {
    const controls: UniqueryControls = {
      $select: [
        'currency',
        { $fn: 'sum', $field: 'amount', $as: 'total' },
        { $fn: 'avg', $field: 'amount' },
        { $fn: 'count', $field: '*' },
      ],
    }
    const insights = computeInsights({}, controls)

    expect(insights.get('currency')).toEqual(new Set(['$select']))
    expect(insights.get('amount')).toEqual(new Set(['sum', 'avg']))
    expect(insights.get('*')).toEqual(new Set(['count']))
  })

  it('captures countDistinct against its field and resolves its default alias', () => {
    const controls: UniqueryControls = {
      $select: ['region', { $fn: 'countDistinct', $field: 'customerId' }],
      $groupBy: ['region'],
      $having: { countDistinct_customerId: { $gt: 10 } },
      $sort: { countDistinct_customerId: -1 },
    }
    const insights = computeInsights({}, controls)

    expect(insights.get('customerId')).toEqual(new Set(['countDistinct', '$having', '$order']))
    expect(insights.has('countDistinct_customerId')).toBe(false)
  })

  it('captures $having fields', () => {
    const controls: UniqueryControls = {
      $groupBy: ['currency'],
      $select: [
        'currency',
        { $fn: 'sum', $field: 'amount', $as: 'total' },
      ],
      $having: { total: { $gt: 1000 } },
    }
    const insights = computeInsights({}, controls)

    // the aggregate alias resolves to its source field instead of leaking as a field name
    expect(insights.get('total')).toBeUndefined()
    expect(insights.get('currency')).toEqual(new Set(['$select', '$groupBy']))
    expect(insights.get('amount')).toEqual(new Set(['sum', '$having']))
  })

  it('captures $having with multiple fields', () => {
    const controls: UniqueryControls = {
      $having: {
        $and: [
          { total: { $gt: 1000 } },
          { count_star: { $gte: 5 } },
        ],
      },
    }
    const insights = computeInsights({}, controls)

    expect(insights.get('total')).toEqual(new Set(['$having']))
    expect(insights.get('count_star')).toEqual(new Set(['$having']))
  })

  it('combines groupBy and aggregate insights', () => {
    const controls: UniqueryControls = {
      $select: [
        'currency',
        { $fn: 'sum', $field: 'amount', $as: 'total' },
      ],
      $groupBy: ['currency'],
      $sort: { total: -1 },
    }
    const insights = computeInsights({}, controls)

    expect(insights.get('currency')).toEqual(new Set(['$select', '$groupBy']))
    expect(insights.get('amount')).toEqual(new Set(['sum', '$order']))
    expect(insights.has('total')).toBe(false)
  })
  describe('calendar buckets', () => {
    const controls: UniqueryControls = {
      $select: [
        { $bucket: 'week', $field: 'openedAt', $tz: 'Europe/Berlin', $weekStart: 'sun', $as: 'week' },
        { $bucket: 'day', $field: 'closedAt' },
        'status',
        { $fn: 'count', $field: '*', $as: 'n' },
        { $fn: 'sum', $field: 'points' },
      ],
      $groupBy: ['week', 'day_closedAt', 'status'],
      $having: { $and: [{ week: { $gte: '2026-03-01' } }, { n: { $gt: 0 } }, { sum_points: { $lt: 9 } }] },
      $sort: { week: 1, day_closedAt: -1, n: -1 },
    }

    it("captures a bucket's source field as '$bucket'", () => {
      const insights = computeInsights({}, controls)
      expect(insights.get('openedAt')).toEqual(new Set(['$bucket', '$groupBy', '$having', '$order']))
      expect(insights.get('closedAt')).toEqual(new Set(['$bucket', '$groupBy', '$order']))
    })

    it('resolves bucket and aggregate aliases (explicit and default) in $groupBy, $having and $sort', () => {
      const insights = computeInsights({}, controls)
      for (const alias of ['week', 'day_closedAt', 'n', 'sum_points']) {
        expect(insights.has(alias)).toBe(false)
      }
      expect(insights.get('status')).toEqual(new Set(['$select', '$groupBy']))
      expect(insights.get('*')).toEqual(new Set(['count', '$having', '$order']))
      expect(insights.get('points')).toEqual(new Set(['sum', '$having']))
    })

    it('reports unsupported $select entries under the $select marker (fail closed) and skips non-string $groupBy entries', () => {
      const insights = computeInsights({}, {
        $select: ['a', { nope: 1 } as never, null as never],
        $groupBy: ['a', 7 as never],
      })
      expect([...insights.keys()]).toEqual(['a', '$select'])
    })
  })
})

describe('getInsights', () => {
  it('returns pre-computed insights when present', () => {
    const preComputed = new Map([['age', new Set(['$gte'] as const)]])
    const query: Uniquery = {
      filter: { status: 'active' },
      controls: {},
      insights: preComputed,
    }
    expect(getInsights(query)).toBe(preComputed)
  })

  it('computes insights lazily when not present', () => {
    const query: Uniquery = {
      filter: { age: { $gte: 18 } },
      controls: { $select: ['name'] },
    }
    const insights = getInsights(query)
    expect(insights.get('age')).toEqual(new Set(['$gte']))
    expect(insights.get('name')).toEqual(new Set(['$select']))
  })
})

describe('computeInsights – relational predicates', () => {
  it('captures the nav field with its op and prefixes inner fields', () => {
    const insights = computeInsights({
      ticket: { $some: { teamId: { $in: ['t1'] }, status: 'open' } },
    })
    expect(insights.get('ticket')).toEqual(new Set(['$some']))
    expect(insights.get('ticket.teamId')).toEqual(new Set(['$in']))
    expect(insights.get('ticket.status')).toEqual(new Set(['$eq']))
  })

  it('prefixes nested predicates through every hop', () => {
    const insights = computeInsights({
      $or: [{ ticket: { $some: { team: { $none: { name: 'x' } } } } }, { title: 'a' }],
    })
    expect(insights.get('ticket')).toEqual(new Set(['$some']))
    expect(insights.get('ticket.team')).toEqual(new Set(['$none']))
    expect(insights.get('ticket.team.name')).toEqual(new Set(['$eq']))
    expect(insights.get('title')).toEqual(new Set(['$eq']))
  })

  it('records an empty operand as the bare op', () => {
    const insights = computeInsights({ ticket: { $none: {} } })
    expect([...insights.keys()]).toEqual(['ticket'])
    expect(insights.get('ticket')).toEqual(new Set(['$none']))
  })

  it('does not walk into malformed / non-plain operands', () => {
    class Resolved { kind = 'to'; source = { table: 't' }; filter = { a: 1 } }
    for (const operand of [['x'], 'abc', null, new Resolved()]) {
      const insights = computeInsights({ ticket: { $some: operand } } as unknown as FilterExpr)
      expect([...insights.keys()]).toEqual(['ticket'])
    }
  })

  it('reports a predicate inside $having as a $having key (rejected downstream)', () => {
    const insights = computeInsights(undefined, {
      $groupBy: ['status'],
      $having: { ticket: { $some: { a: 1 } } },
    })
    expect(insights.get('ticket')).toEqual(new Set(['$having']))
  })
})

describe('computeInsights – expressions, first/last and $rowOrder', () => {
  const controls: UniqueryControls = {
    $groupBy: ['ticketId'],
    $select: [
      'ticketId',
      { $fn: 'sum', $expr: { $op: '*', $args: ['price', 'qty'] }, $as: 'revenue' },
      { $fn: 'count', $field: '*', $as: 'open' },
      { $expr: { $op: '/', $args: ['revenue', 'open'] }, $as: 'avgRev' },
      { $fn: 'first', $field: 'title', $as: 'oldest' },
    ],
    $rowOrder: { raisedAt: 1, id: -1 },
    $sort: { avgRev: -1, oldest: 1 },
    $having: { avgRev: { $gt: 1 } },
  }

  it('captures every row-level operand with the aggregate function', () => {
    const insights = computeInsights(undefined, controls)
    expect(insights.get('price')).toEqual(new Set(['sum']))
    expect(insights.get('qty')).toEqual(new Set(['sum']))
  })

  it('captures first/last fields and $rowOrder keys', () => {
    const insights = computeInsights(undefined, controls)
    expect(insights.get('title')?.has('first')).toBe(true)
    expect(insights.get('raisedAt')).toEqual(new Set(['$order']))
    expect(insights.get('id')).toEqual(new Set(['$order']))
  })

  it('does not report expression aliases as fields', () => {
    const insights = computeInsights(undefined, controls)
    expect(insights.has('revenue')).toBe(false)
    expect(insights.has('avgRev')).toBe(false)
    // alias → source field mapping still holds for first()
    expect(insights.get('title')).toEqual(new Set(['first', '$order']))
  })
})

/** Insights as a plain object of sorted operator lists, for whole-map comparisons. */
function plain(insights: Map<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries([...insights].map(([k, v]) => [k, [...v].sort()]))
}

describe('computeInsights – countDistinct over several fields', () => {
  it('reports every listed field, and every field behind an alias reference', () => {
    const insights = computeInsights(undefined, {
      $groupBy: ['region'],
      $select: ['region', { $fn: 'countDistinct', $field: ['customerId', 'day'], $as: 'pairs' }],
      $having: { pairs: { $gt: 1 } },
      $sort: { pairs: -1 },
    })
    expect(plain(insights)).toEqual({
      region: ['$groupBy', '$select'],
      customerId: ['$having', '$order', 'countDistinct'],
      day: ['$having', '$order', 'countDistinct'],
    })
  })
})

describe('computeInsights – conditional aggregates ($where)', () => {
  it('reports $where fields as filter usage, exactly like filter fields', () => {
    const controls: UniqueryControls = {
      $groupBy: ['projectId'],
      $select: [
        'projectId',
        { $fn: 'count', $field: '*', $as: 'estimated', $where: { status: 'ESTIMATED' } },
        { $fn: 'sum', $field: 'amount', $as: 'big', $where: { $or: [{ amount: { $gt: 100 } }, { $not: { vip: false } }] } },
        { $fn: 'sum', $expr: { $op: '*', $args: ['price', 'qty'] }, $as: 'paid', $where: { paidAt: { $exists: true } } },
        { $fn: 'countDistinct', $field: ['a', 'b'], $as: 'n', $where: { secret: { $regex: '^x' } } },
      ],
    }
    const insights = computeInsights(undefined, controls)
    expect(plain(insights)).toEqual({
      projectId: ['$groupBy', '$select'],
      '*': ['count'],
      status: ['$eq'],
      amount: ['$gt', 'sum'],
      vip: ['$eq'],
      price: ['sum'],
      qty: ['sum'],
      paidAt: ['$exists'],
      a: ['countDistinct'],
      b: ['countDistinct'],
      secret: ['$regex'],
    })
    // the same operators as the equivalent filter
    const asFilter = computeInsights({ status: 'ESTIMATED', secret: { $regex: '^x' }, paidAt: { $exists: true } })
    for (const field of ['status', 'secret', 'paidAt']) expect(insights.get(field)).toEqual(asFilter.get(field))
  })

  it('reports relational predicates in $where like the filter does (nav-prefixed)', () => {
    const insights = computeInsights(undefined, {
      $groupBy: ['g'],
      $select: [{ $fn: 'count', $field: '*', $as: 'c', $where: { tags: { $some: { label: 'hot' } } } }],
    })
    expect(insights.get('tags')).toEqual(new Set(['$some']))
    expect(insights.get('tags.label')).toEqual(new Set(['$eq']))
  })
})

describe('computeInsights – two-level aggregates ($from)', () => {
  const controls = {
    $from: {
      $groupBy: ['userId', 'day'],
      $select: [
        { $bucket: 'day', $field: 'createdAt', $as: 'day' },
        { $fn: 'count', $field: '*', $as: 'n' },
        { $fn: 'count', $field: '*', $as: 'est', $where: { status: 'ESTIMATED' } },
        { $fn: 'first', $field: 'title', $as: 'firstTitle' },
      ],
      $rowOrder: { createdAt: 1 },
      $having: { n: { $gt: 0 } },
    },
    $groupBy: ['userId'],
    $select: [
      'userId',
      { $fn: 'avg', $field: 'n', $as: 'avgDaily' },
      { $fn: 'count', $field: '*', $as: 'busy', $where: { est: { $gt: 3 } } },
    ],
    $sort: { avgDaily: -1 },
    $rowOrder: { day: 1 },
  } as UniqueryControls

  it('reports the inner level, and root names that are not computed aliases of either level', () => {
    const insights = computeInsights({ projectId: 7 }, controls)
    expect(plain(insights)).toEqual({
      projectId: ['$eq'],
      userId: ['$groupBy', '$select'],
      createdAt: ['$bucket', '$groupBy', '$order'],
      '*': ['$having', 'count'],
      status: ['$eq'],
      title: ['first'],
    })
  })

  it('fail closed: a root name that is no alias is reported with its usual op (an engine ignoring $from reads the table)', () => {
    const probe = {
      ...controls,
      $groupBy: ['userId', 'secretKey'],
      $select: [...(controls.$select as unknown[]), 'email', { $fn: 'count', $field: '*', $as: 'c', $where: { hidden: { $gt: 3 } } }],
      $sort: { avgDaily: -1, cost: 1 },
      $rowOrder: { salary: 1 },
      $having: { margin: { $gt: 0 } },
    } as UniqueryControls
    const insights = computeInsights(undefined, probe)
    expect(insights.get('secretKey')).toEqual(new Set(['$groupBy']))
    expect(insights.get('email')).toEqual(new Set(['$select']))
    expect(insights.get('hidden')).toEqual(new Set(['$gt']))
    expect(insights.get('cost')).toEqual(new Set(['$order']))
    expect(insights.get('salary')).toEqual(new Set(['$order']))
    expect(insights.get('margin')).toEqual(new Set(['$having']))
    // aliases of either level are not table fields
    for (const alias of ['n', 'est', 'day', 'avgDaily', 'busy', 'c']) expect(insights.has(alias), alias).toBe(false)
  })

  it('the value-help probe: a $from with only a $groupBy cannot hide a root $sort', () => {
    const insights = computeInsights(undefined, { $groupBy: ['x'], $from: { $groupBy: ['id'] }, $sort: { cost: 1 } })
    expect(plain(insights)).toEqual({ id: ['$groupBy'], x: ['$groupBy'], cost: ['$order'] })
  })

  it('a root $with is reported (and resolveNested rejects it)', () => {
    const insights = computeInsights(undefined, {
      ...controls,
      $with: [{ name: 'secretRel', filter: { x: 1 }, controls: {} }],
    } as UniqueryControls)
    expect(insights.get('secretRel')).toEqual(new Set(['$with']))
    expect(insights.get('secretRel.x')).toEqual(new Set(['$eq']))
  })

  it('a $from inside a $with relation is not stage-aware: everything is reported, plus the $from marker', () => {
    const insights = computeInsights(undefined, {
      $with: [{ name: 'rel', filter: {}, controls: { $from: { $groupBy: ['x'] }, $groupBy: ['secret'], $sort: { n: 1 } } }],
    })
    expect(plain(insights)).toEqual({
      rel: ['$with'],
      'rel.$from': ['$from'],
      'rel.x': ['$groupBy'],
      'rel.secret': ['$groupBy'],
      'rel.n': ['$order'],
    })
  })

  it('a malformed $from is reported under the $from marker, with every root name', () => {
    const insights = computeInsights(undefined, { ...controls, $from: 'x' } as UniqueryControls)
    expect(insights.get('$from')).toEqual(new Set(['$from']))
    expect(insights.has('userId')).toBe(true)
    expect(insights.get('n')).toEqual(new Set(['avg', '$order']))
  })

  it('getInsights uses the same rule', () => {
    const q: Uniquery = { filter: { projectId: 7 }, controls: { ...controls, $sort: { cost: 1 } } as UniqueryControls }
    expect(getInsights(q).get('cost')).toEqual(new Set(['$order']))
    expect(getInsights(q).has('avgDaily')).toBe(false)
  })
})

describe('computeInsights – malformed input never throws and fails closed', () => {
  it('a $where that is not a filter object is reported under the $where marker, not walked', () => {
    for (const $where of [[{ secret: 1 }], 'secret=1', 5, null, { $and: 'x' }, { $or: { a: 1 } }]) {
      const insights = computeInsights(undefined, {
        $groupBy: ['a'],
        $select: [{ $fn: 'count', $field: '*', $as: 'n', $where: $where as never }],
      })
      expect(plain(insights), JSON.stringify($where)).toEqual({ a: ['$groupBy'], '*': ['count'], $where: ['$where'] })
    }
  })

  it('a $where with a malformed structure is reported under the $where marker, not walked (no fake fields)', () => {
    for (const $where of [{ $not: 5 }, { a: [1, 2] }, { $and: ['ab'] }, { ok: 1, t: { $some: 'x' } }]) {
      const insights = computeInsights(undefined, {
        $groupBy: ['g'],
        $select: [{ $fn: 'count', $field: '*', $as: 'n', $where: $where as never }],
      })
      expect(plain(insights), JSON.stringify($where)).toEqual({ g: ['$groupBy'], '*': ['count'], $where: ['$where'] })
    }
  })

  it('a malformed filter, $having, $groupBy, $select, $sort, $rowOrder or $with is reported under its marker', () => {
    const insights = computeInsights({ $and: 'x' } as never, {
      $groupBy: 5,
      $select: 7,
      $having: { $or: 1 },
      $sort: 'cost',
      $rowOrder: ['a'],
      $with: { name: 'rel' },
    } as never)
    expect(plain(insights)).toEqual({
      $filter: ['$filter'],
      $groupBy: ['$groupBy'],
      $select: ['$select'],
      $having: ['$having'],
      $sort: ['$sort'],
      $rowOrder: ['$rowOrder'],
      $with: ['$with'],
    })
    expect(plain(computeInsights(undefined, { $with: [null, { name: 1 }] } as never))).toEqual({ $with: ['$with'] })
  })

  it('a $select entry of no known kind is reported under the $select marker', () => {
    const insights = computeInsights(undefined, {
      $groupBy: ['a'],
      $select: ['a', { $fn: 'countDistinct', $field: ['secret', 1] }, { $fn: 'sum', $field: 'x', $expr: 'y', $as: 's' }, null],
    } as never)
    expect(plain(insights)).toEqual({ a: ['$groupBy', '$select'], $select: ['$select'] })
  })

  it('a string $groupBy is reported as one field, not as its characters', () => {
    expect(plain(computeInsights(undefined, { $groupBy: 'secret' } as never))).toEqual({ secret: ['$groupBy'] })
  })

  it('never throws on hostile shapes', () => {
    const bad: unknown[] = [null, 1, 'x', [], { $from: null }, { $from: { $select: 'x', $groupBy: 3 } }, { $select: [null, 1, { $fn: 1 }] }]
    for (const c of bad) expect(() => computeInsights(undefined, c as never)).not.toThrow()
  })
})
