import { BUCKET_UNITS, WEEK_STARTS, checkTimeZone, type IsoWeekday } from './calendar'
import { arithNames, validateArith } from './arith'
import { filterShapeProblem, forEachFilterField, isPlainObject } from './walk'
import type {
  AggregateExpr,
  AggregateFn,
  AggregateOfExpr,
  ArithExpr,
  BucketExpr,
  BucketUnit,
  ComputedExpr,
  NullsPlacement,
  SelectArithExpr,
  WeekStart,
} from './types'

/** The known aggregate functions (`AggregateFn`), for allow-listing `$fn`. */
export const AGGREGATE_FNS: readonly AggregateFn[] = [
  'sum',
  'count',
  'countDistinct',
  'avg',
  'min',
  'max',
  'first',
  'last',
]
/** The aggregate functions that read a representative row and so need `$rowOrder`. */
export const ROW_ORDER_FNS: readonly AggregateFn[] = ['first', 'last']
const isRowOrderFn = (fn: unknown) => (ROW_ORDER_FNS as readonly unknown[]).includes(fn)
/** The values of a `$nulls` entry. */
export const NULLS_PLACEMENTS: readonly NullsPlacement[] = ['first', 'last']
/** Whether `value` is a `$nulls` placement (`'first'` or `'last'`). */
export const isNullsPlacement = (value: unknown): value is NullsPlacement =>
  value === 'first' || value === 'last'
/** The aggregate functions that accept an arithmetic `$expr` instead of a `$field`. */
export const EXPR_AGGREGATE_FNS: readonly AggregateOfExpr['$fn'][] = ['sum', 'avg', 'min', 'max']
const isExprAggregateFn = (fn: unknown): fn is AggregateOfExpr['$fn'] =>
  (EXPR_AGGREGATE_FNS as readonly unknown[]).includes(fn)
/** The known aggregate functions that accept `'*'` as their `$field`. */
export const STAR_AGGREGATE_FNS: readonly AggregateFn[] = ['count']

/** True when `name` is one of the known {@link AGGREGATE_FNS}. */
export function isAggregateFn(name: unknown): name is AggregateFn {
  return (AGGREGATE_FNS as readonly unknown[]).includes(name)
}

/**
 * True for an aggregate `$select` entry: a `$fn` string and a `$field` string or list of
 * strings (`countDistinct` over several fields), no `$bucket`. Shape only: which functions
 * take a list, and that it is non-empty, is {@link validateAggregateExpr}'s.
 */
export function isAggregateExpr(v: unknown): v is AggregateExpr {
  if (typeof v !== 'object' || v === null || typeof (v as AggregateExpr).$fn !== 'string' || '$bucket' in v) {
    return false
  }
  const field: unknown = (v as AggregateExpr).$field
  return typeof field === 'string' || (Array.isArray(field) && field.every((f) => typeof f === 'string'))
}

/** True for an expression aggregate `$select` entry: `$fn` string and `$expr`, no `$field` / `$bucket`. */
export function isAggregateOfExpr(v: unknown): v is AggregateOfExpr {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as AggregateOfExpr).$fn === 'string' &&
    '$expr' in v &&
    !('$field' in v) &&
    !('$bucket' in v)
  )
}

/** True for a group-level expression `$select` entry: `$expr`, no `$fn` / `$field` / `$bucket`. */
export function isSelectArithExpr(v: unknown): v is SelectArithExpr {
  return (
    typeof v === 'object' &&
    v !== null &&
    '$expr' in v &&
    !('$fn' in v) &&
    !('$field' in v) &&
    !('$bucket' in v)
  )
}

/** True for a calendar-bucket `$select` entry: `$bucket` and `$field` strings, no `$fn`. */
export function isBucketExpr(v: unknown): v is BucketExpr {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as BucketExpr).$bucket === 'string' &&
    typeof (v as BucketExpr).$field === 'string' &&
    !('$fn' in v)
  )
}

/**
 * Output alias of a computed `$select` entry: `$as`, else `{fn}_{field}` for an
 * aggregate or `{unit}_{field}` for a bucket, with `'*'` spelled `star`
 * (`count(*)` → `count_star`) and a field list joined with `_`
 * (`countDistinct(a,b)` → `countDistinct_a_b`). Runtime twin of the `ResolveAlias` type.
 */
export function resolveAlias(expr: ComputedExpr): string {
  if (expr.$as) return expr.$as
  if (!('$field' in expr)) return ''
  const head = isBucketExpr(expr) ? expr.$bucket : (expr as AggregateExpr).$fn
  const field = expr.$field
  return `${head}_${typeof field === 'string' ? (field === '*' ? 'star' : field) : field.join('_')}`
}

/** @internal Any computed `$select` entry: a bucket, an aggregate, or an expression. */
export function isComputedExpr(v: unknown): v is ComputedExpr {
  return isBucketExpr(v) || isAggregateExpr(v) || isAggregateOfExpr(v) || isSelectArithExpr(v)
}

/** @internal An aggregate's `$field` (or the source of an alias) as a list: a `countDistinct` may read several fields. */
export function aggregateFields(field: string | readonly string[]): readonly string[] {
  return typeof field === 'string' ? [field] : field
}

/**
 * @internal Computed-column alias → source field (or field list, for `countDistinct`
 * over several fields) for the computed entries of an array `$select` accepted by
 * `accept` (default: every computed kind). An expression entry has no single source
 * field and is left out (its alias is its own `$as`). Later entries win on a repeated
 * alias. Empty for a non-array `$select`.
 */
export function computedAliases(
  select: unknown,
  accept: (entry: unknown) => entry is ComputedExpr = isComputedExpr,
): Map<string, string | readonly string[]> {
  const out = new Map<string, string | readonly string[]>()
  if (Array.isArray(select)) {
    for (const entry of select) {
      if (accept(entry) && '$field' in entry) out.set(resolveAlias(entry), entry.$field)
    }
  }
  return out
}

/**
 * Map each `$groupBy` entry to the source field it groups on: a calendar-bucket
 * alias (from `$select`) becomes the bucket's `$field`; other entries are kept.
 * Non-string entries are skipped; duplicates are removed (first occurrence wins).
 * Use it to check `$groupBy` against a field whitelist.
 */
export function groupByFields(controls: { $select?: unknown; $groupBy?: unknown } | undefined): string[] {
  const { $select, $groupBy } = controls ?? {}
  if (!Array.isArray($groupBy)) return []
  // Buckets only: an aggregate alias is not a grouping key, so a `$groupBy` entry naming one stays as is.
  const bucketField = computedAliases($select, isBucketExpr)
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of $groupBy) {
    if (typeof entry !== 'string') continue
    const field = (bucketField.get(entry) as string | undefined) ?? entry
    if (!seen.has(field)) {
      seen.add(field)
      out.push(field)
    }
  }
  return out
}

