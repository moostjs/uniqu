import { describe, it, expect } from 'vitest'
import { walkFilter, type FilterVisitor } from './walk'
import type { FilterExpr, LogicalNode, ComparisonOp, Primitive } from './types'

/** Collects all visitor calls as structured records. */
function collectingVisitor() {
  const calls: Array<
    | { type: 'comparison'; field: string; op: ComparisonOp; value: Primitive | Primitive[] }
    | { type: 'and'; count: number }
    | { type: 'or'; count: number }
    | { type: 'not' }
  > = []

  const visitor: FilterVisitor<string> = {
    comparison(field, op, value) {
      calls.push({ type: 'comparison', field, op, value })
      return `${field} ${op} ${value}`
    },
    and(children) {
      calls.push({ type: 'and', count: children.length })
      return children.join(' AND ')
    },
    or(children) {
      calls.push({ type: 'or', count: children.length })
      return `(${children.join(' OR ')})`
    },
    not(child) {
      calls.push({ type: 'not' })
      return `NOT (${child})`
    },
  }

  return { calls, visitor }
}

describe('walkFilter', () => {
  it('walks a single field with bare primitive (implicit $eq)', () => {
    const expr: FilterExpr = { name: 'John' }
    const { calls, visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('name $eq John')
    expect(calls).toEqual([
      { type: 'comparison', field: 'name', op: '$eq', value: 'John' },
    ])
  })

  it('walks a single field with explicit operator', () => {
    const expr: FilterExpr = { age: { $gte: 18 } }
    const { calls, visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('age $gte 18')
    expect(calls).toEqual([
      { type: 'comparison', field: 'age', op: '$gte', value: 18 },
    ])
  })

  it('walks multi-field node as implicit AND', () => {
    const expr: FilterExpr = { age: { $gte: 18 }, status: 'active' }
    const { calls, visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('age $gte 18 AND status $eq active')
    expect(calls).toEqual([
      { type: 'comparison', field: 'age', op: '$gte', value: 18 },
      { type: 'comparison', field: 'status', op: '$eq', value: 'active' },
      { type: 'and', count: 2 },
    ])
  })

  it('walks multi-operator field', () => {
    const expr: FilterExpr = { age: { $gte: 18, $lte: 30 } }
    const { calls, visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('age $gte 18 AND age $lte 30')
    expect(calls).toEqual([
      { type: 'comparison', field: 'age', op: '$gte', value: 18 },
      { type: 'comparison', field: 'age', op: '$lte', value: 30 },
      { type: 'and', count: 2 },
    ])
  })

  it('walks $and node', () => {
    const expr: FilterExpr = {
      $and: [{ age: { $gte: 18 } }, { status: 'active' }],
    }
    const { visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('age $gte 18 AND status $eq active')
  })

  it('walks $or node', () => {
    const expr: FilterExpr = {
      $or: [{ age: { $gt: 25 } }, { status: 'VIP' }],
    }
    const { visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('(age $gt 25 OR status $eq VIP)')
  })

  it('walks nested $or inside $and', () => {
    const expr: FilterExpr = {
      $and: [
        {
          $or: [{ status: { $ne: 'DELETED' } }, { role: { $in: ['Admin', 'Editor'] } }],
        },
        { age: { $gte: 18 } },
      ],
    }
    const { visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe(
      '(status $ne DELETED OR role $in Admin,Editor) AND age $gte 18',
    )
  })

  it('handles empty node', () => {
    const expr: FilterExpr = {}
    const { calls, visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('')
    expect(calls).toEqual([{ type: 'and', count: 0 }])
  })

  it('handles $exists operator', () => {
    const expr: FilterExpr = { phone: { $exists: true } }
    const { visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('phone $exists true')
  })

  it('handles $in with array value', () => {
    const expr: FilterExpr = { role: { $in: ['Admin', 'Editor'] } }
    const { calls, visitor } = collectingVisitor()
    walkFilter(expr, visitor)

    expect(calls[0]).toEqual({
      type: 'comparison',
      field: 'role',
      op: '$in',
      value: ['Admin', 'Editor'],
    })
  })

  it('handles null and boolean primitives', () => {
    const expr: FilterExpr = { deleted: null, active: true }
    const { calls, visitor } = collectingVisitor()
    walkFilter(expr, visitor)

    expect(calls[0]).toEqual({
      type: 'comparison',
      field: 'deleted',
      op: '$eq',
      value: null,
    })
    expect(calls[1]).toEqual({
      type: 'comparison',
      field: 'active',
      op: '$eq',
      value: true,
    })
  })

  it('walks $not node', () => {
    const expr: FilterExpr = {
      $not: { age: { $gt: 18 }, status: 'active' },
    }
    const { calls, visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('NOT (age $gt 18 AND status $eq active)')
    expect(calls).toEqual([
      { type: 'comparison', field: 'age', op: '$gt', value: 18 },
      { type: 'comparison', field: 'status', op: '$eq', value: 'active' },
      { type: 'and', count: 2 },
      { type: 'not' },
    ])
  })

  it('walks nested $not inside $and', () => {
    const expr: FilterExpr = {
      $and: [
        { $not: { status: 'DELETED' } },
        { age: { $gte: 18 } },
      ],
    }
    const { visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('NOT (status $eq DELETED) AND age $gte 18')
  })

  it('walks $not wrapping $or', () => {
    const expr: FilterExpr = {
      $not: {
        $or: [{ role: 'Guest' }, { role: 'Anonymous' }],
      },
    }
    const { visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('NOT ((role $eq Guest OR role $eq Anonymous))')
  })

  it('works with void visitor (side-effect only)', () => {
    const fields: string[] = []
    const visitor: FilterVisitor<void> = {
      comparison(field) {
        fields.push(field)
      },
      and() {},
      or() {},
      not() {},
    }

    const expr: FilterExpr = {
      $or: [{ age: { $gte: 18 } }, { name: 'John', status: 'active' }],
    }
    walkFilter(expr, visitor)

    expect(fields).toEqual(['age', 'name', 'status'])
  })

  it('rejects mixed comparison+logical nodes at the type level', () => {
    // @ts-expect-error — $or node cannot have $and
    const _mixedLogical: LogicalNode = { $or: [], $and: [] }

    // @ts-expect-error — $not node cannot have $or
    const _mixedNot: LogicalNode = { $not: {}, $or: [] }

    // These exist only for compile-time checking
    expect(true).toBe(true)
  })
})
