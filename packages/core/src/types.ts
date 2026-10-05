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

/** Relational predicate operators: `$some` (a related row matches), `$none` (no related row matches). */
export type RelationOp = '$some' | '$none'

/** Own (non-navigation) props of an entity type (`__ownProps`), or untyped. */
export type OwnOf<E> = [E] extends [{ __ownProps: infer F }] ? F : Record<string, unknown>

/** Navigation props of an entity type (`__navProps`), or none. */
export type NavOf<E> = [E] extends [{ __navProps: infer N extends Record<string, unknown> }] ? N : {}

/**
 * Relational predicate on a navigation field: filters the PARENT rows by the
 * existence of related rows. `E` is the related entity type (array element
 * for to-many relations). Several operators on one key are ANDed.
 *
 * - `{ ticket: { $some: { status: 'open' } } }` — at least one related row matches
 * - `{ ticket: { $none: { status: 'open' } } }` — no related row matches
 * - `$some: {}` / `$none: {}` — has any related row / has none
 *
 * There is no `$every`: write `$none: { $not: F }`.
 */
export type RelationPredicate<E = Record<string, unknown>> = {
  $some?: FilterExpr<OwnOf<E>, NavOf<E>>
  $none?: FilterExpr<OwnOf<E>, NavOf<E>>
}

/**
 * A filter expression is either a comparison leaf or a logical branch.
 * `T` is the entity shape — provides type-safe field names and value types.
 * Defaults to `Record<string, unknown>` (untyped).
 * `Nav` is the entity's navigation props (`__navProps`): each nav key accepts a
 * {@link RelationPredicate} on its target. Defaults to `{}` (no typed nav keys).
 */
export type FilterExpr<T = Record<string, unknown>, Nav extends Record<string, unknown> = {}> =
  | ComparisonNode<T, Nav>
  | LogicalNode<T, Nav>

/**
 * Leaf node: one or more field comparisons.
 * When `T` is typed, only known keys are allowed.
 * When untyped (default), any string key is accepted.
 * Typed `Nav` keys accept a {@link RelationPredicate}; a wide `Nav`
 * (`Record<string, unknown>`) contributes nothing.
 */
export type ComparisonNode<T = Record<string, unknown>, Nav extends Record<string, unknown> = {}> = {
  [K in keyof T & string]?: T[K] | FieldOpsFor<T[K]>
} & (string extends keyof Nav
  ? {}
  : { [K in keyof Nav & string]?: RelationPredicate<NavTarget<NonNullable<Nav[K]>>> })

/**
 * Branch node: logical combination of child expressions.
 * The `never` members allow at most one logical key per object at the type
 * level (`{ $and, $or }` is rejected); comparison fields may still sit
 * alongside it (`{ id: 1, $or: [...] }`). At runtime every member of a node
 * is ANDed, so several logical keys in one object are accepted and combined.
 */
export type LogicalNode<T = Record<string, unknown>, Nav extends Record<string, unknown> = {}> =
  | { $and: FilterExpr<T, Nav>[]; $or?: never; $not?: never }
  | { $or: FilterExpr<T, Nav>[]; $and?: never; $not?: never }
  | { $not: FilterExpr<T, Nav>; $and?: never; $or?: never }

/**
 * Known aggregate function names. Consumers may support additional functions via the (string & {}) escape hatch.
 * `first` / `last` read a representative row of each group, ordered by the query's `$rowOrder`.
 * Runtime list: `AGGREGATE_FNS`; guard: `isAggregateFn`.
 */
export type AggregateFn = 'sum' | 'count' | 'countDistinct' | 'avg' | 'min' | 'max' | 'first' | 'last'

/** A single aggregate function call within $select. Generic params preserve literal types for result inference. */
export interface AggregateExpr<
  Fn extends string = AggregateFn | (string & {}),
  Field extends string = string,
  Alias extends string = string,
> {
  /**
   * Function name (sum, count, countDistinct, avg, min, max, first, last, or custom).
   * `countDistinct` counts the distinct non-null values of `$field`; its result is a number.
   */
  $fn: Fn
  /** Field to aggregate. '*' only for count(*). */
  $field: Field
  /** Alias for the result. Auto-generated by URL parser if omitted. */
  $as?: Alias
}

/**
 * Closed arithmetic over numbers: a number literal, a name, or an operator node.
 * Binary `+ - * /`, unary `-` (arity 1) and `coalesce` (two or more arguments).
 * Names are field paths in a row-level expression and `$select` aliases or
 * `$groupBy` fields in a group-level one. Text form: {@link parseArith} /
 * {@link formatArith}.
 */
