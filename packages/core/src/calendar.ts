import type { BucketUnit, CalendarBucketLabel, WeekStart } from './types'

/**
 * Calendar-bucket kernel: the reference semantics of a `BucketExpr` value.
 *
 * Every computation is UTC instant → local wall-clock time (never ambiguous),
 * followed by pure calendar arithmetic on its date (or, for `'hour'`, its
 * hour). Nothing converts a local time back to an instant except
 * {@link bucketStartInstant}, which defines its answer for DST gaps and
 * repeats explicitly.
 */

const DAY = 86_400_000
const HOUR = 3_600_000

/** Lower bound (inclusive) of the supported instant range: 1970-01-02T00:00:00Z. */
export const BUCKET_MIN_INSTANT = 86_400_000
/** Upper bound (exclusive) of the supported instant range: 3000-01-01T00:00:00Z. */
export const BUCKET_MAX_INSTANT = 32_503_680_000_000

/** Calendar units, in ascending size. */
export const BUCKET_UNITS: readonly BucketUnit[] = ['hour', 'day', 'week', 'month', 'quarter', 'year']
/** Week-start names, Monday first (ISO 8601 order). */
export const WEEK_STARTS: readonly WeekStart[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/** ISO weekday number: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

/** ISO weekday number of a week start (`'mon'` → 1 … `'sun'` → 7). Throws `RangeError` for anything else. */
function weekStartIso(ws: WeekStart): IsoWeekday {
  const i = WEEK_STARTS.indexOf(ws)
  if (i === -1) throw new RangeError(`Unknown week start "${String(ws)}"`)
  return (i + 1) as IsoWeekday
}

// ── Civil-date arithmetic (proleptic Gregorian; days since 1970-01-01) ──────

function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146_097 + doe - 719_468
}

// civilFromDays writes into these module-level slots to avoid allocating per call.
let cY = 0
let cM = 0
let cD = 0

function civilFromDays(z: number): void {
  z += 719_468
  const era = Math.floor(z / 146_097)
  const doe = z - era * 146_097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  cD = doy - Math.floor((153 * mp + 2) / 5) + 1
  cM = mp < 10 ? mp + 3 : mp - 9
  cY = yoe + era * 400 + (cM <= 2 ? 1 : 0)
}

/** ISO weekday (1 = Mon … 7 = Sun) of a day number. 1970-01-01 was a Thursday. */
function isoWeekday(days: number): number {
  return ((((days + 3) % 7) + 7) % 7) + 1
}

// ── Label formatting (direct-mapped caches: labels repeat heavily) ──────────

const LABEL_SLOTS = 4096
const LABEL_MASK = LABEL_SLOTS - 1
/**
 * Empty-slot marker. No reachable day or hour number equals it (labels span
 * years 0000–9999: |days| < 3e6, |hours| < 7.2e7); -1 would not do, it is
 * 1969-12-31 (or its 23:00 hour).
 */
const EMPTY_SLOT = -2_147_483_648

/** A direct-mapped cache in front of `format`, keyed by a day or hour number. Arrays are allocated on first use. */
function cachedFormatter(format: (n: number) => CalendarBucketLabel): (n: number) => CalendarBucketLabel {
  let keys: Int32Array | undefined
  let text: string[] = []
  return (n) => {
    const slot = n & LABEL_MASK
    if (keys === undefined) {
      keys = new Int32Array(LABEL_SLOTS).fill(EMPTY_SLOT)
      text = Array.from({ length: LABEL_SLOTS }, () => '')
    } else if (keys[slot] === n) {
      return text[slot]
    }
    const label = format(n)
    keys[slot] = n
    text[slot] = label
    return label
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

/** `YYYY-MM-DD` of a day number. */
const formatDays = cachedFormatter((days) => {
  civilFromDays(days)
  const y = cY < 1000 ? `${cY}`.padStart(4, '0') : `${cY}`
  return `${y}-${pad2(cM)}-${pad2(cD)}`
})

/**
 * `YYYY-MM-DDTHH:00` of an hour number (hours since 1970-01-01T00). Cached
 * like days: grouping uses labels as map keys, so a stable string per hour
 * avoids building (and flattening) a concatenation for every row.
 */
const formatHours = cachedFormatter((hours) => {
  const days = Math.floor(hours / 24)
  return `${formatDays(days)}T${pad2(hours - days * 24)}:00`
})

const LABEL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):00)?$/