/** Machine-readable reasons of the two-level aggregate rules (see {@link resolveNested}). */
export type NestedIssueCode =
  /** A `$from` inside `$from`: depth is fixed at two. */
  | 'AGG_NESTED_DEPTH'
  /** `$from` is not an object, or a control that is not valid at its level. */
  | 'AGG_NESTED_CONTROL'
  /** The inner level has no (or an empty) `$groupBy`. */
  | 'AGG_NESTED_UNGROUPED'
  /** Two inner columns share a name (`$groupBy` keys and computed aliases). */
  | 'AGG_NESTED_DUPLICATE_COLUMN'
  /** The outer level reads a name that is not an inner column, or `$having` / `$sort` a name that is not an outer column. */
  | 'AGG_NESTED_UNKNOWN_COLUMN'
  /** `sum` / `avg` / arithmetic / a bucket at the outer level over an inner column known not to hold numbers. */
  | 'AGG_NESTED_NOT_NUMERIC'

/** Machine-readable reasons of the one-level `$select` rules (see {@link resolveBuckets}). */
export type AggregateIssueCode =
  /**
   * A computed `$select` alias repeats another column name of the result (another alias, a plain
   * `$select` field, a `$groupBy` key), or a bucket or expression alias names an `isField` field.
   */
  'AGG_ALIAS_COLLISION'

/** One validation failure: the control it concerns and a user-facing message. */
export interface QueryIssue {
  path: string
  message: string
  /** Machine-readable reason, on the issues that have one ({@link AggregateIssueCode}, {@link NestedIssueCode}). */
  code?: AggregateIssueCode | NestedIssueCode
}

/** A validated, normalized calendar bucket. */
export interface ResolvedBucket {
  /** Output alias (`$as` or the default `${unit}_${field}`). */
  alias: string
  /** Source field path, as given. */
  field: string
  unit: BucketUnit
  /** Canonical IANA zone name (default 'UTC'). */
  tz: string
  /** Week start (default 'mon'; always 'mon' for non-week units). */
  weekStart: WeekStart
  /** ISO weekday of `weekStart` (1 = Mon … 7 = Sun). */
  weekStartIso: IsoWeekday
}

type BucketExprCheck = { ok: true; bucket: ResolvedBucket } | { ok: false; message: string }

/** Result of {@link validateAggregateExpr}. */
export type AggregateExprCheck = { ok: true } | { ok: false; message: string }

/** Options of {@link validateAggregateExpr}. */
export interface ValidateAggregateOptions {
  /** Allowed `$fn` names. Default: any name (custom functions pass). */
  fns?: readonly string[]
}

/** One validated arithmetic `$select` entry (row-level aggregate or group-level expression). */
export interface ResolvedSelectExpr {
  /** Output alias (`$as`). */
  alias: string
  /** The expression, as given. */
  expr: ArithExpr
  /** Distinct names the expression references (fields for a row-level entry, aliases / `$groupBy` fields for a group-level one). */
  names: string[]
  /** `'row'`: `$fn(<expr>)` over each row; `'group'`: arithmetic over the group's aliases. */
  level: 'row' | 'group'
  /** The aggregate of a row-level entry; absent for a group-level one. */
  fn?: AggregateOfExpr['$fn']
}

/** One `$rowOrder` key. */
export interface ResolvedRowOrderKey {
  field: string
  desc: boolean
  /** NULL placement from `$nulls`; absent when the query names none for this key. */
  nulls?: NullsPlacement
}

/** Result of {@link resolveBuckets}. */
export type BucketResolution =
  | {
      ok: true
      buckets: ResolvedBucket[]
      /** Arithmetic entries: row-level first (select order), then group-level in dependency order. */
      exprs: ResolvedSelectExpr[]
      /** `$rowOrder` keys, when the query uses `first()` / `last()`. */
      rowOrder?: ResolvedRowOrderKey[]
    }
  | { ok: false; issues: QueryIssue[] }

/** Prefix of the engine's internal column / alias names (derived tables, result envelopes). */
export const RESERVED_ALIAS_PREFIX = '__as_'
const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** `a, b or c` */
const orList = (items: readonly string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
const UNIT_LIST = orList(BUCKET_UNITS)
const WEEK_START_LIST = orList(WEEK_STARTS)

/**
 * Validate and normalize one `BucketExpr` — the rules knowable without a table
 * schema: unit, time zone (canonicalized via `checkTimeZone`), week start,
 * alias shape (`^[A-Za-z_][A-Za-z0-9_]*$`, no dots) and the explicit-`$as` rule
 * for a dotted source.
 */
function validateBucketExpr(expr: BucketExpr): BucketExprCheck {
  const unit = expr.$bucket
  if (!BUCKET_UNITS.includes(unit)) {
    return { ok: false, message: `Unknown bucket unit "${String(unit)}" — use ${UNIT_LIST}` }
  }
  if (typeof expr.$field !== 'string' || expr.$field === '') {
    return { ok: false, message: 'Bucket needs a $field' }
  }
  let tz = 'UTC'
  if (expr.$tz !== undefined) {
    const res = checkTimeZone(expr.$tz)
    if (!res.ok) return res
    tz = res.tz
  }
  let weekStart: WeekStart = 'mon'
  if (expr.$weekStart !== undefined) {
    if (!WEEK_STARTS.includes(expr.$weekStart)) {
      return { ok: false, message: `Unknown week start "${String(expr.$weekStart)}" — use ${WEEK_START_LIST}` }
    }
    if (unit !== 'week') {
      return { ok: false, message: `$weekStart is only valid with unit "week", not "${unit}"` }
    }
    weekStart = expr.$weekStart
  }
  // `$as: ''` is rejected, not defaulted (resolveAlias would default it).
  const alias: unknown = expr.$as === undefined ? resolveAlias(expr) : expr.$as
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) {
    // A default alias is unusable for a dotted (`stats.firstSeenAt`) or other non-identifier field.
    const message =
      expr.$as === undefined
        ? `Bucket over "${expr.$field}" needs an explicit $as`
        : `Invalid alias "${String(alias)}" — use letters, digits and underscores, not starting with a digit`
    return { ok: false, message }
  }
  const weekStartIso = (WEEK_STARTS.indexOf(weekStart) + 1) as IsoWeekday
  return { ok: true, bucket: { alias, field: expr.$field, unit, tz, weekStart, weekStartIso } }
}

/**
 * Validate one `AggregateExpr` — the rules knowable without a table schema:
 * `$fn` is in `fns` (only when given), `'*'` is used only by a known
 * function that accepts it ({@link STAR_AGGREGATE_FNS}), a field list only by
 * `countDistinct` (non-empty, distinct field names, no `'*'`), and a `$where`
 * is a filter object on an entry with an explicit `$as`. A custom function's
 * `$field` is the consumer's concern.
 */
