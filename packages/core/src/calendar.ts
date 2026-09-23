import type { BucketUnit, CalendarBucketLabel, WeekStart } from './types'

/**
 * Calendar-bucket kernel: the reference semantics of a `BucketExpr` value.
 *
 * Every computation is UTC instant → local calendar date (never ambiguous),
 * followed by pure calendar arithmetic on that date. Nothing converts a local
 * time back to an instant except {@link bucketStartInstant}, which defines its
 * answer for DST-gap days explicitly.
 */

const DAY = 86_400_000

/** Lower bound (inclusive) of the supported instant range: 1970-01-02T00:00:00Z. */
export const BUCKET_MIN_INSTANT = 86_400_000
/** Upper bound (exclusive) of the supported instant range: 3000-01-01T00:00:00Z. */
export const BUCKET_MAX_INSTANT = 32_503_680_000_000

/** Calendar units, in ascending size. */
export const BUCKET_UNITS: readonly BucketUnit[] = ['day', 'week', 'month', 'quarter', 'year']
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

// ── Label formatting (direct-mapped cache: labels repeat heavily) ───────────

const LABEL_SLOTS = 4096
const LABEL_MASK = LABEL_SLOTS - 1
/**
 * Empty-slot marker. No reachable day number equals it (labels span years
 * 0000–9999, |days| < 3e6); -1 would not do, it is 1969-12-31.
 */
const NO_DAY = -2_147_483_648
// Allocated on the first formatDays call, not at module load.
let labelDays: Int32Array | undefined
let labelText: string[] = []

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function formatDays(days: number): CalendarBucketLabel {
  const slot = days & LABEL_MASK
  if (labelDays === undefined) {
    labelDays = new Int32Array(LABEL_SLOTS).fill(NO_DAY)
    labelText = Array.from({ length: LABEL_SLOTS }, () => '')
  } else if (labelDays[slot] === days) {
    return labelText[slot]
  }
  civilFromDays(days)
  const y = cY < 1000 ? `${cY}`.padStart(4, '0') : `${cY}`
  const label = `${y}-${pad2(cM)}-${pad2(cD)}`
  labelDays[slot] = days
  labelText[slot] = label
  return label
}

const LABEL_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseLabel(label: string): number {
  const m = typeof label === 'string' ? LABEL_RE.exec(label) : null
  if (m) {
    const y = +m[1]
    const mo = +m[2]
    const d = +m[3]
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const days = daysFromCivil(y, mo, d)
      civilFromDays(days)
      if (cY === y && cM === mo && cD === d) return days
    }
  }
  throw new RangeError(`Invalid calendar bucket label "${String(label)}" — expected YYYY-MM-DD`)
}

// ── Zone kernel: instant → local day number ─────────────────────────────────

/**
 * Per-zone state. `format()` output is parsed by scanning digit runs (cheaper
 * than `formatToParts`); `order` maps each run to year/month/day/hour/minute/second.
 */
interface Zone {
  fmt: Intl.DateTimeFormat
  /** Index into the parsed digit runs for Y, M, D, h, m, s. */
  order: Int8Array
  /** Allocated on the first cache miss (see {@link localDays}). */
  cache: OffsetCache | undefined
}