/**
 * Parse a `YYYY-MM-DD` or `YYYY-MM-DDTHH:00` label into its wall-clock time:
 * milliseconds since 1970-01-01T00:00 on the same (zone-free) calendar.
 */
function parseLabel(label: string): number {
  const m = typeof label === 'string' ? LABEL_RE.exec(label) : null
  if (m) {
    const y = +m[1]
    const mo = +m[2]
    const d = +m[3]
    const h = m[4] === undefined ? 0 : +m[4]
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23) {
      const days = daysFromCivil(y, mo, d)
      civilFromDays(days)
      if (cY === y && cM === mo && cD === d) return days * DAY + h * HOUR
    }
  }
  throw new RangeError(`Invalid calendar bucket label "${String(label)}" — expected YYYY-MM-DD or YYYY-MM-DDTHH:00`)
}

// ── Zone kernel: instant → local wall-clock time ────────────────────────────

/**
 * Per-zone state. `format()` output is parsed by scanning digit runs (cheaper
 * than `formatToParts`); `order` maps each run to year/month/day/hour/minute/second.
 */
interface Zone {
  fmt: Intl.DateTimeFormat
  /** Index into the parsed digit runs for Y, M, D, h, m, s. */
  order: Int8Array
  /** Allocated on the first cache miss (see {@link localTime}). */
  cache: OffsetCache | undefined
}

/**
 * Offset cache: the timeline is cut into 2-day chunks. For a chunk, the UTC
 * offset is read at its first and last millisecond; if they differ, the single
 * transition inside is located by binary search (tz transitions fall on whole
 * seconds). A lookup is then `t + offset` — no `Intl` call.
 * This relies on no zone having two transitions within one chunk: across
 * every zone of tzdata 2026c, 1970–2100, the closest consecutive transitions
 * are 6.96 days apart (America/Boa_Vista 2000, Asia/Gaza 2040). A chunk whose
 * offset right after the located transition differs from its end offset (two
 * non-cancelling transitions) is flagged and served uncached. The cache is
 * direct-mapped by chunk index (8192 slots ≈ 45 years, ~168 KB per zone).
 */
interface OffsetCache {
  /** Chunk index held by each slot; -1 = empty (in-range instants have chunk indices 0..188 099). */
  chunk: Int32Array
  /** Offset (ms) before `transition`. */
  before: Int32Array
  /** Offset (ms) from `transition` on. */
  after: Int32Array
  /** Transition instant inside the chunk; +Infinity when there is none. */
  transition: Float64Array
  /** 1 when the chunk holds more than one transition (served uncached). */
  mixed: Uint8Array
}

const CHUNK = 2 * DAY
const ZONE_SLOTS = 8192 // ~45 years of 2-day chunks per zone before slots are reused
const ZONE_MASK = ZONE_SLOTS - 1
const MAX_ZONES = 32 // bounds memory when many zones are queried
const zones = new Map<string, Zone>()

const PART_INDEX: Record<string, number> = { year: 0, month: 1, day: 2, hour: 3, minute: 4, second: 5 }

function createFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
}

function getZone(tz: string): Zone {
  let zone = zones.get(tz)
  if (!zone) {
    const fmt = createFormatter(tz) // throws RangeError for an unknown zone
    const order = new Int8Array(6)
    let run = 0
    for (const part of fmt.formatToParts(0)) {
      const idx = PART_INDEX[part.type]
      if (idx !== undefined) order[idx] = run++
    }
    zone = { fmt, order, cache: undefined }
    // Evict the oldest zone (Map order is insertion order); a prepared bucketer keeps its own reference.
    if (zones.size >= MAX_ZONES) zones.delete(zones.keys().next().value as string)
    zones.set(tz, zone)
  }
  return zone
}

const runs = new Float64Array(8)
/** Local second of the day of the instant last read by {@link wallDays}. */
let wSecOfDay = 0

