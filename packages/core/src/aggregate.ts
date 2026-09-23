import { BUCKET_UNITS, WEEK_STARTS, checkTimeZone, type IsoWeekday } from './calendar'
import type { AggregateExpr, BucketExpr, BucketUnit, ComputedExpr, WeekStart } from './types'

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
  const head = isBucketExpr(expr) ? expr.$bucket : (expr as AggregateExpr).$fn
  return `${head}_${expr.$field === '*' ? 'star' : expr.$field}`
}

function isComputedExpr(v: unknown): v is ComputedExpr {
  return isBucketExpr(v) || isAggregateExpr(v)
}

/**
 * @internal Computed-column alias → source field for the computed entries of an
 * array `$select` accepted by `accept` (default: aggregates and buckets). Later
 * entries win on a repeated alias. Empty for a non-array `$select`.
 */
export function computedAliases(
  select: unknown,
  accept: (entry: unknown) => entry is ComputedExpr = isComputedExpr,
): Map<string, string> {
  const out = new Map<string, string>()
  if (Array.isArray(select)) {
    for (const entry of select) {
      if (accept(entry)) out.set(resolveAlias(entry), entry.$field)
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

/** Result of {@link resolveBuckets}. */
export type BucketResolution =
  | { ok: true; buckets: ResolvedBucket[] }
  | { ok: false; issues: QueryIssue[] }

const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** `a, b or c` */
const orList = (items: readonly string[]) => `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
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

/** Options of {@link resolveBuckets}. */
export interface ResolveBucketsOptions {
  /** Whether the query is an aggregate query. Default: `$groupBy` is non-empty. */
  aggregate?: boolean
  /**
   * Whether `name` is a field of the queried table — a bucket alias must not
   * shadow one. Default: the plain fields listed in `$select`.
   */
  isField?: (name: string) => boolean
}

/**
 * Validate the calendar buckets of a query's controls and return them
 * normalized:
 *
 * - each `$select` array entry is a string, an `AggregateExpr` or a `BucketExpr`;
 * - each bucket has a known unit, a valid time zone (canonicalized, see
 *   `checkTimeZone`), a week start only with unit `'week'`, and an identifier
 *   alias (`^[A-Za-z_][A-Za-z0-9_]*$`; a dotted `$field` needs an explicit `$as`);
 * - buckets appear only in aggregate mode (`aggregate` when given, else a non-empty `$groupBy`);
 * - each bucket alias is listed in `$groupBy`;
 * - a bucket alias is unique among `$select` aliases and is not a field name
 *   (`isField`; pass the table's field set to check this fully here);
 * - `$groupBy` entries are strings.
 *
 * Other schema-dependent rules (timestamp-typed source, encryption, dimensions)
 * are the caller's. Issues carry `path` `'$select'` or `'$groupBy'`.
 */
export function resolveBuckets(
  controls: { $select?: unknown; $groupBy?: unknown } | undefined,
  opts: ResolveBucketsOptions = {},
): BucketResolution {
  const issues: QueryIssue[] = []
  const buckets: ResolvedBucket[] = []
  const { $select: select, $groupBy: rawGroupBy } = controls ?? {}
  const groupBy = Array.isArray(rawGroupBy) ? rawGroupBy : []
  const aggregateMode = opts.aggregate ?? groupBy.length > 0

  if (Array.isArray(select)) {
    const fields = new Set<string>()
    const aggAliases = computedAliases(select, isAggregateExpr)
    let sawBucket = false
    for (let i = 0; i < select.length; i++) {
      const entry: unknown = select[i]
      if (typeof entry === 'string') {
        fields.add(entry)
      } else if (isBucketExpr(entry)) {
        sawBucket = true
        const res = validateBucketExpr(entry)
        if (res.ok) buckets.push(res.bucket)
        else issues.push({ path: '$select', message: res.message })
      } else if (!isAggregateExpr(entry)) {
        issues.push({ path: '$select', message: `Unsupported $select entry at index ${i}` })
      }
    }

    if (sawBucket && !aggregateMode) {
      issues.push({ path: '$select', message: 'Calendar buckets are only valid in grouped queries' })
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
  }

  for (let i = 0; i < groupBy.length; i++) {
    if (typeof groupBy[i] !== 'string') {
      issues.push({ path: '$groupBy', message: `Unsupported $groupBy entry at index ${i} — expected a field name or bucket alias` })
    }
  }

  return issues.length ? { ok: false, issues } : { ok: true, buckets }
}
