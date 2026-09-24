import { TIME_ZONE_NAME_RE, computeInsights, resolveAlias } from '@uniqu/core'
import type {
  AggregateExpr,
  BucketExpr,
  BucketUnit,
  WeekStart,
  FilterExpr,
  WithRelation,
  UniqueryControls,
  UniqueryInsights,
  Uniquery,
} from '@uniqu/core'
import { lex } from './tokens'
import { Parser, unescapeString } from './parser'

/** Result of parsing a URL query string. Narrows optional fields to required (always produced by the parser). */
export interface UrlQuery extends Uniquery {
  filter: FilterExpr
  controls: UniqueryControls
  insights: UniqueryInsights
}

/**
 * Parse a URL query string into the uniqu canonical format.
 *
 * The string may contain:
 *   - logical connectors `&` (AND) and `^` (OR)
 *   - comparison operators (=, !=, >, >=, <, <=, ~=, in-list, nin-list, between)
 *   - grouping parentheses
 *   - control keywords that start with `$` (e.g. `$select`, `$limit`, `$order`)
 *
 * @param raw - Raw query string without the leading "?"
 */
export function parseUrl(raw: string): UrlQuery {
  return parseQuery(raw, false)
}

/**
 * `nested`: `raw` is a `$with` relation body, already decoded once with its
 * `$with=…` segment. A body segment that is not valid percent-encoding at this
 * second decode (e.g. a hand-written `name='50%25'`, now `name='50%'`) is kept
 * as is rather than rejected: such input used to throw, so no query that
 * parsed before changes.
 */
function parseQuery(raw: string, nested: boolean): UrlQuery {
  const parts = splitUrlSegments(raw)

  const controlParts: string[] = []
  const exprParts: string[] = []

  for (const _p of parts) {
    const p = nested ? decodeLenient(_p) : decodeURIComponent(_p)
    if (
      /^\$[A-Za-z0-9_!]+/.test(p) &&
      !p.startsWith('$exists=') &&
      !p.startsWith('$!exists=')
    )
      controlParts.push(p)
    else if (p.length) exprParts.push(p)
  }

  const controls = handleControls(controlParts)

  let filter: FilterExpr = {}
  let parser: Parser

  if (exprParts.length) {
    const rawExpr = exprParts.join('&')
    const parsed = parseFilterExpr(rawExpr)
    parser = parsed.parser
    filter = parsed.expr
  } else {
    parser = new Parser([])
  }

  // Control insights (with computed-column aliases resolved to their source fields) are core's.
  for (const [field, ops] of computeInsights(undefined, controls)) {
    for (const op of ops) parser.captureInsight(field, op)
  }

  return {
    filter,
    controls,
    insights: parser.getInsights(),
  }
}

function decodeLenient(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * Split a raw query string into its top-level `&` segments, exactly as
 * {@link parseUrl} does: an `&` inside a parenthesized group
 * (`(a=1&b=2)^c=3`) does not separate. Segments are returned raw (not
 * percent-decoded); empty ones (from a leading, trailing or doubled `&`) are
 * kept. Use it to address the individual keys of a URL the parser reads, e.g.
 * to replace a query's own segments while keeping foreign ones.
 */
export function splitUrlSegments(raw: string): string[] {
  return splitTopLevel(raw, '&')
}

/**
 * Split a string by `sep` at the top level (ignoring separators inside balanced
 * parentheses and, with `quoteAware`, inside single-quoted strings).
 */
function splitTopLevel(str: string, sep: string, quoteAware = false): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < str.length; i++) {
    if (quoteAware && str[i] === "'") i = closingQuote(str, i)
    else if (str[i] === '(') depth++
    else if (str[i] === ')') depth--
    else if (str[i] === sep && depth === 0) {
      parts.push(str.slice(start, i))
      start = i + 1
    }
  }

  parts.push(str.slice(start))
  return parts
}

/** Index of the `'` closing the quoted string opened at `open` (`\\` escapes), or `str.length`. */
function closingQuote(str: string, open: number): number {
  for (let i = open + 1; i < str.length; i++) {
    if (str[i] === '\\') i++
    else if (str[i] === "'") return i
  }
  return str.length
}

function fail(item: string, why: string): never {
  throw new SyntaxError(`Malformed bucket "${item}": ${why}`)
}

/**
 * Parse a calendar-bucket `$select` item:
 *
 *   bucket(field,unit[,[tz][,weekStart]])[:alias]
 *
 * `tz` is single-quoted or bare (core's `TIME_ZONE_NAME_RE`); an empty tz slot
 * (`bucket(f,week,,sun)`) means the default zone. The parse is syntactic only:
 * unit, zone and week start are passed through for `@uniqu/core` to validate.
 * Malformed syntax throws.
 *
 * `bucket` is a reserved function name in `$select`: any `bucket(…)` item is
 * parsed here and never as an aggregate, so a one-argument `bucket(x)` is
 * malformed rather than a custom aggregate called `bucket`.
 */