/** Local day number of `t` in `zone`, read from `Intl` (no cache); sets `wSecOfDay`. */
function wallDays(zone: Zone, t: number): number {
  const s = zone.fmt.format(t)
  let n = 0
  let r = 0
  let inRun = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 48 && c <= 57) {
      n = n * 10 + (c - 48)
      inRun = true
    } else if (inRun) {
      if (r < 8) runs[r] = n
      r++
      n = 0
      inRun = false
    }
  }
  if (inRun && r < 8) runs[r] = n
  const o = zone.order
  const h = runs[o[3]]
  wSecOfDay = (h === 24 ? 0 : h) * 3600 + runs[o[4]] * 60 + runs[o[5]]
  return daysFromCivil(runs[o[0]], runs[o[1]], runs[o[2]])
}

/**
 * Local wall-clock time of `t` in `zone` — ms since 1970-01-01T00:00 local,
 * truncated to the whole second — read from `Intl` (no cache).
 */
function wallTime(zone: Zone, t: number): number {
  return wallDays(zone, t) * DAY + wSecOfDay * 1000
}

/** UTC offset (ms, whole seconds) in effect at `t`. */
function offsetAt(zone: Zone, t: number): number {
  return wallTime(zone, t) - Math.floor(t / 1000) * 1000
}

function fillChunk(zone: Zone, cache: OffsetCache, c: number, slot: number): void {
  const a = c * CHUNK
  const b = a + CHUNK - 1
  const before = offsetAt(zone, a)
  const after = offsetAt(zone, b)
  let transition = Number.POSITIVE_INFINITY
  let mixed = 0
  if (before !== after) {
    // Offsets are a function of the whole second; find the first second with a new offset.
    let lo = Math.floor(a / 1000)
    let hi = Math.floor(b / 1000)
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (offsetAt(zone, mid * 1000) === before) lo = mid
      else hi = mid
    }
    transition = hi * 1000
    if (offsetAt(zone, transition) !== after) mixed = 1
  }
  cache.chunk[slot] = c
  cache.before[slot] = before
  cache.after[slot] = after
  cache.transition[slot] = transition
  cache.mixed[slot] = mixed
}

function newOffsetCache(): OffsetCache {
  return {
    chunk: new Int32Array(ZONE_SLOTS).fill(-1),
    before: new Int32Array(ZONE_SLOTS),
    after: new Int32Array(ZONE_SLOTS),
    transition: new Float64Array(ZONE_SLOTS),
    mixed: new Uint8Array(ZONE_SLOTS),
  }
}

/** Local wall-clock time (ms since 1970-01-01T00:00 local) of an in-range instant `t`, through the offset cache. */
function localTime(zone: Zone, t: number): number {
  const cache = (zone.cache ??= newOffsetCache())
  const c = Math.floor(t / CHUNK)
  const slot = c & ZONE_MASK
  if (cache.chunk[slot] !== c) fillChunk(zone, cache, c, slot)
  if (cache.mixed[slot] === 1) return wallTime(zone, t)
  return t + (t < cache.transition[slot] ? cache.before[slot] : cache.after[slot])
}

/** Within `[BUCKET_MIN_INSTANT, BUCKET_MAX_INSTANT)` (false for `NaN`). */
function inRange(t: number): boolean {
  return t >= BUCKET_MIN_INSTANT && t < BUCKET_MAX_INSTANT
}

function toInstant(ms: unknown): number | null {
  const t = typeof ms === 'bigint' ? Number(ms) : ms
  return typeof t === 'number' && inRange(t) ? t : null
}

// ── Calendar truncation ─────────────────────────────────────────────────────

const MONTH_SPANS = new Map<unknown, number>([
  ['month', 1],
  ['quarter', 3],
  ['year', 12],
])

/** Months per bucket for month / quarter / year, 0 for hour / day / week. Throws `RangeError` for an unknown unit. */
function monthSpan(unit: BucketUnit): number {
  if (unit === 'hour' || unit === 'day' || unit === 'week') return 0
  const span = MONTH_SPANS.get(unit)
  if (span === undefined) throw new RangeError(`Unknown bucket unit "${String(unit)}"`)
  return span
}

/** Week start as an ISO weekday for `'week'`, 0 for every other unit (its week start is ignored). */
function weekStartOf(unit: BucketUnit, weekStart: WeekStart): number {
  return unit === 'week' ? weekStartIso(weekStart) : 0
}