export function validateAggregateExpr(
  expr: AggregateExpr,
  opts: ValidateAggregateOptions = {},
): AggregateExprCheck {
  const fn = expr.$fn
  if (opts.fns && !opts.fns.includes(fn)) {
    return { ok: false, message: `Unknown aggregate function "${fn}" — use ${orList(opts.fns)}` }
  }
  const field: unknown = expr.$field
  if (Array.isArray(field)) {
    const message = fieldListProblem(fn, field)
    if (message) return { ok: false, message }
  } else if (field === '*' && isAggregateFn(fn) && !STAR_AGGREGATE_FNS.includes(fn)) {
    const message = `Aggregate "${fn}" needs a field — only ${orList(STAR_AGGREGATE_FNS)} accepts *`
    return { ok: false, message }
  }
  const message = whereProblem(expr)
  return message ? { ok: false, message } : { ok: true }
}

/** The problem with a `$field` list, if any: `countDistinct` only, non-empty, distinct field names. */
function fieldListProblem(fn: string, fields: readonly unknown[]): string | undefined {
  if (fn !== 'countDistinct') return `Aggregate "${fn}" takes one field — only countDistinct takes a list of fields`
  if (fields.length === 0) return 'countDistinct needs at least one field'
  const seen = new Set<string>()
  for (const f of fields) {
    if (typeof f !== 'string' || f === '' || f === '*') {
      return `countDistinct field list entries must be field names, not ${JSON.stringify(f)}`
    }
    if (seen.has(f)) return `countDistinct lists "${f}" twice`
    seen.add(f)
  }
  return undefined
}

/** The problem with an entry's `$where`, if any: a filter object, and the entry names its `$as`. */
function whereProblem(entry: { $where?: unknown; $as?: unknown }): string | undefined {
  if (entry.$where === undefined) return undefined
  const shape = whereShapeProblem(entry.$where)
  if (shape) return shape
  if (typeof entry.$as !== 'string' || entry.$as === '') {
    return 'A conditional aggregate ($where) needs an explicit $as'
  }
  return undefined
}

/** The structural problem of a `$where` value, if any: a well-formed filter object. */
function whereShapeProblem(where: unknown): string | undefined {
  if (!isPlainObject(where)) return '$where must be a filter object'
  const shape = filterShapeProblem(where)
  return shape && `Malformed $where: ${shape}`
}

/** Options of {@link resolveBuckets}. */
export interface ResolveBucketsOptions {
  /** Whether the query is an aggregate query. Default: `$groupBy` is non-empty. */
  aggregate?: boolean
  /**
   * Whether `name` is a field of the queried table — a bucket or expression alias must
   * not shadow one. Checked in addition to the plain fields listed in `$select` (the
   * default). Aliases of aggregates over one field are not checked against it: they only
   * must not equal a selected field, a `$groupBy` key or another alias.
   */
  isField?: (name: string) => boolean
  /** Allowed aggregate `$fn` names, checked by {@link validateAggregateExpr}. Default: any name. */
  fns?: readonly string[]
}

/**
 * Validate the computed `$select` entries of a query's controls and return the
 * calendar buckets and arithmetic entries normalized:
 *
 * - each `$select` array entry is a string, an `AggregateExpr`, a `BucketExpr`,
 *   an `AggregateOfExpr` (`sum`/`avg`/`min`/`max` over a per-row `$expr`) or a
 *   `SelectArithExpr` (group-level `$expr`);
 * - each aggregate passes {@link validateAggregateExpr} (with `fns`, when given);
 * - each bucket has a known unit, a valid time zone (canonicalized, see
 *   `checkTimeZone`), a week start only with unit `'week'`, and an identifier
 *   alias (`^[A-Za-z_][A-Za-z0-9_]*$`; a dotted `$field` needs an explicit `$as`);
 * - each expression passes {@link validateArith} and has an identifier `$as`;
 *   a group-level expression references only aliases of other numeric entries
 *   (aggregates, `first`/`last`, expressions) or plain `$groupBy` fields, with
 *   no cycle; a bucket alias is a text label and cannot be an operand;
 * - buckets, expressions and `first`/`last` appear only in aggregate mode
 *   (`aggregate` when given, else a non-empty `$groupBy`);
 * - `first`/`last` need a non-empty `$rowOrder` (`1 | -1` values), and `$rowOrder`
 *   is rejected without them; the `$nulls` entry of a `$rowOrder` key is `'first'` / `'last'`;
 * - each bucket alias is listed in `$groupBy`;
 * - every computed alias names one column of the result: it is unique among
 *   `$select` aliases (default ones included), is not a plain `$select` field, and
 *   no `$groupBy` entry is an aggregate or expression alias; a bucket or expression
 *   alias is not a field name either (`isField`; pass the table's field set to
 *   check this fully here). These issues carry the code `AGG_ALIAS_COLLISION`
 *   ({@link AggregateIssueCode});
 * - `$groupBy` entries are strings.
 *
 * Schema-dependent rules (numeric operand types, timestamp-typed bucket source,
 * encryption, dimensions) are the caller's. Issues carry `path` `'$select'`,
 * `'$groupBy'`, `'$rowOrder'` or `'$nulls'`.
 */
export function resolveBuckets(
  controls: { $select?: unknown; $groupBy?: unknown; $rowOrder?: unknown; $nulls?: unknown } | undefined,
  opts: ResolveBucketsOptions = {},
): BucketResolution {
  return resolveComputed(controls, opts, true)
}

/**
 * {@link resolveBuckets}; `dupes: false` leaves duplicate computed aliases unreported, for a
 * caller that reports duplicate columns itself ({@link resolveNested}).
 */
