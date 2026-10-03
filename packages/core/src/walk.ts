import type {
  FilterExpr,
  ComparisonOp,
  FieldOps,
  Primitive,
  RelationOp,
  RelationPredicate,
} from './types'

/** Relational predicate operators, in canonical order (frozen). */
export const RELATION_OPS: readonly RelationOp[] = Object.freeze(['$some', '$none'] as const)

/** True when `op` is a relational predicate operator (`$some` / `$none`). */
export function isRelationOp(op: string): op is RelationOp {
  return op === '$some' || op === '$none'
}

/** True for a plain object (`{}` literal or null-prototype) — not an array, RegExp, Date or class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * True when `value` is a well-formed relational predicate operator map: a
 * plain object with at least one key, every key a relation op and every
 * operand a plain object (`{ $some: {...} }`, `{ $some: {...}, $none: {...} }`).
 * `{ $some: undefined }` and mixed maps (`{ $some: {...}, $eq: 1 }`) are not.
 */
export function isRelationPredicate(value: unknown): value is RelationPredicate {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  return keys.length > 0 && keys.every((k) => isRelationOp(k) && isPlainObject(value[k]))
}

/**
 * True when `value` is an object carrying ANY relation-op key — including
 * malformed or mixed maps (`{ $some: undefined }`, `{ $some: {...}, $eq: 1 }`).
 * `walkFilter` dispatches every `$some` / `$none` key to `visitor.relation`
 * whatever its siblings, so a gate deciding whether a filter value needs
 * relational handling should test this, and reject values for which it holds
 * but {@link isRelationPredicate} does not.
 */
export function hasRelationOp(value: unknown): boolean {
  // Same leaf test as `walkFilter`: a primitive or a non-plain value (RegExp,
  // Date, class instance) is a comparison value, never an operator map.
  return !isPrimitive(value) && Object.keys(value as object).some(isRelationOp)
}

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
  /**
   * Called for a relational predicate `{ field: { $some | $none: operand } }`.
   * The walker does NOT recurse into `operand` — it is a filter on another
   * entity (the relation's target); the visitor decides what to do with it
   * (render a subquery, prefix insights, …). When absent, a filter containing
   * a predicate makes `walkFilter` throw.
   */
  relation?(field: string, op: RelationOp, operand: FilterExpr): R
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
 * - A relational operator (`$some` / `$none`) on a field dispatches to
 *   `visitor.relation(field, op, operand)` without walking `operand`; a
 *   visitor without `relation` makes the walk throw.
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
        if (isRelationOp(op)) {
          if (!visitor.relation) {
            throw new Error(
              `Relational predicate "${op}" on "${key}" is not supported by this filter visitor`,
            )
          }
          results.push(visitor.relation(key, op, opValue as unknown as FilterExpr))
          continue
        }
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