/**
 * First day of the bucket holding day `days`: a `span`-month bucket aligned to
 * January when `span` > 0, else the week starting on ISO weekday `ws`, else (`ws` 0) the day.
 */
function truncate(days: number, span: number, ws: number): number {
  if (span === 0) return ws === 0 ? days : days - ((isoWeekday(days) - ws + 7) % 7)
  civilFromDays(days)
  return daysFromCivil(cY, cM - ((cM - 1) % span), 1)
}

/** First day of the bucket after the one starting on day `first` (see {@link truncate}). */
function nextBucketStart(first: number, span: number, ws: number): number {
  if (span === 0) return first + (ws === 0 ? 1 : 7)
  civilFromDays(first)
  const m = cM + span
  return m > 12 ? daysFromCivil(cY + 1, m - 12, 1) : daysFromCivil(cY, m, 1)
}

// ── Bucket labels ───────────────────────────────────────────────────────────

/** Local wall-clock time of an in-range instant in a zone. */
type WallResolver = (zone: Zone, t: number) => number

/**
 * Resolve unit, week start and zone once; the returned function labels an
 * in-range instant. Throws `RangeError` for an unknown unit, zone, or (unit
 * `'week'` only) week start.
 *
 * An `'hour'` bucket is the local wall-clock hour: during a DST fall-back the
 * repeated hour's two UTC hours share one label, and a skipped hour has none
 * — the same rule as `'day'`, whose fall-back day lasts 25 hours.
 */
function prepare(
  unit: BucketUnit,
  tz: string,
  weekStart: WeekStart,
  wallOf: WallResolver,
): (t: number) => CalendarBucketLabel {
  const span = monthSpan(unit)
  const ws = weekStartOf(unit, weekStart)
  if (tz === 'UTC') {
    if (unit === 'hour') return (t) => formatHours(Math.floor(t / HOUR))
    return (t) => formatDays(truncate(Math.floor(t / DAY), span, ws))
  }
  const zone = getZone(tz)
  if (unit === 'hour') return (t) => formatHours(Math.floor(wallOf(zone, t) / HOUR))
  return (t) => formatDays(truncate(Math.floor(wallOf(zone, t) / DAY), span, ws))
}

/**
 * A prepared {@link bucketLabel}: resolves `unit`, `tz` and `weekStart` once
 * and returns a per-row function — use it to label many instants with the
 * same bucket (an in-memory group-by, a SQL user-defined function).
 *
 * Throws `RangeError` immediately for an unknown unit or zone, or an unknown
 * week start with unit `'week'` (`weekStart` is ignored for other units).
 * `tz` must already be valid (see {@link checkTimeZone}). The returned
 * function has `bucketLabel`'s input contract: `null` for null/undefined/
 * non-numeric input and out-of-range instants, `bigint` accepted.
 */
export function bucketer(
  unit: BucketUnit,
  tz = 'UTC',
  weekStart: WeekStart = 'mon',
): (ms: number | bigint | null | undefined) => CalendarBucketLabel | null {
  const label = prepare(unit, tz, weekStart, localTime)
  return (ms) => {
    const t = toInstant(ms)
    return t === null ? null : label(t)
  }
}

// bucketLabel reuses the labeler prepared for its previous call's arguments.
let last: { unit: BucketUnit; tz: string; weekStart: WeekStart; label: (t: number) => CalendarBucketLabel } | undefined

/**
 * Calendar-bucket label of an epoch-ms instant: the ISO local date `YYYY-MM-DD`
 * of the first day of the `unit` bucket containing `ms` in time zone `tz`,
 * or for `'hour'` the local date and hour `YYYY-MM-DDTHH:00` (wall clock: a
 * DST fall-back's repeated hour is one label covering two UTC hours).
 *
 * Returns `null` for null/undefined/non-numeric input and for instants outside
 * `[BUCKET_MIN_INSTANT, BUCKET_MAX_INSTANT)`. `bigint` input is accepted.
 * `tz` must already be valid (see {@link checkTimeZone}); an unknown zone
 * throws the runtime's `RangeError`. `weekStart` is used only by `'week'`.
 * To label many instants with the same bucket, prefer {@link bucketer}.
 */