export type ArithExpr<N extends string = string> =
  | number
  | N
  | { $op: '+' | '-' | '*' | '/'; $args: readonly [ArithExpr<N>, ArithExpr<N>] }
  | { $op: '-'; $args: readonly [ArithExpr<N>] }
  | { $op: 'coalesce'; $args: readonly [ArithExpr<N>, ArithExpr<N>, ...ArithExpr<N>[]] }

/**
 * Row-level expression aggregate: `sum` / `avg` / `min` / `max` over a per-row
 * arithmetic expression (`sum(price*qty):revenue`). `$as` is required.
 */
export interface AggregateOfExpr<
  Fn extends 'sum' | 'avg' | 'min' | 'max' = 'sum' | 'avg' | 'min' | 'max',
  N extends string = string,
  Alias extends string = string,
> {
  $fn: Fn
  /** Per-row expression over numeric fields. */
  $expr: ArithExpr<N>
  $as: Alias
}

/**
 * Group-level expression: arithmetic over the aliases of other numeric `$select`
 * entries or numeric `$groupBy` fields, evaluated after grouping
 * (`expr(est/open):avgEst`). `$as` is required.
 */
export interface SelectArithExpr<Alias extends string = string> {
  /** Never set: an entry with `$fn` is a row-level aggregate ({@link AggregateOfExpr}), typed on its own. */
  $fn?: never
  $expr: ArithExpr
  $as: Alias
}

/**
 * The numeric field names of `T` — the operands a per-row expression may read.
 * Falls back to `string` when `T` is untyped (`Record<string, unknown>`, `any`) or has no
 * numeric field, so an expression over an untyped table never collapses to `never`.
 */
export type NumericKeys<T> =
  string extends keyof T
    ? string
    : [NumericNames<T>] extends [never]
      ? string
      : NumericNames<T>
type NumericNames<T> = {
  [K in keyof T & string]-?: [NonNullable<T[K]>] extends [number] ? K : never
}[keyof T & string]

/** Calendar units a bucket truncates to. `'hour'` is the local wall-clock hour. */
export type BucketUnit = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year'

/** First day of a `week` bucket (ISO 8601 default: 'mon'). */
export type WeekStart = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

/**
 * `YYYY-MM-DD`: the local calendar date of the bucket's first day, the same
 * format for every unit but `'hour'`, whose label is the local date and
 * wall-clock hour `YYYY-MM-DDTHH:00`. Wall-clock in the bucket's zone (not an
 * instant). Zero-padded, so a plain string sort is chronological.
 */
export type CalendarBucketLabel = string

/**
 * A calendar bucket over an epoch-ms timestamp field: a derived grouping
 * dimension. Lives in an aggregate query's `$select` and is grouped by its
 * alias in `$groupBy`. Its value is a {@link CalendarBucketLabel}, or `null`
 * when the source is null/missing or outside the supported instant range.
 */
export interface BucketExpr<Field extends string = string, Alias extends string = string> {
  /** Calendar unit to truncate to. */
  $bucket: BucketUnit
  /** Source timestamp field (epoch milliseconds). */
  $field: Field
  /** IANA time zone name; default 'UTC'. */
  $tz?: string
  /** First day of the week. Only with `$bucket: 'week'`; default 'mon'. */
  $weekStart?: WeekStart
  /** Output alias; default `${unit}_${field}` (required when `$field` contains '.'). */
  $as?: Alias
}

/**
 * An aggregate allowed in a typed `AggregateControls.$select`: `count` over a measure or `'*'`,
 * `countDistinct` over a dimension or measure, the rest over a measure.
 */
export type AggregateSelectExpr<D extends string = string, M extends string = string> =
  | AggregateExpr<'count', M | '*'>
  | AggregateExpr<'countDistinct', D | M>
  | AggregateExpr<'sum' | 'avg' | 'min' | 'max', M>
  | AggregateExpr<'first' | 'last', D | M>
  | AggregateOfExpr<'sum' | 'avg' | 'min' | 'max', M>
  | SelectArithExpr

/**
 * A computed `$select` entry: a row-reducing aggregate, a per-row calendar bucket,
 * an aggregate over an arithmetic expression, or a group-level arithmetic expression.
 */
export type ComputedExpr = AggregateExpr | BucketExpr | AggregateOfExpr | SelectArithExpr

