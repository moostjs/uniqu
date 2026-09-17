import type {
  FilterExpr,
  ComparisonOp,
  FieldOps,
  Primitive,
} from './types'

/**
 * Visitor callbacks for controlling how filter nodes are processed.
 * Generic parameter `R` is the return type — `string` for SQL rendering,
 * `boolean` for validation, `FilterExpr` for AST transforms, `void` for
 * side-effect-only traversals (e.g. insight collection).
 */
export interface FilterVisitor<R> {
  /** Called for each field comparison. */
  comparison(field: string, op: ComparisonOp, value: Primitive | Primitive[]): R
  /** Combine children with AND logic. */
  and(children: R[]): R
  /** Combine children with OR logic. */
  or(children: R[]): R
  /** Negate a child expression. */
  not(child: R): R
}

/**
 * Walk a filter expression tree, calling visitor callbacks at each node.
 * Returns the fully assembled result from the visitor.
 *
 * - Bare primitive values are normalized to `comparison(field, '$eq', value)`.
 * - Every member of an object is combined with implicit AND, in key insertion
 *   order — comparison fields and logical operators may be mixed freely
 *   (Mongo semantics): `{ id: 101, $or: [...] }` is equivalent to
 *   `{ $and: [{ id: 101 }, { $or: [...] }] }`. A field with several operators
 *   contributes one `comparison` per operator.
 * - A node that yields a single result returns it unwrapped (no surrounding
 *   `and`); an empty node yields `visitor.and([])`.
 */
export function walkFilter<R>(expr: FilterExpr | undefined, visitor: FilterVisitor<R>): R | undefined {
  if (!expr) return undefined

  const results: R[] = []

  for (const [key, value] of Object.entries(expr as Record<string, unknown>)) {
    if (isLogicalKey(key)) {
      // Guard with !== undefined to handle malformed objects (e.g. from JSON.parse)
      // where a logical key exists but has value undefined.
      if (value !== undefined) results.push(walkLogical(key, value, visitor))
    } else if (isPrimitive(value)) {
      results.push(visitor.comparison(key, '$eq', value))
    } else {
      for (const [op, opValue] of Object.entries(value as FieldOps)) {
        results.push(
          visitor.comparison(key, op as ComparisonOp, opValue as Primitive | Primitive[]),
        )
      }
    }
  }

  return results.length === 1 ? results[0] : visitor.and(results)
}

function walkLogical<R>(
  key: '$and' | '$or' | '$not',
  value: unknown,
  visitor: FilterVisitor<R>,
): R {
  if (key === '$not') {
    return visitor.not(walkFilter(value as FilterExpr, visitor) as R)
  }

  const children = (value as FilterExpr[]).map((child) => walkFilter(child, visitor) as R)
  return key === '$and' ? visitor.and(children) : visitor.or(children)
}

/** Type guard for the logical keys a filter node may carry. */
export function isLogicalKey(key: string): key is '$and' | '$or' | '$not' {
  return key === '$and' || key === '$or' || key === '$not'
}

export function isPrimitive(x: unknown): x is Primitive {
  if (x === null || typeof x !== 'object') {
    return true
  }
  // Known built-in value types
  if (x instanceof RegExp || x instanceof Date) {
    return true
  }
  // Non-plain objects (class instances like ObjectId, Decimal128, Buffer, etc.)
  // are leaf values — only plain objects { $gt: 5 } are operator maps.
  if (!Array.isArray(x) && x.constructor !== undefined && x.constructor !== Object) {
    return true
  }
  return false
}