export function bucketLabel(
  ms: number | bigint | null | undefined,
  unit: BucketUnit,
  tz = 'UTC',
  weekStart: WeekStart = 'mon',
): CalendarBucketLabel | null {
  const t = toInstant(ms)
  if (t === null) return null
  if (last === undefined || last.unit !== unit || last.tz !== tz || last.weekStart !== weekStart) {
    last = { unit, tz, weekStart, label: prepare(unit, tz, weekStart, localTime) }
  }
  return last.label(t)
}

/** @internal Uncached twin of {@link bucketLabel} (every instant read from `Intl`), used to property-test the offset cache. */
export function bucketLabelUncached(
  ms: number | bigint | null | undefined,
  unit: BucketUnit,
  tz = 'UTC',
  weekStart: WeekStart = 'mon',
): CalendarBucketLabel | null {
  const t = toInstant(ms)
  return t === null ? null : prepare(unit, tz, weekStart, wallTime)(t)
}

/** Options of {@link nextBucketLabel} and {@link bucketSeries}. */
export interface NextBucketOptions {
  /** First day of a `'week'` bucket; default `'mon'`. Ignored by other units. */
  weekStart?: WeekStart
  /**
   * The query's time zone. When given, a label no instant has in that zone is
   * stepped over: the local hour a DST spring-forward skips (`'hour'`), or a
   * skipped date such as Pacific/Apia's 2011-12-30 (`'day'`). Default `'UTC'`,
   * where every label occurs.
   */
  tz?: string
}

/** Options of {@link bucketSeries}. */
export interface BucketSeriesOptions extends NextBucketOptions {
  /** Most labels returned; a longer series throws `RangeError`. Default 100 000. */
  maxLength?: number
}

/**
 * The first label at or after wall-clock `n * size` (`size` = HOUR or DAY)
 * that some instant has in `zone`, as a label number. The usual case — the
 * wall time occurs — is answered through the offset cache; only a wall time
 * near a transition goes to {@link firstInstantAt}, whose answer in a gap is
 * the transition instant, i.e. the first label after the gap.
 */
function occurringLabel(zone: Zone, n: number, size: number): number {
  const wall = n * size
  if (inRange(wall)) {
    const t = wall - (localTime(zone, wall) - wall) // under the offset in effect at instant `wall`
    if (inRange(t) && localTime(zone, t) === wall) return n
  }
  return Math.floor(wallTime(zone, firstInstantAt(zone, wall)) / size)
}

/**
 * Step functions over label wall times (ms since 1970-01-01T00:00 on the
 * label's calendar), for wall time `wall` of any instant of a bucket:
 * `floor` → wall time of that bucket's start, `next` → of the next bucket's
 * start. Resolves unit, week start and zone once.
 */
function stepper(
  unit: BucketUnit,
  weekStart: WeekStart,
  tz: string,
): { floor: (wall: number) => number; next: (wall: number) => number } {
  const span = monthSpan(unit)
  const ws = weekStartOf(unit, weekStart)
  const zone = tz === 'UTC' ? undefined : getZone(tz)
  if (unit === 'hour') {
    return {
      floor: (wall) => Math.floor(wall / HOUR) * HOUR,
      next: (wall) => {
        const hours = Math.floor(wall / HOUR) + 1
        return (zone ? occurringLabel(zone, hours, HOUR) : hours) * HOUR
      },
    }
  }
  // Only an hour or a day can be skipped whole; a week or longer always has instants.
  const check = unit === 'day' ? zone : undefined
  return {
    floor: (wall) => truncate(Math.floor(wall / DAY), span, ws) * DAY,
    next: (wall) => {
      const days = nextBucketStart(truncate(Math.floor(wall / DAY), span, ws), span, ws)
      return (check ? occurringLabel(check, days, DAY) : days) * DAY
    },
  }
}

/** The label of a bucket start's wall time. */
function formatWall(wall: number, unit: BucketUnit): CalendarBucketLabel {
  return unit === 'hour' ? formatHours(wall / HOUR) : formatDays(wall / DAY)
}