function resolveComputed(
  controls: { $select?: unknown; $groupBy?: unknown; $rowOrder?: unknown; $nulls?: unknown } | undefined,
  opts: ResolveBucketsOptions,
  dupes: boolean,
): BucketResolution {
  const issues: QueryIssue[] = []
  const buckets: ResolvedBucket[] = []
  let exprs: ResolvedSelectExpr[] = []
  const { $select: select, $groupBy: rawGroupBy, $rowOrder: rawRowOrder, $nulls: rawNulls } = controls ?? {}
  const groupBy = Array.isArray(rawGroupBy) ? rawGroupBy : []
  const aggregateMode = opts.aggregate ?? groupBy.length > 0
  let sawRowFn = false

  if (Array.isArray(select)) {
    const fields = new Set<string>()
    // Every alias of a computed entry (valid or not), with its count: a column alias must be unique among all of them.
    const aliasCount = new Map<string, number>()
    const bucketAliases = new Set<string>()
    const numericAliases = new Set<string>()
    const exprAliases = new Set<string>()
    const rowExprs: ResolvedSelectExpr[] = []
    const groupExprs: { alias: string; expr: ArithExpr }[] = []
    // Every valid computed column by alias: whether a table field (`isField`) may not share it — an
    // aggregate over one field may name a field the result does not hold.
    const columns = new Map<string, boolean>()
    const addColumn = (alias: string, shadows: boolean) => columns.set(alias, shadows || columns.get(alias) === true)
    // Aliases of `countDistinct` over a field list: `countDistinct_a_b` can meet a single field's default.
    const listAliases = new Set<string>()
    // Aliases some entry gets by default (no `$as`).
    const defaultAliases = new Set<string>()
    let sawBucket = false
    let sawExpr = false
    for (let i = 0; i < select.length; i++) {
      const entry: unknown = select[i]
      if (typeof entry === 'string') {
        fields.add(entry)
        continue
      }
      if (typeof entry === 'object' && entry !== null && '$field' in entry && '$expr' in entry) {
        issues.push({
          path: '$select',
          message: `$select entry at index ${i} has both $field and $expr — use one`,
        })
        continue
      }
      if (!isComputedExpr(entry)) {
        issues.push({ path: '$select', message: `Unsupported $select entry at index ${i}` })
        continue
      }
      const entryAlias = resolveAlias(entry)
      if (typeof entryAlias === 'string' && entryAlias.startsWith(RESERVED_ALIAS_PREFIX)) {
        issues.push({
          path: '$select',
          message: `Alias "${entryAlias}" is reserved — aliases must not start with "${RESERVED_ALIAS_PREFIX}"`,
        })
        continue
      }
      aliasCount.set(entryAlias, (aliasCount.get(entryAlias) ?? 0) + 1)
      if (!(entry as { $as?: unknown }).$as) defaultAliases.add(entryAlias)
      if ((isBucketExpr(entry) || isSelectArithExpr(entry)) && (entry as { $where?: unknown }).$where !== undefined) {
        const what = isBucketExpr(entry) ? 'a calendar bucket' : `the group-level expression "${String(entry.$as)}"`
        issues.push({ path: '$select', message: `$where applies to aggregates only, not to ${what}` })
      }
      if (isBucketExpr(entry)) {
        sawBucket = true
        const res = validateBucketExpr(entry)
        if (res.ok) {
          buckets.push(res.bucket)
          bucketAliases.add(res.bucket.alias)
          addColumn(res.bucket.alias, true)
        } else issues.push({ path: '$select', message: res.message })
      } else if (isAggregateExpr(entry)) {
        if (isRowOrderFn(entry.$fn)) sawRowFn = true
        const res = validateAggregateExpr(entry, { fns: opts.fns })
        if (!res.ok) issues.push({ path: '$select', message: res.message })
        else {
          const list = Array.isArray(entry.$field)
          if (list) listAliases.add(entryAlias)
          addColumn(entryAlias, list)
        }
        numericAliases.add(entryAlias)
      } else {
        // An expression: `$fn(<expr>)` over each row, or a group-level `$expr`.
        sawExpr = true
        const alias = checkExprAlias(entry.$as, issues)
        const rowFn = '$fn' in entry ? entry.$fn : undefined
        const fnOk = rowFn === undefined || isExprAggregateFn(rowFn)
        if (!fnOk) {
          issues.push({
            path: '$select',
            message: `Aggregate "${rowFn}" takes a field, not an expression — use ${orList(EXPR_AGGREGATE_FNS)}`,
          })
        }
        const problems = validateArith(entry.$expr)
        issues.push(...problems)
        // `$as` is required on every expression already; only the `$where` shape is left to check.
        const where = (entry as { $where?: unknown }).$where
        const whereMessage = rowFn === undefined || where === undefined ? undefined : whereShapeProblem(where)
        if (whereMessage) issues.push({ path: '$select', message: whereMessage })
        if (alias !== undefined) {
          numericAliases.add(alias)
          exprAliases.add(alias)
          addColumn(alias, true)
          if (!problems.length && fnOk) {
            if (rowFn !== undefined && isExprAggregateFn(rowFn)) {
              rowExprs.push({ alias, expr: entry.$expr, names: arithNames(entry.$expr), level: 'row', fn: rowFn })
            } else groupExprs.push({ alias, expr: entry.$expr })
          }
        }
      }
    }

    if (sawBucket && !aggregateMode) {
      issues.push({ path: '$select', message: 'Calendar buckets are only valid in grouped queries' })
    }
    if ((sawExpr || sawRowFn) && !aggregateMode) {
      issues.push({ path: '$select', message: 'Expressions and first()/last() are only valid in grouped queries' })
    }
    const isField = opts.isField ?? ((name: string) => fields.has(name))
    // One value per name in the result row: a computed alias may not shadow a field, nor (with `dupes`)
    // be a selected field, an aggregate's `$groupBy` key or repeated. Reported once per alias.
    for (const [alias, shadows] of columns) {
      let path = '$select'
      let message: string
      if ((shadows && isField(alias)) || (dupes && fields.has(alias))) message = `Alias "${alias}" collides with field "${alias}"`
      else if (!dupes) continue
      else if (groupBy.includes(alias) && !bucketAliases.has(alias) && !exprAliases.has(alias)) {
        // a bucket alias in `$groupBy` is the bucket; an expression alias there is reported by resolveSelectExprs
        path = '$groupBy'
        message = `Cannot group by an aggregate alias "${alias}" — a $groupBy key and a $select alias need their own names`
      } else if ((aliasCount.get(alias) ?? 0) > 1) {
        const hint = listAliases.has(alias)
          ? ' — name the countDistinct over several fields with $as'
          : defaultAliases.has(alias) ? ' — name one with $as' : ''
        message = `Duplicate alias "${alias}"${hint}`
      } else continue
      issues.push({ path, message, code: 'AGG_ALIAS_COLLISION' })
    }
    for (const b of buckets) {
      if (aggregateMode && !groupBy.includes(b.alias)) {
        issues.push({ path: '$select', message: `Bucket "${b.alias}" in $select must also appear in $groupBy` })
      }
    }

    exprs = resolveSelectExprs({ rowExprs, groupExprs, exprAliases, numericAliases, bucketAliases, groupBy }, issues)
  }

  for (let i = 0; i < groupBy.length; i++) {
    if (typeof groupBy[i] !== 'string') {
      issues.push({ path: '$groupBy', message: `Unsupported $groupBy entry at index ${i} — expected a field name or bucket alias` })
    }
  }

  const rowOrder = checkRowOrder(rawRowOrder, rawNulls, sawRowFn, issues)

  if (issues.length) return { ok: false, issues }
  return rowOrder ? { ok: true, buckets, exprs, rowOrder } : { ok: true, buckets, exprs }
}

/** What {@link resolveSelectExprs} needs from the `$select` scan. */
interface SelectExprContext {
  /** Row-level entries that passed their own checks, in select order. */
  rowExprs: ResolvedSelectExpr[]
  /** Group-level entries that passed their own checks, in select order. */
  groupExprs: { alias: string; expr: ArithExpr }[]
  /** Every usable expression alias (row-level and group-level). */
  exprAliases: ReadonlySet<string>
  /** Aliases of numeric entries (aggregates and expressions): valid operands. */
  numericAliases: ReadonlySet<string>
  bucketAliases: ReadonlySet<string>
  groupBy: readonly unknown[]
}