function parseBucket(item: string): BucketExpr {
  const open = item.indexOf('(')
  let close = -1
  for (let i = open + 1; i < item.length; i++) {
    if (item[i] === "'") i = closingQuote(item, i)
    else if (item[i] === '(') fail(item, 'unexpected "("')
    else if (item[i] === ')') {
      close = i
      break
    }
  }
  if (close === -1) fail(item, 'missing ")"')
  const args = splitTopLevel(item.slice(open + 1, close), ',', true)
  if (args.length < 2) fail(item, 'expected bucket(field,unit[,tz][,weekStart])')
  if (args.length > 4) fail(item, 'too many arguments')
  const [field, unit, tz, weekStart] = args
  if (!/^[\w.]+$/u.test(field)) fail(item, 'missing or invalid field')
  if (!/^\w+$/u.test(unit)) fail(item, 'missing or invalid unit')
  const expr: BucketExpr = { $bucket: unit as BucketUnit, $field: field }
  if (tz) {
    if (tz[0] === "'" && closingQuote(tz, 0) === tz.length - 1) expr.$tz = unescapeString(tz)
    else if (TIME_ZONE_NAME_RE.test(tz)) expr.$tz = tz
    else fail(item, 'invalid time zone (quote it or use [A-Za-z0-9_+-/])')
  }
  if (weekStart !== undefined) {
    if (!/^\w+$/u.test(weekStart)) fail(item, 'missing or invalid week start')
    expr.$weekStart = weekStart as WeekStart
  }
  const rest = item.slice(close + 1)
  if (rest) {
    const alias = /^:([\w.]+)$/u.exec(rest)
    if (!alias) fail(item, 'invalid alias')
    expr.$as = alias[1]
  }
  expr.$as ??= resolveAlias(expr)
  return expr
}

/** Lex + parse a raw filter expression string. */
function parseFilterExpr(raw: string) {
  const tokens = lex(raw)
  const parser = new Parser(tokens)
  const expr = parser.parseExpression()
  parser.expectEof()
  return { expr, parser }
}

/** Parse a single `$with` segment like `posts` or `posts($sort=-createdAt&status=active)`. */
function parseWithSegment(seg: string): WithRelation | null {
  if (!seg) return null

  const parenIdx = seg.indexOf('(')
  if (parenIdx === -1) return { name: seg, filter: {}, controls: {} }

  const name = seg.slice(0, parenIdx)
  if (!name) return null

  // Strip surrounding parens
  const inner = seg.slice(parenIdx + 1, -1)
  if (!inner) return { name, filter: {}, controls: {} }

  // Recursively parse the sub-query inside parens
  const sub = parseQuery(inner, true)
  const rel: WithRelation = {
    name,
    filter: sub.filter,
    controls: sub.controls,
  }
  if (sub.insights.size) rel.insights = sub.insights

  return rel
}

function handleControls(parts: string[]): UniqueryControls {
  const controls = {} as UniqueryControls

  for (const raw of parts) {
    const eqIdx = raw.indexOf('=')
    const key = eqIdx === -1 ? raw : raw.slice(0, eqIdx)
    const value = eqIdx === -1 ? '' : raw.slice(eqIdx + 1)

    switch (key) {
      case '$with': {
        if (!value) break
        controls.$with ??= []
        const seen = new Set<string>()
        for (const r of controls.$with) seen.add(typeof r === 'string' ? r : r.name)
        for (const seg of splitTopLevel(value, ',')) {
          const rel = parseWithSegment(seg)
          if (!rel || seen.has(rel.name)) continue
          seen.add(rel.name)
          controls.$with.push(rel)
        }
        break
      }

      case '$select': {
        // Top-level, quote-aware split: a bucket's argument list and quoted zone stay whole
        const items = splitTopLevel(value, ',', true)
        // Quick scan: determine form (array vs object)
        let hasExclusion = false
        let hasComputed = false
        for (const f of items) {
          if (!f) continue
          if (f.startsWith('-')) hasExclusion = true
          else if (/^\w+\(/.test(f)) hasComputed = true
        }

        if (hasComputed || !hasExclusion) {
          const arr: (string | AggregateExpr | BucketExpr)[] = Array.isArray(controls.$select)
            ? controls.$select
            : []
          // Entries keep their order, so buildUrl → parseUrl round-trips
          for (const f of items) {
            if (!f) continue
            if (f.startsWith('bucket(')) {
              arr.push(parseBucket(f))
              continue
            }
            if (!/^\w+\(/.test(f)) {
              arr.push(f)
              continue
            }
            const aggMatch = /^(\w+)\((\*|[\w.]+)\)(?::([\w.]+))?$/.exec(f)
            if (!aggMatch) continue
            const fn = aggMatch[1]
            const field = aggMatch[2]
            arr.push({ $fn: fn, $field: field, $as: aggMatch[3] ?? resolveAlias({ $fn: fn, $field: field }) })
          }
          controls.$select = arr
        } else {
          const obj: Record<string, 0 | 1> = (controls.$select as Record<string, 0 | 1>) ?? {}
          for (const f of items) {
            if (!f) continue
            if (f.startsWith('-')) obj[f.slice(1)] = 0
            else obj[f] = 1
          }
          controls.$select = obj
        }
        break
      }

      case '$sort':
      case '$order': {
        controls.$sort ??= {}
        for (const f of value.split(',')) {
          if (!f) continue
          if (f.startsWith('-')) controls.$sort![f.slice(1)] = -1
          else controls.$sort![f] = 1
        }
        break
      }

      case '$groupBy': {
        if (!value) break
        controls.$groupBy ??= []
        for (const f of value.split(',')) {
          if (!f) continue
          controls.$groupBy!.push(f)
        }
        break
      }

      case '$having': {
        if (!value) break
        const { expr } = parseFilterExpr(value)
        if (controls.$having) {
          controls.$having = { $and: [controls.$having, expr] }
        } else {
          controls.$having = expr
        }
        break
      }

      case '$limit':
      case '$top':
        controls.$limit = Number(value)
        break

      case '$skip':
        controls.$skip = Number(value)
        break

      case '$count':
        controls.$count = true
        break

      default:
        ;(controls as Record<string, unknown>)[key] = value
    }
  }

  return controls
}