/**
 * The label of the bucket that follows the one containing `label` — a
 * calendar step. `label` need not be a bucket start (`'2026-01-31'` + month
 * → `'2026-02-01'`) and may be either format (`'2026-03-29T05:00'` + day →
 * `'2026-03-30'`, `'2026-03-29'` + hour → `'2026-03-29T01:00'`). To fill
 * gaps between returned labels, prefer {@link bucketSeries}.
 *
 * The third argument is {@link NextBucketOptions}, or (legacy form) the week
 * start. The step is zone-free unless `tz` is given; pass the query's `$tz`
 * with `'hour'` so the hour a DST spring-forward skips is not generated
 * (`'2026-03-29T01:00'` → `'2026-03-29T03:00'` in Europe/Berlin).
 * Throws `RangeError` for a malformed label, an unknown unit, week start or zone.
 */
export function nextBucketLabel(
  label: CalendarBucketLabel,
  unit: BucketUnit,
  options: WeekStart | NextBucketOptions = 'mon',
): CalendarBucketLabel {
  const { weekStart = 'mon', tz = 'UTC' }: NextBucketOptions =
    typeof options === 'object' && options !== null ? options : { weekStart: options }
  return formatWall(stepper(unit, weekStart, tz).next(parseLabel(label)), unit)
}

/**
 * Every bucket label from the bucket containing `first` through the one
 * containing `last`, inclusive — the full axis for filling gaps between the
 * labels a grouped query returned. Pass the query's unit, `$weekStart` and
 * `$tz`: with `tz`, labels that never occur in that zone (an hour a DST
 * spring-forward skips) are left out, so the series holds exactly the labels
 * the database can return. `[]` when `first` is after `last`.
 *
 * Throws `RangeError` for a malformed label, an unknown unit, week start or
 * zone, or a series longer than `maxLength` (default 100 000).
 */
export function bucketSeries(
  first: CalendarBucketLabel,
  last: CalendarBucketLabel,
  unit: BucketUnit,
  options: BucketSeriesOptions = {},
): CalendarBucketLabel[] {
  const step = stepper(unit, options.weekStart ?? 'mon', options.tz ?? 'UTC')
  const maxLength = options.maxLength ?? 100_000
  const end = parseLabel(last)
  const out: CalendarBucketLabel[] = []
  for (let wall = step.floor(parseLabel(first)); wall <= end; wall = step.next(wall)) {
    if (out.length >= maxLength) {
      throw new RangeError(`Calendar bucket series from "${first}" to "${last}" exceeds ${maxLength} labels`)
    }
    out.push(formatWall(wall, unit))
  }
  return out
}

/**
 * Smallest instant whose local wall-clock time in `zone` is `wall` (a whole
 * second); when `wall` falls in a DST gap, the transition instant — the first
 * that is at or after `wall` locally.
 */
function firstInstantAt(zone: Zone, wall: number): number {
  // Candidates: `wall` under each offset in effect near it; the smallest that maps back wins.
  let best = Number.POSITIVE_INFINITY
  for (const probe of [wall - 14 * HOUR, wall, wall + 14 * HOUR]) {
    const t = wall - offsetAt(zone, probe)
    if (t < best && wallTime(zone, t) === wall) best = t
  }
  if (best !== Number.POSITIVE_INFINITY) return best
  // `wall` does not exist: binary-search the first instant at or after it locally.
  // Offsets lie within [-12h, +14h], so lo is still before `wall` locally and hi already past it.
  let lo = wall - 15 * HOUR
  let hi = wall + 13 * HOUR
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (wallTime(zone, mid) >= wall) hi = mid
    else lo = mid
  }
  return hi
}

/**
 * First instant (epoch ms) of a bucket label in `tz`: for a `YYYY-MM-DD`
 * label the smallest `t` whose local date is that day, for a
 * `YYYY-MM-DDTHH:00` label the smallest `t` whose local wall-clock hour is
 * that hour. Labels are wall-clock times in the bucket's zone — use this, not
 * `new Date(label)` (which reads them in the runtime's zone), for the instant.
 *
 * - A repeated hour (DST fall-back) or repeated date starts at its FIRST occurrence.
 * - A start that does not exist — a day whose midnight falls in a DST gap
 *   (America/Santiago skips 00:00 on its spring-forward Sunday), or an hour a
 *   spring-forward skips entirely — resolves to the transition instant, i.e.
 *   the first wall-clock moment after the gap. A skipped hour therefore
 *   shares its start with the next hour (`bucketSeries` / `nextBucketLabel` with
 *   `tz` never produce one).
 *
 * Throws `RangeError` for a malformed label or unknown zone.
 */