/**
 * Offset cache: the timeline is cut into 2-day chunks. For a chunk, the UTC
 * offset is read at its first and last millisecond; if they differ, the single
 * transition inside is located by binary search (tz transitions fall on whole
 * seconds). A lookup is then `floor((t + offset) / DAY)` — no `Intl` call.
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

/** UTC offset (ms, whole seconds) in effect at `t`. */
function offsetAt(zone: Zone, t: number): number {
  return wallDays(zone, t) * DAY + wSecOfDay * 1000 - Math.floor(t / 1000) * 1000
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

/** Local day number of an in-range instant `t`, through the offset cache. */
function localDays(zone: Zone, t: number): number {
  const cache = (zone.cache ??= newOffsetCache())
  const c = Math.floor(t / CHUNK)
  const slot = c & ZONE_MASK
  if (cache.chunk[slot] !== c) fillChunk(zone, cache, c, slot)
  if (cache.mixed[slot] === 1) return wallDays(zone, t)
  return Math.floor((t + (t < cache.transition[slot] ? cache.before[slot] : cache.after[slot])) / DAY)
}

function toInstant(ms: unknown): number | null {
  const t = typeof ms === 'bigint' ? Number(ms) : ms
  if (typeof t !== 'number' || !(t >= BUCKET_MIN_INSTANT && t < BUCKET_MAX_INSTANT)) return null
  return t
}

// ── Calendar truncation ─────────────────────────────────────────────────────

const MONTH_SPANS = new Map<unknown, number>([
  ['month', 1],
  ['quarter', 3],
  ['year', 12],
])

/** Months per bucket for month / quarter / year, 0 for day / week. Throws `RangeError` for an unknown unit. */
function monthSpan(unit: BucketUnit): number {
  if (unit === 'day' || unit === 'week') return 0
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

/** Local day number of an in-range instant in a zone. */
type DayResolver = (zone: Zone, t: number) => number

/**
 * Resolve unit, week start and zone once; the returned function labels an
 * in-range instant. Throws `RangeError` for an unknown unit, zone, or (unit
 * `'week'` only) week start.
 */
function prepare(
  unit: BucketUnit,
  tz: string,
  weekStart: WeekStart,
  dayOf: DayResolver,
): (t: number) => CalendarBucketLabel {
  const span = monthSpan(unit)
  const ws = weekStartOf(unit, weekStart)
  if (tz === 'UTC') return (t) => formatDays(truncate(Math.floor(t / DAY), span, ws))
  const zone = getZone(tz)
  return (t) => formatDays(truncate(dayOf(zone, t), span, ws))
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
  const label = prepare(unit, tz, weekStart, localDays)
  return (ms) => {
    const t = toInstant(ms)
    return t === null ? null : label(t)
  }
}

// bucketLabel reuses the labeler prepared for its previous call's arguments.
let last: { unit: BucketUnit; tz: string; weekStart: WeekStart; label: (t: number) => CalendarBucketLabel } | undefined

/**
 * Calendar-bucket label of an epoch-ms instant: the ISO local date `YYYY-MM-DD`
 * of the first day of the `unit` bucket containing `ms` in time zone `tz`.
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
    last = { unit, tz, weekStart, label: prepare(unit, tz, weekStart, localDays) }
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
  return t === null ? null : prepare(unit, tz, weekStart, wallDays)(t)
}

/**
 * The label of the bucket that follows the one containing `label` — a
 * time-zone-free calendar step, for filling gaps between returned labels.
 * `label` need not be a bucket start (`'2026-01-31'` + month → `'2026-02-01'`).
 * Throws `RangeError` for a malformed label.
 */
export function nextBucketLabel(
  label: CalendarBucketLabel,
  unit: BucketUnit,
  weekStart: WeekStart = 'mon',
): CalendarBucketLabel {
  const days = parseLabel(label)
  const span = monthSpan(unit)
  const ws = weekStartOf(unit, weekStart)
  return formatDays(nextBucketStart(truncate(days, span, ws), span, ws))
}

/**
 * First instant (epoch ms) of the local calendar date `label` in `tz`: the
 * smallest `t` whose local date is `label`. On a day whose midnight falls in a
 * DST gap (America/Santiago skips 00:00 on its spring-forward Sunday) this is
 * the transition instant, i.e. the first wall-clock moment that exists that day.
 * Throws `RangeError` for a malformed label or unknown zone.
 */
export function bucketStartInstant(label: CalendarBucketLabel, tz = 'UTC'): number {
  const days = parseLabel(label)
  const naive = days * DAY
  if (tz === 'UTC') return naive
  const zone = getZone(tz)
  // Candidates: local midnight under each offset in effect near that day.
  let best = Number.POSITIVE_INFINITY
  for (const probe of [naive - 14 * 3_600_000, naive, naive + 14 * 3_600_000]) {
    const t = naive - offsetAt(zone, probe)
    if (wallDays(zone, t) === days && wSecOfDay === 0 && t < best) best = t
  }
  if (best !== Number.POSITIVE_INFINITY) return best
  // Midnight does not exist: binary-search the first instant whose local date is `days`.
  // Offsets lie within [-12h, +14h], so lo is still the previous day and hi already this day.
  let lo = naive - 15 * 3_600_000
  let hi = naive + 13 * 3_600_000
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (wallDays(zone, mid) >= days) hi = mid
    else lo = mid
  }
  return hi
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