/**
 * Expression rules that need the whole `$select`: operand
 * resolution and dependency order of group-level entries (cycle check), and
 * "no `$groupBy` on an expression". Returns row-level entries first, then
 * group-level in dependency order.
 */
function resolveSelectExprs(ctx: SelectExprContext, issues: QueryIssue[]): ResolvedSelectExpr[] {
  const { rowExprs, groupExprs, exprAliases, numericAliases, bucketAliases, groupBy } = ctx
  if (!exprAliases.size) return []

  // Group-level expressions: operands, then dependency order (cycle check).
  let ordered: ResolvedSelectExpr[] = []
  if (groupExprs.length) {
    const plainGroupBy = new Set(
      groupBy.filter(
        (g): g is string => typeof g === 'string' && !bucketAliases.has(g) && !numericAliases.has(g),
      ),
    )
    const deps = new Map<string, string[]>()
    const resolved: ResolvedSelectExpr[] = []
    for (const { alias, expr } of groupExprs) {
      const names = arithNames(expr)
      const edges: string[] = []
      for (const name of names) {
        if (numericAliases.has(name)) edges.push(name)
        else if (bucketAliases.has(name)) {
          issues.push({ path: '$select', message: `Bucket "${name}" is a text label and cannot be used in arithmetic` })
        } else if (!plainGroupBy.has(name)) {
          issues.push({
            path: '$select',
            message: `Expression "${alias}" references "${name}" — name an aggregate alias or a $groupBy field`,
          })
        }
      }
      deps.set(alias, edges)
      resolved.push({ alias, expr, names, level: 'group' })
    }
    ordered = orderGroupExprs(resolved, deps, issues)
  }

  for (const g of groupBy) {
    if (typeof g === 'string' && exprAliases.has(g)) {
      issues.push({ path: '$groupBy', message: `Cannot group by a computed expression "${g}"`, code: 'AGG_ALIAS_COLLISION' })
    }
  }
  return [...rowExprs, ...ordered]
}

/** Alias shape rule shared by both expression kinds; returns the alias when usable. */
function checkExprAlias(alias: unknown, issues: QueryIssue[]): string | undefined {
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) {
    const message =
      alias === undefined
        ? 'An expression needs an explicit $as'
        : `Invalid alias "${String(alias)}" — use letters, digits and underscores, not starting with a digit`
    issues.push({ path: '$select', message })
    return undefined
  }
  return alias
}

/**
 * The deepest chain of group-level expressions that reference each other. Past
 * it the query expands to more nodes than any consumer evaluates (the db caps
 * a whole query at 1024), so it is refused here — before any walk can grow
 * with an unbounded chain.
 */
export const MAX_EXPR_CHAIN = 1024

/**
 * Group-level entries in dependency order; reports a cycle and an over-deep
 * chain. Iterative (an explicit stack): a chain of any length cannot overflow
 * the call stack.
 */
function orderGroupExprs(
  groupLevel: ResolvedSelectExpr[],
  deps: Map<string, string[]>,
  issues: QueryIssue[],
): ResolvedSelectExpr[] {
  const out: ResolvedSelectExpr[] = []
  const byAlias = new Map(groupLevel.map((e) => [e.alias, e]))
  const state = new Map<string, 1 | 2>() // 1 = visiting, 2 = done
  let cycleReported = false
  let depthReported = false
  for (const root of byAlias.keys()) {
    if (state.has(root)) continue
    // `path` is the chain being visited; `next[i]` the next dependency of `path[i]` to look at
    const path: string[] = [root]
    const next: number[] = [0]
    state.set(root, 1)
    while (path.length > 0) {
      const top = path.length - 1
      const alias = path[top]!
      const edges = deps.get(alias) ?? []
      if (next[top]! >= edges.length) {
        state.set(alias, 2)
        out.push(byAlias.get(alias)!)
        path.pop()
        next.pop()
        continue
      }
      const dep = edges[next[top]!++]!
      if (!byAlias.has(dep)) continue
      const seen = state.get(dep)
      if (seen === 2) continue
      if (seen === 1) {
        if (!cycleReported) {
          cycleReported = true
          const loop = [...path.slice(path.indexOf(dep)), dep]
          issues.push({ path: '$select', message: `Expression cycle: ${loop.join(' → ')}` })
        }
        continue
      }
      if (path.length >= MAX_EXPR_CHAIN) {
        // refuse the chain: mark the rest of it done without walking deeper
        if (!depthReported) {
          depthReported = true
          issues.push({
            path: '$select',
            message: `Expression chain is too deep (more than ${MAX_EXPR_CHAIN} expressions refer to each other)`,
          })
        }
        continue
      }
      state.set(dep, 1)
      path.push(dep)
      next.push(0)
    }
  }
  return out
}

/**
 * Validate `$rowOrder` and the `$nulls` entries of its keys; returns its keys when
 * `first()` / `last()` are used. `$nulls` keys outside `$rowOrder` are not checked here.
 */
function checkRowOrder(
  raw: unknown,
  rawNulls: unknown,
  usesRowFn: boolean,
  issues: QueryIssue[],
): ResolvedRowOrderKey[] | undefined {
  if (raw === undefined) {
    if (usesRowFn) {
      issues.push({ path: '$rowOrder', message: '$rowOrder is required when first() or last() is used' })
    }
    return undefined
  }
  if (!usesRowFn) {
    issues.push({ path: '$rowOrder', message: '$rowOrder orders rows for first()/last() only' })
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length === 0) {
    issues.push({ path: '$rowOrder', message: '$rowOrder must be a non-empty object of field → 1 | -1' })
    return undefined
  }
  let nulls: Record<string, unknown> | undefined
  if (rawNulls !== undefined) {
    if (typeof rawNulls === 'object' && rawNulls !== null && !Array.isArray(rawNulls)) {
      nulls = rawNulls as Record<string, unknown>
    } else {
      issues.push({ path: '$nulls', message: "$nulls must be an object of field → 'first' | 'last'" })
    }
  }
  const keys: ResolvedRowOrderKey[] = []
  for (const [field, dir] of Object.entries(raw)) {
    if (dir !== 1 && dir !== -1) {
      issues.push({ path: '$rowOrder', message: `$rowOrder "${field}" must be 1 or -1` })
      continue
    }
    const key: ResolvedRowOrderKey = { field, desc: dir === -1 }
    const placement = nulls && Object.hasOwn(nulls, field) ? nulls[field] : undefined
    if (isNullsPlacement(placement)) key.nulls = placement
    else if (placement !== undefined) {
      issues.push({ path: '$nulls', message: `$nulls "${field}" must be 'first' or 'last'` })
    }
    keys.push(key)
  }
  return keys
}

// ── Two-level aggregates (`controls.$from`) ─────────────────────────────────

/** The controls allowed inside `$from`, the inner level of a two-level aggregate. */
export const NESTED_STAGE_CONTROLS: readonly string[] = ['$groupBy', '$select', '$having', '$rowOrder', '$nulls']

