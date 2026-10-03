import { describe, it, expect } from 'vitest'
import { walkFilter, RELATION_OPS, isRelationOp, isRelationPredicate, hasRelationOp, type FilterVisitor } from './walk'
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

describe('walkFilter – relational predicates', () => {
  function relVisitor() {
    const calls: Array<{ field: string; op: string; operand: FilterExpr }> = []
    const visitor: FilterVisitor<string> = {
      comparison: (field, op, value) => `${field} ${op} ${String(value)}`,
      and: (children) => children.join(' AND '),
      or: (children) => `(${children.join(' OR ')})`,
      not: (child) => `NOT (${child})`,
      relation(field, op, operand) {
        calls.push({ field, op, operand })
        return `${field} ${op} [${Object.keys(operand).join(',')}]`
      },
    }
    return { calls, visitor }
  }

  it('dispatches $some / $none to visitor.relation without walking the operand', () => {
    const { calls, visitor } = relVisitor()
    const operand = { status: 'open', team: { $some: { name: 'x' } } }
    const result = walkFilter({ ticket: { $some: operand } }, visitor)
    expect(result).toBe('ticket $some [status,team]')
    expect(calls).toEqual([{ field: 'ticket', op: '$some', operand }])
    expect(calls[0].operand).toBe(operand)
  })

  it('combines several relation ops on one key and siblings with AND', () => {
    const { calls, visitor } = relVisitor()
    const result = walkFilter(
      { title: 'a', ticket: { $some: { status: 'open' }, $none: {} } },
      visitor,
    )
    expect(result).toBe('title $eq a AND ticket $some [status] AND ticket $none []')
    expect(calls.map((c) => c.op)).toEqual(['$some', '$none'])
  })

  it('reaches predicates under $or / $not', () => {
    const { visitor } = relVisitor()
    expect(walkFilter({ $or: [{ id: 1 }, { $not: { ticket: { $none: {} } } }] }, visitor)).toBe(
      '(id $eq 1 OR NOT (ticket $none []))',
    )
  })

  it('dispatches each op of a mixed operator map to its own callback', () => {
    const { visitor } = relVisitor()
    expect(walkFilter({ ticket: { $some: {}, $eq: 1 } } as FilterExpr, visitor)).toBe(
      'ticket $some [] AND ticket $eq 1',
    )
  })

  it('throws when the visitor has no relation callback', () => {
    const { visitor } = collectingVisitor()
    expect(() => walkFilter({ ticket: { $some: { status: 'open' } } }, visitor)).toThrow(
      'Relational predicate "$some" on "ticket" is not supported by this filter visitor',
    )
  })

  it('leaves predicate-free filters untouched for visitors without relation', () => {
    const { visitor } = collectingVisitor()
    expect(walkFilter({ some: 1, none: { $ne: 2 } }, visitor)).toBe('some $eq 1 AND none $ne 2')
  })
})

describe('relation helpers', () => {
  it('RELATION_OPS / isRelationOp', () => {
    expect(RELATION_OPS).toEqual(['$some', '$none'])
    expect(Object.isFrozen(RELATION_OPS)).toBe(true)
    expect(isRelationOp('$some')).toBe(true)
    expect(isRelationOp('$none')).toBe(true)
    expect(isRelationOp('$every')).toBe(false)
    expect(isRelationOp('$eq')).toBe(false)
  })

  it('isRelationPredicate', () => {
    expect(isRelationPredicate({ $some: {} })).toBe(true)
    expect(isRelationPredicate({ $some: {}, $none: { a: 1 } })).toBe(true)
    expect(isRelationPredicate({})).toBe(false)
    expect(isRelationPredicate({ $some: {}, $eq: 1 })).toBe(false)
    expect(isRelationPredicate({ $eq: 1 })).toBe(false)
    expect(isRelationPredicate('x')).toBe(false)
    expect(isRelationPredicate(null)).toBe(false)
    expect(isRelationPredicate([{ $some: {} }])).toBe(false)
    expect(isRelationPredicate(new Date())).toBe(false)
    // malformed operands are not well-formed predicates
    expect(isRelationPredicate({ $some: undefined })).toBe(false)
    expect(isRelationPredicate({ $some: null })).toBe(false)
    expect(isRelationPredicate({ $some: [] })).toBe(false)
    expect(isRelationPredicate({ $some: 'x' })).toBe(false)
    expect(isRelationPredicate({ $some: {}, $none: 1 })).toBe(false)
  })

  it('hasRelationOp spots any relation-op key, including malformed / mixed maps', () => {
    expect(hasRelationOp({ $some: {} })).toBe(true)
    expect(hasRelationOp({ $some: undefined })).toBe(true)
    expect(hasRelationOp({ $some: {}, $eq: 5 })).toBe(true)
    expect(hasRelationOp({ $eq: 5 })).toBe(false)
    expect(hasRelationOp({})).toBe(false)
    expect(hasRelationOp([{ $some: {} }])).toBe(false)
    expect(hasRelationOp('x')).toBe(false)
    expect(hasRelationOp(null)).toBe(false)
  })

  it('hasRelationOp treats non-plain values as leaves, like walkFilter', () => {
    class Id {
      $some = {}
    }
    const id = new Id()
    expect(hasRelationOp(id)).toBe(false)
    expect(hasRelationOp(Object.assign(/x/, { $some: {} }))).toBe(false)
    expect(hasRelationOp(Object.assign(Object.create(null), { $some: {} }))).toBe(true)
    // walkFilter compares the instance as a value, never dispatches `relation`
    const seen: string[] = []
    walkFilter({ a: id } as never, {
      comparison: (f, op) => void seen.push(`${f}${op}`),
      and: () => undefined,
      or: () => undefined,
      not: () => undefined,
    })
    expect(seen).toEqual(['a$eq'])
  })
})