export function bucketStartInstant(label: CalendarBucketLabel, tz = 'UTC'): number {
  const wall = parseLabel(label)
  return tz === 'UTC' ? wall : firstInstantAt(getZone(tz), wall)
}

// ── Time-zone validation ────────────────────────────────────────────────────

/** Charset of an acceptable zone name — the SQL-inlining safety boundary. */
export const TIME_ZONE_NAME_RE = /^[A-Za-z0-9_+\-/]{1,64}$/

/**
 * IANA renames that ICU/CLDR (and so V8's `Intl.supportedValuesOf`) still lists
 * under the old spelling. The current IANA spelling is accepted; the old one is
 * rejected as an alias. Keeps the accepted set identical on runtimes that list
 * either spelling.
 */
const IANA_RENAMES: Record<string, string> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
}

let accepted: Map<string, string> | undefined

function runtimeAccepts(tz: string): boolean {
  try {
    createFormatter(tz)
    return true
  } catch {
    return false
  }
}

/** Lower-cased name → accepted spelling. Built once. */
function acceptedZones(): Map<string, string> {
  if (accepted) return accepted
  accepted = new Map()
  const supportedValuesOf = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  const listed = typeof supportedValuesOf === 'function' ? supportedValuesOf('timeZone') : []
  for (const name of listed) accepted.set(name.toLowerCase(), name)
  for (const [legacy, current] of Object.entries(IANA_RENAMES)) {
    accepted.delete(legacy.toLowerCase())
    if (runtimeAccepts(current)) accepted.set(current.toLowerCase(), current)
  }
  // Fixed-offset IANA zones (note the POSIX sign: Etc/GMT+5 is UTC−5).
  for (let h = 1; h <= 14; h++) {
    for (const name of h <= 12 ? [`Etc/GMT+${h}`, `Etc/GMT-${h}`] : [`Etc/GMT-${h}`]) {
      if (runtimeAccepts(name)) accepted.set(name.toLowerCase(), name)
    }
  }
  accepted.delete('utc')
  return accepted
}

/** Result of {@link checkTimeZone}. */
export type TimeZoneCheck = { ok: true; tz: string } | { ok: false; message: string }

/**
 * Validate and canonicalize a time-zone name.
 *
 * 1. It must match {@link TIME_ZONE_NAME_RE} (the SQL-inlining safety boundary).
 * 2. `'UTC'` in any case → `'UTC'`.
 * 3. Otherwise it is looked up case-insensitively in the runtime's
 *    `Intl.supportedValuesOf('timeZone')` (overlaid with current IANA spellings
 *    of renamed zones and the `Etc/GMT±N` zones) and the listed spelling is returned.
 * 4. Aliases (`US/Eastern`, `Asia/Calcutta`, `Etc/UTC`, `CET`) are rejected with a
 *    hint naming the canonical zone; offsets and unknown names are rejected.
 */
export function checkTimeZone(tz: unknown): TimeZoneCheck {
  if (typeof tz !== 'string') return { ok: false, message: 'Time zone must be a string' }
  if (!TIME_ZONE_NAME_RE.test(tz)) {
    return { ok: false, message: `Invalid time zone "${tz}" — use an IANA name such as "Europe/Berlin"` }
  }
  const lower = tz.toLowerCase()
  if (lower === 'utc') return { ok: true, tz: 'UTC' }
  const listed = acceptedZones().get(lower)
  if (listed) return { ok: true, tz: listed }
  // Not accepted: an alias (hint its canonical name) or unknown.
  let canonical: string | undefined
  try {
    const resolved = createFormatter(tz).resolvedOptions().timeZone
    canonical = IANA_RENAMES[resolved] ?? resolved
  } catch {
    // unknown to the runtime
  }
  if (canonical && canonical.toLowerCase() !== lower && (canonical === 'UTC' || acceptedZones().has(canonical.toLowerCase()))) {
    return { ok: false, message: `Time zone "${tz}" is an alias — use "${canonical}"` }
  }
  return { ok: false, message: `Unknown time zone "${tz}"` }
}
