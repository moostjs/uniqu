/**
 * Scalar value types supported in filter expressions.
 *
 * `Date` is included for direct code usage (e.g. `{ createdAt: { $gt: new Date() } }`).
 * The URL parser produces ISO strings, not `Date` instances.
 * Adapters are responsible for handling both: convert `Date` to their native format
 * (e.g. `.toISOString()` for SQL params, native `Date` for MongoDB).
 */
export type Primitive = string | number | boolean | null | RegExp | Date

/** All comparison operators supported by the filter format. */
export type ComparisonOp =
  | '$eq'
  | '$ne'
  | '$gt'
  | '$gte'
  | '$lt'
  | '$lte'
  | '$in'
  | '$nin'
  | '$regex'
  | '$exists'

/**
 * Per-field typed operator map. When `V` is the field's value type, operators
 * are constrained accordingly:
 * - `$regex` is only available when `V` extends `string`
 * - `$gt/$gte/$lt/$lte` are only available when `V` extends `number | string | Date`
 */
export type FieldOpsFor<V> = {
  $eq?: V
  $ne?: V
  $in?: V[]
  $nin?: V[]
  $exists?: boolean
} & (V extends string ? { $regex?: RegExp | string } : {}) &
  (V extends number | string | Date
    ? { $gt?: V; $gte?: V; $lt?: V; $lte?: V }
    : {})

/** Untyped operator map. */
export type FieldOps = FieldOpsFor<Primitive>

/** A field can hold a bare primitive (implicit $eq) or an explicit operator map. */
export type FieldValue = Primitive | FieldOps

/**
 * A filter expression is either a comparison leaf or a logical branch.
 * `T` is the entity shape — provides type-safe field names and value types.
 * Defaults to `Record<string, unknown>` (untyped).
 */
export type FilterExpr<T = Record<string, unknown>> =
  | ComparisonNode<T>
  | LogicalNode<T>

/**
 * Leaf node: one or more field comparisons.
 * Known keys from `T` get typed values; arbitrary string keys
 * (e.g. dot-notation paths like `"client.age"`) are always allowed.
 */
export type ComparisonNode<T = Record<string, unknown>> = {
  [K in keyof T & string]?: T[K] | FieldOpsFor<T[K]>
} & Record<string, unknown>

/**
 * Branch node: logical combination of child expressions.
 * Each variant forbids the other logical keys via `never` to prevent
 * mixing comparison fields with logical operators at the type level.
 */
export type LogicalNode<T = Record<string, unknown>> =
  | { $and: FilterExpr<T>[]; $or?: never; $not?: never }
  | { $or: FilterExpr<T>[]; $and?: never; $not?: never }
  | { $not: FilterExpr<T>; $and?: never; $or?: never }

/** Query controls (pagination, projection, sorting). Generic `T` constrains field names in `$select` and `$sort`. */
export interface UniqueryControls<T = Record<string, unknown>> {
  $sort?: Partial<Record<keyof T & string, 1 | -1>>
  $skip?: number
  $limit?: number
  $count?: boolean
  $select?: (keyof T & string)[] | Partial<Record<keyof T & string, 0 | 1>>
  /** Relations to populate alongside the query. */
  $with?: WithRelation[]
  /** Pass-through for unknown $-prefixed keywords. */
  [key: `$${string}`]: unknown
}

/**
 * Canonical query representation.
 * When `name` is present this is a nested relation (sub-query inside `$with`).
 * When absent it is the root query.
 */
export interface Uniquery<T = Record<string, unknown>> {
  /** Relation name. Present only for nested `$with` sub-queries. */
  name?: string
  filter: FilterExpr<T>
  controls: UniqueryControls<T>
  /** Pre-computed insights. */
  insights?: UniqueryInsights
}

/** A `$with` relation — a `Uniquery` with a required `name`. */
export type WithRelation = Uniquery & { name: string }

/** Insight operator includes comparison ops plus control-derived ops. */
export type InsightOp = ComparisonOp | '$select' | '$order' | '$with'

/** Map of field names to the set of operators used on that field. */
export type UniqueryInsights = Map<string, Set<InsightOp>>
