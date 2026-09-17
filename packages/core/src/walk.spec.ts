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

  it('treats class instances as leaf values (not operator maps)', () => {
    // Simulates ObjectId, Decimal128, Buffer, etc.
    class CustomId {
      constructor(public value: string) {}
      toString() { return this.value }
    }

    const id = new CustomId('abc123')
    const expr: FilterExpr = { _id: id } as any
    const { calls, visitor } = collectingVisitor()
    walkFilter(expr, visitor)

    expect(calls).toEqual([
      { type: 'comparison', field: '_id', op: '$eq', value: id },
    ])
  })

  it('does not treat plain objects as leaf values', () => {
    const expr: FilterExpr = { age: { $gte: 18 } }
    const { calls, visitor } = collectingVisitor()
    walkFilter(expr, visitor)

    expect(calls[0]).toEqual({
      type: 'comparison', field: 'age', op: '$gte', value: 18,
    })
  })

  it('does not treat arrays as leaf values', () => {
    const expr: FilterExpr = { role: { $in: ['Admin', 'Editor'] } }
    const { calls, visitor } = collectingVisitor()
    walkFilter(expr, visitor)

    expect(calls[0]).toEqual({
      type: 'comparison', field: 'role', op: '$in', value: ['Admin', 'Editor'],
    })
  })

  it('walks a mixed comparison + $or node as an implicit AND', () => {
    const expr: FilterExpr = {
      id: 101,
      nextRefreshAt: { $lte: 1000 },
      $or: [{ status: 'a' }, { status: 'b' }],
    }
    const { calls, visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe(
      'id $eq 101 AND nextRefreshAt $lte 1000 AND (status $eq a OR status $eq b)',
    )
    expect(calls).toEqual([
      { type: 'comparison', field: 'id', op: '$eq', value: 101 },
      { type: 'comparison', field: 'nextRefreshAt', op: '$lte', value: 1000 },
      { type: 'comparison', field: 'status', op: '$eq', value: 'a' },
      { type: 'comparison', field: 'status', op: '$eq', value: 'b' },
      { type: 'or', count: 2 },
      { type: 'and', count: 3 },
    ])
  })

  it('walks a mixed node nested inside a logical branch', () => {
    const expr: FilterExpr = {
      $and: [{ a: 1, $or: [{ b: 2 }, { c: 3 }] }],
    }
    const { calls, visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('a $eq 1 AND (b $eq 2 OR c $eq 3)')
    expect(calls).toEqual([
      { type: 'comparison', field: 'a', op: '$eq', value: 1 },
      { type: 'comparison', field: 'b', op: '$eq', value: 2 },
      { type: 'comparison', field: 'c', op: '$eq', value: 3 },
      { type: 'or', count: 2 },
      { type: 'and', count: 2 },
      { type: 'and', count: 1 },
    ])
  })

  it('walks $not alongside a comparison field', () => {
    const expr: FilterExpr = { a: 1, $not: { status: 'DELETED' } }
    const { calls, visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('a $eq 1 AND NOT (status $eq DELETED)')
    expect(calls).toEqual([
      { type: 'comparison', field: 'a', op: '$eq', value: 1 },
      { type: 'comparison', field: 'status', op: '$eq', value: 'DELETED' },
      { type: 'not' },
      { type: 'and', count: 2 },
    ])
  })

  it('walks several logical keys plus a field in one node', () => {
    const expr: FilterExpr = {
      a: 1,
      $and: [{ b: 2 }, { c: 3 }],
      $or: [{ d: 4 }, { e: 5 }],
    }
    const { calls, visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('a $eq 1 AND b $eq 2 AND c $eq 3 AND (d $eq 4 OR e $eq 5)')
    expect(calls).toEqual([
      { type: 'comparison', field: 'a', op: '$eq', value: 1 },
      { type: 'comparison', field: 'b', op: '$eq', value: 2 },
      { type: 'comparison', field: 'c', op: '$eq', value: 3 },
      { type: 'and', count: 2 },
      { type: 'comparison', field: 'd', op: '$eq', value: 4 },
      { type: 'comparison', field: 'e', op: '$eq', value: 5 },
      { type: 'or', count: 2 },
      { type: 'and', count: 3 },
    ])
  })

  it('ignores a logical key with an undefined value', () => {
    // Malformed object, e.g. from JSON.parse or an optional spread.
    const expr = { a: 1, $and: undefined } as FilterExpr
    const { calls, visitor } = collectingVisitor()
    const result = walkFilter(expr, visitor)

    expect(result).toBe('a $eq 1')
    expect(calls).toEqual([
      { type: 'comparison', field: 'a', op: '$eq', value: 1 },
    ])
  })

  it('a mixed node narrows the affected rows (no sibling drop)', () => {
    type Row = Record<string, unknown>
    const visitor: FilterVisitor<(row: Row) => boolean> = {
      comparison(field, op, value) {
        if (op !== '$eq') throw new Error(`unsupported op ${op}`)
        return (row) => row[field] === value
      },
      and: (children) => (row) => children.every((child) => child(row)),
      or: (children) => (row) => children.some((child) => child(row)),
      not: (child) => (row) => !child(row),
    }

    const expr: FilterExpr = { id: 101, $or: [{ status: 'a' }, { status: 'b' }] }
    const matches = walkFilter(expr, visitor)!
    const rows: Row[] = [
      { id: 101, status: 'a' },
      { id: 102, status: 'a' },
    ]

    expect(rows.filter(matches)).toEqual([{ id: 101, status: 'a' }])
  })

  it('rejects logical nodes combining two logical operators at the type level', () => {
    // @ts-expect-error — $or node cannot have $and
    const _mixedLogical: LogicalNode = { $or: [], $and: [] }

    // @ts-expect-error — $not node cannot have $or
    const _mixedNot: LogicalNode = { $not: {}, $or: [] }

    // These exist only for compile-time checking
    expect(true).toBe(true)
  })
})
