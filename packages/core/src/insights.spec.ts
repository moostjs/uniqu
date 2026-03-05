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
      $with: [{ name: 'posts' }, { name: 'posts.author' }],
    }
    const insights = computeInsights(filter, controls)

    expect(insights.get('status')).toEqual(new Set(['$eq']))
    expect(insights.get('posts')).toEqual(new Set(['$with']))
    expect(insights.get('posts.author')).toEqual(new Set(['$with']))
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
