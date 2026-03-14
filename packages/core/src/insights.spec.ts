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
    expect(insights.get('amount')).toEqual(new Set(['sum']))
    expect(insights.get('total')).toEqual(new Set(['$order']))
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
