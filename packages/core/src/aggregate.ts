import { BUCKET_UNITS, WEEK_STARTS, checkTimeZone, type IsoWeekday } from './calendar'
import { arithNames, validateArith } from './arith'
import type {
  AggregateExpr,
  AggregateFn,
  AggregateOfExpr,
  ArithExpr,
  BucketExpr,
  BucketUnit,
  ComputedExpr,
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

/** True for an aggregate `$select` entry: `$fn` and `$field` strings, no `$bucket`. */
export function isAggregateExpr(v: unknown): v is AggregateExpr {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as AggregateExpr).$fn === 'string' &&
    typeof (v as AggregateExpr).$field === 'string' &&
    !('$bucket' in v)
  )
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
 * (`count(*)` → `count_star`). Runtime twin of the `ResolveAlias` type.
 */
export function resolveAlias(expr: ComputedExpr): string {
  if (expr.$as) return expr.$as
  if (!('$field' in expr)) return ''
  const head = isBucketExpr(expr) ? expr.$bucket : (expr as AggregateExpr).$fn
  return `${head}_${expr.$field === '*' ? 'star' : expr.$field}`
}

function isComputedExpr(v: unknown): v is ComputedExpr {
  return isBucketExpr(v) || isAggregateExpr(v) || isAggregateOfExpr(v) || isSelectArithExpr(v)
}

/**
 * @internal Computed-column alias → source field for the computed entries of an
 * array `$select` accepted by `accept` (default: every computed kind). An
 * expression entry has no single source field and is left out (its alias is its
 * own `$as`). Later entries win on a repeated alias. Empty for a non-array `$select`.
 */
export function computedAliases(
  select: unknown,
  accept: (entry: unknown) => entry is ComputedExpr = isComputedExpr,
): Map<string, string> {
  const out = new Map<string, string>()
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
    const field = bucketField.get(entry) ?? entry
    if (!seen.has(field)) {
      seen.add(field)
      out.push(field)
    }
  }
  return out
}

/** One validation failure: the control it concerns and a user-facing message. */
export interface QueryIssue {
  path: string
  message: string
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
 * `$fn` is in `fns` (only when given), and `'*'` is used only by a known
 * function that accepts it ({@link STAR_AGGREGATE_FNS}). A custom function's
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
  if (expr.$field === '*' && isAggregateFn(fn) && !STAR_AGGREGATE_FNS.includes(fn)) {
    const message = `Aggregate "${fn}" needs a field — only ${orList(STAR_AGGREGATE_FNS)} accepts *`
    return { ok: false, message }
  }
  return { ok: true }
}