/** One column of the inner level: what the outer level of a two-level aggregate reads. */
export interface InnerColumn {
  name: string
  /**
   * `'key'`: a plain `$groupBy` field (its name is the field path); `'bucket'`: a calendar
   * bucket label; `'aggregate'`: an aggregate; `'expr'`: an arithmetic entry.
   */
  kind: 'key' | 'bucket' | 'aggregate' | 'expr'
  /**
   * `true` when the column holds numbers, `false` when it does not (a bucket label),
   * absent when that depends on the schema and no `isNumericField` was given.
   */
  numeric?: boolean
}

/** Options of {@link resolveNested}. */
export interface ResolveNestedOptions {
  /** Whether `name` is a field of the queried table — {@link ResolveBucketsOptions.isField} for the inner level. */
  isField?: (name: string) => boolean
  /** Allowed aggregate `$fn` names at both levels. Default: any name. */
  fns?: readonly string[]
  /**
   * Whether a table field holds numbers. With it, inner `$groupBy` keys and inner
   * `min` / `max` / `first` / `last` columns get a known {@link InnerColumn.numeric}, so the
   * outer `sum` / `avg` / arithmetic checks cover them too. It must return `undefined` for a
   * field the request may not see (the answer shows in the issues), and the inner level's
   * capability gate must run before {@link resolveNested}.
   */
  isNumericField?: (field: string) => boolean | undefined
}

/** The normalized computed `$select` entries of one level (a successful {@link BucketResolution}). */
export type ResolvedLevel = Omit<Extract<BucketResolution, { ok: true }>, 'ok'>

/** The controls {@link resolveNested} reads (a `NestedAggregateControls`, or parsed URL controls). */
export interface NestedControlsInput {
  $from?: unknown
  $select?: unknown
  $groupBy?: unknown
  $having?: unknown
  $sort?: unknown
  $rowOrder?: unknown
  $nulls?: unknown
  $with?: unknown
}

/** Result of {@link resolveNested}. */
export type NestedResolution =
  | {
      ok: true
      /** The inner columns: plain `$groupBy` keys, then the computed `$select` entries of `$from`, in order. */
      columns: InnerColumn[]
      /** The inner level (`$from`), resolved as {@link resolveBuckets} resolves a grouped query. */
      inner: ResolvedLevel
      /** The outer level, resolved against the inner columns. */
      outer: ResolvedLevel
    }
  | { ok: false; issues: QueryIssue[] }

const NUMERIC_AGGREGATES: readonly unknown[] = ['count', 'countDistinct', 'sum', 'avg']
const ARITH_FNS: readonly unknown[] = ['sum', 'avg']

/** Whether an aggregate's result is numeric: `true` / `false`, `undefined` when it depends on the schema. */
function aggregateNumeric(entry: AggregateExpr, isNumericField?: (field: string) => boolean | undefined): boolean | undefined {
  if (NUMERIC_AGGREGATES.includes(entry.$fn)) return true
  if (isRowOrderFn(entry.$fn) || entry.$fn === 'min' || entry.$fn === 'max') {
    return typeof entry.$field === 'string' ? isNumericField?.(entry.$field) : undefined
  }
  return undefined
}

/** The names a well-formed filter reads, with the relational-predicate keys flagged. Never throws. */
function filterNames(filter: unknown): { names: string[]; relations: string[] } {
  const names: string[] = []
  const relations: string[] = []
  forEachFilterField(filter, (field) => names.push(field), (field) => relations.push(field))
  return { names, relations }
}

/**
 * Validate the shape of a two-level aggregate (`controls.$from`) and resolve both levels —
 * the rules knowable without a table schema. Issues carry a {@link NestedIssueCode}:
 *
 * - `$from` is an object holding only {@link NESTED_STAGE_CONTROLS} (`AGG_NESTED_CONTROL`;
 *   a `$from` inside it is `AGG_NESTED_DEPTH`), with a non-empty `$groupBy`
 *   (`AGG_NESTED_UNGROUPED`); the root has no `$with`, neither level has an object-form
 *   `$select`, the outer `$groupBy` is a list, `$having` / `$sort` / `$rowOrder` / `$nulls`
 *   are objects (a `$having` a well-formed filter), and every `$nulls` key is ordered by
 *   (`AGG_NESTED_CONTROL`);
 * - the inner level passes {@link resolveBuckets} as a grouped query (its issues keep their
 *   messages and codes, under a `$from.` path);
 * - the inner columns — every `$groupBy` key plus every computed `$select` alias — have
 *   distinct names (`AGG_NESTED_DUPLICATE_COLUMN`);
 * - every name the outer level reads (`$groupBy` entries that are not outer bucket aliases,
 *   plain `$select` entries, aggregate `$field`s and field lists, bucket sources, expression
 *   operands, `$where` keys, `$rowOrder` keys) is an inner column; `$having` and `$sort` name
 *   outer result columns (outer `$groupBy` keys and `$select` aliases), and a plain outer
 *   `$select` entry is an outer `$groupBy` key. Anything else is `AGG_NESTED_UNKNOWN_COLUMN`,
 *   with one message whether or not the name is a table field;
 * - the outer result columns have distinct names: no `$select` alias equal to a `$groupBy`
 *   key or to another alias (`AGG_NESTED_DUPLICATE_COLUMN`);
 * - outer `sum` / `avg`, expression operands and bucket sources are not inner columns known
 *   to hold no numbers (`AGG_NESTED_NOT_NUMERIC`; bucket labels, plus whatever
 *   `isNumericField` rules out);
 * - the outer level passes {@link resolveBuckets} with the inner columns as its fields.
 *
 * The level checks of {@link resolveBuckets} keep their own codes: a bucket or expression
 * alias that shadows a field (`isField` inside, an inner column outside) or a `$groupBy` entry
 * naming an expression alias is `AGG_ALIAS_COLLISION` here too ({@link AggregateIssueCode}).
 *
 * The inner level reads the table like a standalone grouped query: field capabilities,
 * schema types and the like stay the caller's, as for {@link resolveBuckets}. Run that
 * capability gate BEFORE `resolveNested`, and let `opts.isNumericField` answer `undefined`
 * for a field the request may not see: a NOT_NUMERIC answer would reveal its type.
 *
 * Never throws on malformed controls: every problem is an issue.
 */
