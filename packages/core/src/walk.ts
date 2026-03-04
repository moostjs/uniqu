import type {
  FilterExpr,
  ComparisonNode,
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
 * - Multi-field ComparisonNodes are combined via `visitor.and(...)`.
 */
export function walkFilter<R>(expr: FilterExpr, visitor: FilterVisitor<R>): R {
  // Guard with !== undefined to handle malformed objects (e.g. from JSON.parse)
  // where a key exists but has value undefined/null due to the `never` typed fields.
  if ('$and' in expr && expr.$and !== undefined) {
    const children = (expr as { $and: FilterExpr[] }).$and.map((child) =>
      walkFilter(child, visitor),
    )
    return visitor.and(children)
  }

  if ('$or' in expr && expr.$or !== undefined) {
    const children = (expr as { $or: FilterExpr[] }).$or.map((child) =>
      walkFilter(child, visitor),
    )
    return visitor.or(children)
  }

  if ('$not' in expr && expr.$not !== undefined) {
    const child = walkFilter((expr as { $not: FilterExpr }).$not, visitor)
    return visitor.not(child)
  }

  const node = expr as ComparisonNode
  const entries = Object.entries(node)

  if (entries.length === 0) {
    return visitor.and([])
  }

  const results: R[] = []

  for (const [field, value] of entries) {
    if (isPrimitive(value)) {
      results.push(visitor.comparison(field, '$eq', value))
    } else {
      const ops = value as FieldOps
      for (const [op, opValue] of Object.entries(ops)) {
        results.push(
          visitor.comparison(
            field,
            op as ComparisonOp,
            opValue as Primitive | Primitive[],
          ),
        )
      }
    }
  }

  return results.length === 1 ? results[0] : visitor.and(results)
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