/**
 * Projection definition.
 * - Array form: inclusion list with optional computed columns.
 *   Plain strings select fields; AggregateExpr / BucketExpr objects define computed columns
 *   (buckets are valid only in aggregate queries).
 * - Object form: inclusion/exclusion map (0 or 1 per field). No computed columns in this form.
 */
export type SelectExpr<T = Record<string, unknown>> =
  | ((keyof T & string) | AggregateExpr | BucketExpr<keyof T & string> | AggregateOfExpr<'sum' | 'avg' | 'min' | 'max', NumericKeys<T>> | SelectArithExpr)[]
  | Partial<Record<keyof T & string, 0 | 1>>

/** Query controls (pagination, projection, sorting, grouping). Generic `T` constrains field names. */
export interface UniqueryControls<
  T = Record<string, unknown>,
  Nav extends Record<string, unknown> = Record<string, unknown>,
> {
  $sort?: Partial<Record<keyof T & string, 1 | -1>>
  $skip?: number
  $limit?: number
  $count?: boolean
  $select?: SelectExpr<T>
  /** Fields (or calendar-bucket aliases from `$select`) to group by for aggregate queries. */
  $groupBy?: ((keyof T & string) | (string & {}))[]
  /** Row order inside each group for `first()` / `last()` aggregates; same shape as `$sort`. */
  $rowOrder?: Partial<Record<keyof T & string, 1 | -1>>
  /** Post-aggregation filter. Operates on aggregate aliases and dimension fields. */
  $having?: FilterExpr
  /** Relations to populate alongside the query. */
  $with?: TypedWithRelation<Nav>[]
  /** Pass-through for unknown $-prefixed keywords. */
  [key: `$${string}`]: unknown
}

/**
 * Canonical query representation.
 * When `name` is present this is a nested relation (sub-query inside `$with`).
 * When absent it is the root query.
 */
export interface Uniquery<
  T = Record<string, unknown>,
  Nav extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Relation name. Present only for nested `$with` sub-queries. */
  name?: string
  /** Typed nav keys (`Nav`) accept relational predicates (`$some` / `$none`). */
  filter?: FilterExpr<T, Nav>
  controls?: UniqueryControls<T, Nav>
  /** Pre-computed insights. */
  insights?: UniqueryInsights
}

/** Unwrap array types (mutable or readonly) to get the element type for nav props. */
export type NavTarget<T> = T extends ReadonlyArray<infer U> ? U : T

/**
 * A typed $with relation entry.
 * When Nav is typed (from __navProps), name is constrained to known nav prop keys.
 * Each entry gets its own filter/controls typed to the target entity.
 * Falls back to untyped WithRelation when Nav has no known keys.
 */
export type TypedWithRelation<Nav extends Record<string, unknown>> =
  [keyof Nav & string] extends [never]
    ? WithRelation | string
    : {
        [K in keyof Nav & string]: {
          name: K
          filter?: FilterExpr<OwnOf<NavTarget<NonNullable<Nav[K]>>>, NavOf<NavTarget<NonNullable<Nav[K]>>>>
          controls?: UniqueryControls<
            OwnOf<NavTarget<Nav[K]>>,
            NavTarget<Nav[K]> extends { __navProps: infer N extends Record<string, unknown> } ? N : Record<string, unknown>
          >
          insights?: UniqueryInsights
        }
      }[keyof Nav & string] | (keyof Nav & string)

/** Untyped $with relation — used when Nav generic is not provided. */
export type WithRelation = {
  name: string
  filter?: FilterExpr
  controls?: UniqueryControls
  insights?: UniqueryInsights
}

/**
 * Insight operator includes comparison ops, control ops ($-prefixed),
 * and aggregate function names (bare, e.g. 'sum', 'avg').
 */
export type InsightOp = ComparisonOp | RelationOp | '$select' | '$order' | '$with' | '$groupBy' | '$having' | '$bucket' | AggregateFn | (string & {})

/** Map of field names to the set of operators used on that field. */
export type UniqueryInsights = Map<string, Set<InsightOp>>

/**
 * Aggregate query controls. Separate from UniqueryControls: $groupBy is required, $with is forbidden.
 *
 * `$groupBy` entries are dimension fields or calendar-bucket aliases declared in `$select`.
 * The constraint admits any string because TypeScript cannot relate a sibling `$as`
 * literal; use {@link ValidGroupBy} in a signature to restore the narrowing.
 */