export function resolveNested(
  controls: NestedControlsInput | undefined,
  opts: ResolveNestedOptions = {},
): NestedResolution {
  const stage = controls?.$from
  if (!isPlainObject(stage)) {
    const message = `$from must be an object of ${orList(NESTED_STAGE_CONTROLS)}`
    return { ok: false, issues: [{ path: '$from', message, code: 'AGG_NESTED_CONTROL' }] }
  }
  const root = controls!
  const issues: QueryIssue[] = []
  // A control that is not an object gets one coded issue; the level's own reports at its path are dropped.
  const notObjects = checkNestedControls(stage, root, issues)
  const addLevelIssues = (levelIssues: QueryIssue[], prefix: string) => {
    for (const issue of levelIssues) {
      const path = prefix + issue.path
      if (!notObjects.has(path)) issues.push({ ...issue, path })
    }
  }

  // Inner level: a standalone grouped query; duplicates are reported below as duplicate columns.
  const inner = resolveComputed(stage, { aggregate: true, isField: opts.isField, fns: opts.fns }, false)
  if (!inner.ok) addLevelIssues(inner.issues, '$from.')

  const columns = innerColumns(stage, opts.isNumericField, issues)
  const resultColumns = checkOuterReads(root, columns, issues)
  checkResultRefs(root, resultColumns, issues)

  // Outer duplicates are reported by checkOuterReads as duplicate result columns.
  const outer = resolveComputed(root, { aggregate: true, isField: (name) => columns.has(name), fns: opts.fns }, false)
  if (!outer.ok) addLevelIssues(outer.issues, '')

  if (issues.length || !inner.ok || !outer.ok) return { ok: false, issues }
  const { ok: _i, ...innerLevel } = inner
  const { ok: _o, ...outerLevel } = outer
  return { ok: true, columns: [...columns.values()], inner: innerLevel, outer: outerLevel }
}

/** An issue reporter for `issues` with a fixed {@link NestedIssueCode}. */
function issueWith(issues: QueryIssue[], code: NestedIssueCode) {
  return (path: string, message: string) => {
    issues.push({ path, message, code })
  }
}

/**
 * Controls and control shapes of both levels, in report order: the controls `$from` holds
 * ({@link NESTED_STAGE_CONTROLS}; a `$from` inside it is `AGG_NESTED_DEPTH`), no root `$with`,
 * no object-form `$select`, the outer `$groupBy` is a list, `$having` / `$sort` / `$rowOrder` /
 * `$nulls` of either level are objects (a `$having` a well-formed filter), every `$nulls` key is ordered by
 * (`$sort` / `$rowOrder` at the outer level, `$rowOrder` inside `$from`) and is `'first'` or
 * `'last'`, and the inner `$groupBy` is non-empty (`AGG_NESTED_UNGROUPED`). Returns the paths
 * of the controls reported as not being objects.
 */
function checkNestedControls(stage: Record<string, unknown>, root: NestedControlsInput, issues: QueryIssue[]): Set<string> {
  const notObjects = new Set<string>()
  const control = issueWith(issues, 'AGG_NESTED_CONTROL')
  for (const key of Object.keys(stage)) {
    if (stage[key] === undefined || NESTED_STAGE_CONTROLS.includes(key)) continue
    if (key === '$from') {
      const message = 'A $from cannot have its own $from — a query has two levels at most'
      issues.push({ path: '$from.$from', message, code: 'AGG_NESTED_DEPTH' })
    } else {
      control(
        `$from.${key}`,
        `${key} is not valid inside $from — it takes ${orList(NESTED_STAGE_CONTROLS)}; the query filter applies to the rows it groups`,
      )
    }
  }
  if (root.$with !== undefined) control('$with', '$with is not valid in a two-level aggregate')
  // The object form of `$select` (a projection) has no meaning at either level.
  for (const [path, select] of [['$from.$select', stage.$select], ['$select', root.$select]] as const) {
    if (select !== undefined && !Array.isArray(select)) {
      control(path, `${path} of a two-level aggregate must be a list of columns and computed entries`)
    }
  }
  if (root.$groupBy !== undefined && !Array.isArray(root.$groupBy)) {
    control('$groupBy', '$groupBy must be a list of inner columns and outer bucket aliases')
  }
  const objects: { path: string; value: unknown; filter?: true }[] = [
    { path: '$having', value: root.$having, filter: true },
    { path: '$sort', value: root.$sort },
    { path: '$rowOrder', value: root.$rowOrder },
    { path: '$nulls', value: root.$nulls },
    { path: '$from.$having', value: stage.$having, filter: true },
    { path: '$from.$rowOrder', value: stage.$rowOrder },
    { path: '$from.$nulls', value: stage.$nulls },
  ]
  for (const { path, value, filter } of objects) {
    if (value === undefined) continue
    if (!isPlainObject(value)) {
      notObjects.add(path)
      control(path, `${path} must be an object`)
    } else if (filter) {
      const shape = filterShapeProblem(value)
      if (shape) control(path, `Malformed ${path}: ${shape}`)
    }
  }
  const levels = [
    { path: '$nulls', nulls: root.$nulls, sort: root.$sort, rowOrder: root.$rowOrder, keyOf: '$sort or $rowOrder' },
    { path: '$from.$nulls', nulls: stage.$nulls, sort: undefined, rowOrder: stage.$rowOrder, keyOf: '$rowOrder' },
  ]
  for (const { path, nulls, sort, rowOrder, keyOf } of levels) {
    if (!isPlainObject(nulls)) continue
    const inRowOrder = (key: string) => isPlainObject(rowOrder) && Object.hasOwn(rowOrder, key)
    for (const [key, placement] of Object.entries(nulls)) {
      if (placement === undefined) continue
      if (!inRowOrder(key) && !(isPlainObject(sort) && Object.hasOwn(sort, key))) {
        control(path, `${path} "${key}" names a key that is not ordered by — a $nulls key must be a ${keyOf} key`)
      } else if (!isNullsPlacement(placement) && !inRowOrder(key)) {
        // `$rowOrder` keys' placements are checked with `$rowOrder` itself.
        control(path, `${path} "${key}" must be 'first' or 'last'`)
      }
    }
  }
  const stageGroupBy = stage.$groupBy
  if (!Array.isArray(stageGroupBy) || stageGroupBy.length === 0) {
    const message = 'The inner level ($from) needs a non-empty $groupBy'
    issues.push({ path: '$from.$groupBy', message, code: 'AGG_NESTED_UNGROUPED' })
  }
  return notObjects
}

/**
 * Check every name the outer level reads against the inner `columns` (unknown and not-numeric
 * columns, duplicate result columns) and return the outer result columns: the `$groupBy` keys
 * (a bucket alias among them is its bucket) and the computed `$select` aliases.
 */