/** Options of {@link resolveBuckets}. */
export interface ResolveBucketsOptions {
  /** Whether the query is an aggregate query. Default: `$groupBy` is non-empty. */
  aggregate?: boolean
  /**
   * Whether `name` is a field of the queried table — a bucket alias must not
   * shadow one. Default: the plain fields listed in `$select`.
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
 *   is rejected without them;
 * - each bucket alias is listed in `$groupBy`; no `$groupBy` entry is an expression alias;
 * - a bucket or expression alias is unique among `$select` aliases and is not a
 *   field name (`isField`; pass the table's field set to check this fully here);
 * - `$groupBy` entries are strings.
 *
 * Schema-dependent rules (numeric operand types, timestamp-typed bucket source,
 * encryption, dimensions) are the caller's. Issues carry `path` `'$select'`,
 * `'$groupBy'` or `'$rowOrder'`.
 */
export function resolveBuckets(
  controls: { $select?: unknown; $groupBy?: unknown; $rowOrder?: unknown } | undefined,
  opts: ResolveBucketsOptions = {},
): BucketResolution {
  const issues: QueryIssue[] = []
  const buckets: ResolvedBucket[] = []
  let exprs: ResolvedSelectExpr[] = []
  const { $select: select, $groupBy: rawGroupBy, $rowOrder: rawRowOrder } = controls ?? {}
  const groupBy = Array.isArray(rawGroupBy) ? rawGroupBy : []
  const aggregateMode = opts.aggregate ?? groupBy.length > 0
  let sawRowFn = false

  if (Array.isArray(select)) {
    const fields = new Set<string>()
    const aggAliases = computedAliases(select, isAggregateExpr)
    // Every alias of a computed entry, with its count: an expression alias must be unique among all of them.
    const aliasCount = new Map<string, number>()
    const bucketAliases = new Set<string>()
    const numericAliases = new Set<string>()
    const exprAliases = new Set<string>()
    const rowExprs: ResolvedSelectExpr[] = []
    const groupExprs: { alias: string; expr: ArithExpr }[] = []
    let sawBucket = false
    let sawExpr = false
    for (let i = 0; i < select.length; i++) {
      const entry: unknown = select[i]
      if (typeof entry === 'string') {
        fields.add(entry)
        continue
      }
      if (!isComputedExpr(entry)) {
        issues.push({ path: '$select', message: `Unsupported $select entry at index ${i}` })
        continue
      }
      const entryAlias = resolveAlias(entry)
      aliasCount.set(entryAlias, (aliasCount.get(entryAlias) ?? 0) + 1)
      if (isBucketExpr(entry)) {
        sawBucket = true
        const res = validateBucketExpr(entry)
        if (res.ok) {
          buckets.push(res.bucket)
          bucketAliases.add(res.bucket.alias)
        } else issues.push({ path: '$select', message: res.message })
      } else if (isAggregateExpr(entry)) {
        if (isRowOrderFn(entry.$fn)) sawRowFn = true
        const res = validateAggregateExpr(entry, { fns: opts.fns })
        if (!res.ok) issues.push({ path: '$select', message: res.message })
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
        if (alias !== undefined) {
          numericAliases.add(alias)
          exprAliases.add(alias)
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
    const seen = new Set<string>()
    for (const b of buckets) {
      if (isField(b.alias)) {
        issues.push({ path: '$select', message: `Alias "${b.alias}" collides with field "${b.alias}"` })
      } else if (seen.has(b.alias) || aggAliases.has(b.alias)) {
        issues.push({ path: '$select', message: `Duplicate alias "${b.alias}"` })
      }
      seen.add(b.alias)
      if (aggregateMode && !groupBy.includes(b.alias)) {
        issues.push({ path: '$select', message: `Bucket "${b.alias}" in $select must also appear in $groupBy` })
      }
    }

    exprs = resolveSelectExprs(
      { rowExprs, groupExprs, exprAliases, aliasCount, numericAliases, bucketAliases, groupBy, isField },
      issues,
    )
  }

  for (let i = 0; i < groupBy.length; i++) {
    if (typeof groupBy[i] !== 'string') {
      issues.push({ path: '$groupBy', message: `Unsupported $groupBy entry at index ${i} — expected a field name or bucket alias` })
    }
  }

  const rowOrder = checkRowOrder(rawRowOrder, sawRowFn, issues)

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
  /** Occurrences of each computed alias in `$select`. */
  aliasCount: ReadonlyMap<string, number>
  /** Aliases of numeric entries (aggregates and expressions): valid operands. */
  numericAliases: ReadonlySet<string>
  bucketAliases: ReadonlySet<string>
  groupBy: readonly unknown[]
  isField: (name: string) => boolean
}

/**
 * Expression rules that need the whole `$select`: alias uniqueness, operand
 * resolution and dependency order of group-level entries (cycle check), and
 * "no `$groupBy` on an expression". Returns row-level entries first, then
 * group-level in dependency order.
 */
function resolveSelectExprs(ctx: SelectExprContext, issues: QueryIssue[]): ResolvedSelectExpr[] {
  const { rowExprs, groupExprs, exprAliases, aliasCount, numericAliases, bucketAliases, groupBy } = ctx
  if (!exprAliases.size) return []

  for (const alias of exprAliases) {
    if (ctx.isField(alias)) {
      issues.push({ path: '$select', message: `Alias "${alias}" collides with field "${alias}"` })
    } else if ((aliasCount.get(alias) ?? 0) > 1) {
      issues.push({ path: '$select', message: `Duplicate alias "${alias}"` })
    }
  }

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
      issues.push({ path: '$groupBy', message: `Cannot group by a computed expression "${g}"` })
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

/** Group-level entries in dependency order; reports a cycle. */
function orderGroupExprs(
  groupLevel: ResolvedSelectExpr[],
  deps: Map<string, string[]>,
  issues: QueryIssue[],
): ResolvedSelectExpr[] {
  const out: ResolvedSelectExpr[] = []
  const byAlias = new Map(groupLevel.map((e) => [e.alias, e]))
  const state = new Map<string, 1 | 2>() // 1 = visiting, 2 = done
  let cycleReported = false
  const visit = (alias: string, path: string[]): void => {
    if (state.get(alias) === 2) return
    if (state.get(alias) === 1) {
      if (!cycleReported) {
        cycleReported = true
        const loop = [...path.slice(path.indexOf(alias)), alias]
        issues.push({ path: '$select', message: `Expression cycle: ${loop.join(' → ')}` })
      }
      return
    }
    state.set(alias, 1)
    for (const dep of deps.get(alias) ?? []) if (byAlias.has(dep)) visit(dep, [...path, alias])
    state.set(alias, 2)
    out.push(byAlias.get(alias)!)
  }
  for (const alias of byAlias.keys()) visit(alias, [])
  return out
}

/** Validate `$rowOrder`; returns its keys when `first()` / `last()` are used. */
function checkRowOrder(raw: unknown, usesRowFn: boolean, issues: QueryIssue[]): ResolvedRowOrderKey[] | undefined {
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
  const keys: ResolvedRowOrderKey[] = []
  for (const [field, dir] of Object.entries(raw)) {
    if (dir !== 1 && dir !== -1) {
      issues.push({ path: '$rowOrder', message: `$rowOrder "${field}" must be 1 or -1` })
    } else keys.push({ field, desc: dir === -1 })
  }
  return keys
}