export interface AggregateControls<
  T = Record<string, unknown>,
  D extends keyof T & string = keyof T & string,
  M extends keyof T & string = keyof T & string,
> {
  $groupBy: (D | (string & {}))[]
  $select?: (D | AggregateSelectExpr<D, M> | BucketExpr<D>)[]
  $having?: FilterExpr
  $sort?: Record<string, 1 | -1>
  /** Row order inside each group for `first()` / `last()`; required with them, rejected without. */
  $rowOrder?: Partial<Record<keyof T & string, 1 | -1>>
  $skip?: number
  $limit?: number
  $count?: boolean
  [key: `$${string}`]: unknown
}

/** Aggregate query — no name (can't nest), no Nav (no $with). */
export interface AggregateQuery<
  T = Record<string, unknown>,
  D extends keyof T & string = keyof T & string,
  M extends keyof T & string = keyof T & string,
> {
  filter?: FilterExpr<T>
  controls: AggregateControls<T, D, M>
  insights?: UniqueryInsights
}

/**
 * Resolve the output alias of a computed `$select` entry (type-level twin of `resolveAlias`).
 * Uses `$as` if provided, otherwise `{fn}_{field}` for aggregates and `{unit}_{field}` for
 * buckets, with `'*'` spelled `star` (`count(*)` → `count_star`).
 */
export type ResolveAlias<A> =
  A extends { $as: infer Alias extends string } ? Alias
  : A extends { $fn: infer Fn extends string; $field: infer F extends string } ? `${Fn}_${F extends '*' ? 'star' : F}`
  : A extends { $bucket: infer U extends string; $field: infer F extends string } ? `${U}_${F extends '*' ? 'star' : F}`
  : string

/** Aliases of the calendar buckets in a `$select` array type. */
type BucketAliasesOf<Select> = Select extends readonly unknown[]
  ? ResolveAlias<Extract<Select[number], BucketExpr>>
  : never

/**
 * Validation type for aggregate signatures: maps each `$groupBy` entry of `Q` that is
 * neither a dimension (`D`) nor the alias of a calendar bucket in `Q['controls']['$select']`
 * to `never`. Intersect it with the inferred query so a typo fails to compile:
 *
 * ```ts
 * aggregate<const Q extends AggregateQuery<T>>(q: Q & ValidGroupBy<T, Q>): ...
 * ```
 */
export type ValidGroupBy<T, Q, D extends string = keyof T & string> =
  Q extends { controls: { $groupBy: infer G extends readonly unknown[]; $select?: infer S } }
    ? {
        controls: {
          $groupBy: { [K in keyof G]: G[K] extends D | BucketAliasesOf<S> ? G[K] : never }
        }
      }
    : unknown

/**
 * The `number | null` members of the expression entries in a `$select` (row-level aggregates over an
 * expression, group-level expressions). `unknown` when there are none, so the intersection carries no
 * empty `{}` member and typed rows compare equal to the written-out row type.
 */
type ExprAliasMembers<Select extends readonly unknown[]> =
  [Extract<Select[number], { $expr: unknown }>] extends [never] ? unknown
  : { [E in Extract<Select[number], { $expr: unknown }> as ResolveAlias<E>]: number | null }

/**
 * Infer the result row type from an aggregate query's $select.
 * Dimension fields preserve their original type from T.
 * Aggregate expressions: min/max/first/last preserve original type, others → number.
 * Expression aggregates and group-level expressions: `number | null`.
 * Calendar buckets: {@link CalendarBucketLabel}, `| null` when the source is optional or nullable.
 */
export type AggregateResult<
  T,
  Select extends readonly (string | AggregateExpr | BucketExpr | AggregateOfExpr | SelectArithExpr)[],
> =
  { [K in Extract<Select[number], string> & keyof T]: T[K] }
  & { [A in Extract<Select[number], AggregateExpr> as ResolveAlias<A>]:
      A extends { $fn: 'min' | 'max' | 'first' | 'last'; $field: infer F extends keyof T & string } ? T[F] : number
    }
  & ExprAliasMembers<Select>
  & { [B in Extract<Select[number], BucketExpr> as ResolveAlias<B>]:
      B extends { $field: infer F extends keyof T & string }
        ? null extends T[F] ? CalendarBucketLabel | null
          : undefined extends T[F] ? CalendarBucketLabel | null
          : CalendarBucketLabel
        : CalendarBucketLabel | null
    }