function checkOuterReads(root: NestedControlsInput, columns: Map<string, InnerColumn>, issues: QueryIssue[]): Set<string> {
  const unknownColumn = (path: string, name: string) =>
    issues.push({
      path,
      message: `"${name}" is not a column of $from — the outer level reads only its columns (${[...columns.keys()].join(', ')})`,
      code: 'AGG_NESTED_UNKNOWN_COLUMN',
    })
  const notNumeric = (path: string, name: string, what: string) =>
    issues.push({
      path,
      message: `${what} needs a numeric column — "${name}" ${columns.get(name)?.kind === 'bucket' ? 'is a bucket label' : 'does not hold numbers'}`,
      code: 'AGG_NESTED_NOT_NUMERIC',
    })
  /** Report `name` unless it is an inner column; with `what`, also when it is known not to be numeric. */
  const readColumn = (path: string, name: string, what?: string) => {
    const col = columns.get(name)
    if (!col) unknownColumn(path, name)
    else if (what && col.numeric === false) notNumeric(path, name, what)
  }
  const readWhere = (where: unknown) => {
    // A malformed condition is reported by the level's own validation.
    if (where === undefined || whereShapeProblem(where)) return
    const { names, relations } = filterNames(where)
    for (const name of names) readColumn('$select', name)
    for (const name of relations) {
      if (columns.has(name)) {
        const message = `"${name}" is a column of $from — relational predicates do not apply at the outer level`
        issues.push({ path: '$select', message, code: 'AGG_NESTED_UNKNOWN_COLUMN' })
      } else unknownColumn('$select', name)
    }
  }

  const select = Array.isArray(root.$select) ? root.$select : []
  const groupBy = Array.isArray(root.$groupBy) ? root.$groupBy : []
  const groupKeys = new Set(groupBy.filter((g): g is string => typeof g === 'string'))
  const outerBuckets = computedAliases(select, isBucketExpr)
  const outerAliases = new Set<string>()
  const resultColumns = new Set<string>()
  const duplicates = new Set<string>()
  const addResult = (name: string) => {
    if (!resultColumns.has(name)) resultColumns.add(name)
    else if (!duplicates.has(name)) {
      duplicates.add(name)
      issues.push({
        path: '$select',
        message: `Result column "${name}" is defined twice — each outer $groupBy key and $select alias needs its own name`,
        code: 'AGG_NESTED_DUPLICATE_COLUMN',
      })
    }
  }
  for (const g of groupKeys) {
    if (!outerBuckets.has(g)) readColumn('$groupBy', g)
    addResult(g)
  }
  for (const entry of select) {
    if (typeof entry === 'string') {
      if (!columns.has(entry)) unknownColumn('$select', entry)
      else if (!groupKeys.has(entry)) {
        const message = `"${entry}" is not an outer $groupBy key — the outer $select lists $groupBy keys and aggregates`
        issues.push({ path: '$select', message, code: 'AGG_NESTED_UNKNOWN_COLUMN' })
      }
      continue
    }
    if (isBucketExpr(entry)) {
      readColumn('$select', entry.$field, `Bucket over "${entry.$field}"`)
    } else if (isAggregateExpr(entry)) {
      const what = ARITH_FNS.includes(entry.$fn) ? `${entry.$fn}()` : undefined
      for (const field of aggregateFields(entry.$field)) if (field !== '*') readColumn('$select', field, what)
      readWhere(entry.$where)
    } else if (isAggregateOfExpr(entry)) {
      if (validateArith(entry.$expr).length === 0) {
        for (const name of arithNames(entry.$expr)) readColumn('$select', name, `${entry.$fn}(<expression>)`)
      }
      readWhere(entry.$where)
    }
    if (isComputedExpr(entry)) {
      const alias = resolveAlias(entry)
      outerAliases.add(alias)
      // A grouped bucket is already a result column through `$groupBy`.
      if (!(isBucketExpr(entry) && groupKeys.has(alias))) addResult(alias)
    }
  }
  // A group-level expression reads outer aliases (all of them known only now) and outer `$groupBy` keys (inner columns).
  for (const entry of select) {
    if (isSelectArithExpr(entry) && validateArith(entry.$expr).length === 0) {
      for (const name of arithNames(entry.$expr)) {
        if (!outerAliases.has(name) && columns.get(name)?.numeric === false) notNumeric('$select', name, `Expression "${String(entry.$as)}"`)
      }
    }
  }
  if (isPlainObject(root.$rowOrder)) {
    for (const key of Object.keys(root.$rowOrder)) readColumn('$rowOrder', key)
  }
  return resultColumns
}

/** `$having` and `$sort` of the outer level name its result columns. */
function checkResultRefs(root: NestedControlsInput, resultColumns: ReadonlySet<string>, issues: QueryIssue[]): void {
  const resultColumn = (path: string, name: string) => {
    if (!resultColumns.has(name)) {
      const message = `"${name}" is not a column of the result — name an outer $groupBy key or $select alias`
      issues.push({ path, message, code: 'AGG_NESTED_UNKNOWN_COLUMN' })
    }
  }
  // A malformed `$having` is reported by checkNestedControls.
  if (!filterShapeProblem(root.$having)) {
    const { names, relations } = filterNames(root.$having)
    for (const name of [...names, ...relations]) resultColumn('$having', name)
  }
  if (isPlainObject(root.$sort)) {
    for (const key of Object.keys(root.$sort)) resultColumn('$sort', key)
  }
}

/**
 * The inner columns of a `$from` stage, by name: plain `$groupBy` keys (in order, repeats
 * collapsed), then the computed `$select` entries. A name defined twice is reported.
 */
function innerColumns(
  stage: Record<string, unknown>,
  isNumericField: ((field: string) => boolean | undefined) | undefined,
  issues: QueryIssue[],
): Map<string, InnerColumn> {
  const computed: InnerColumn[] = []
  const bucketAliases = new Set<string>()
  if (Array.isArray(stage.$select)) {
    for (const entry of stage.$select) {
      if (isBucketExpr(entry)) {
        const name = resolveAlias(entry)
        bucketAliases.add(name)
        computed.push({ name, kind: 'bucket', numeric: false })
      } else if (isAggregateExpr(entry)) {
        const numeric = aggregateNumeric(entry, isNumericField)
        const col: InnerColumn = { name: resolveAlias(entry), kind: 'aggregate' }
        if (numeric !== undefined) col.numeric = numeric
        computed.push(col)
      } else if (isAggregateOfExpr(entry) || isSelectArithExpr(entry)) {
        if (typeof entry.$as === 'string') computed.push({ name: entry.$as, kind: 'expr', numeric: true })
      }
    }
  }
  const columns = new Map<string, InnerColumn>()
  const reported = new Set<string>()
  const add = (col: InnerColumn) => {
    if (!columns.has(col.name)) {
      columns.set(col.name, col)
    } else if (!reported.has(col.name)) {
      reported.add(col.name)
      issues.push({
        path: '$from.$select',
        message: `Inner column "${col.name}" is defined twice — each $groupBy key and $select alias of $from needs its own name`,
        code: 'AGG_NESTED_DUPLICATE_COLUMN',
      })
    }
  }
  const keys = new Set<string>()
  for (const g of Array.isArray(stage.$groupBy) ? stage.$groupBy : []) {
    if (typeof g !== 'string' || keys.has(g) || bucketAliases.has(g)) continue
    keys.add(g)
    const col: InnerColumn = { name: g, kind: 'key' }
    const numeric = isNumericField?.(g)
    if (numeric !== undefined) col.numeric = numeric
    add(col)
  }
  for (const col of computed) add(col)
  return columns
}
