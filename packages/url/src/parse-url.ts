import {
  EXPR_AGGREGATE_FNS,
  NESTED_STAGE_CONTROLS,
  TIME_ZONE_NAME_RE,
  computeInsights,
  isNullsPlacement,
  parseArith,
  resolveAlias,
} from '@uniqu/core'
import type {
  AggregateExpr,
  AggregateOfExpr,
  BucketExpr,
  BucketUnit,
  WeekStart,
  FilterExpr,
  NullsPlacement,
  SelectArithExpr,
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
    if (isControlPart(p)) controlParts.push(p)
    else if (p.length) exprParts.push(p)
  }

  const controls = handleControls(controlParts, nested)

  const filter: FilterExpr = exprParts.length ? parseFilterExpr(exprParts.join('&')) : {}

  return {
    filter,
    controls,
    insights: computeInsights(filter, controls),
  }
}

/** Whether a decoded segment is a control (`$select=…`) rather than a filter term (`$exists=…` is a filter term). */
function isControlPart(p: string): boolean {
  return /^\$[A-Za-z0-9_!]+/.test(p) && !p.startsWith('$exists=') && !p.startsWith('$!exists=')
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
 * (`(a=1&b=2)^c=3`) does not separate, and neither does an `&`, `(` or `)`
 * inside a quoted value (`name=')'&x=1`, `count(*|n='(a&b'):c`). A `'` opens a
 * quoted value only at the start of a token — the string start, or after `=`,
 * an operator, `(`, `,`, `|`, `^`, `&`, `{`, a space, tab or `+`, or after
 * the percent-encoded form of one — and only when it is closed, so an apostrophe inside a word (`$search=it's`) is an ordinary
 * character. Segments are returned raw (not percent-decoded); empty ones (from
 * a leading, trailing or doubled `&`) are kept. Use it to address the
 * individual keys of a URL the parser reads, e.g. to replace a query's own
 * segments while keeping foreign ones.
 */
export function splitUrlSegments(raw: string): string[] {
  return splitTopLevel(raw, '&')
}

/** Characters after which a `'` starts a quoted value (a token start, as the lexer sees it). */
const QUOTE_OPENERS = new Set(['=', '<', '>', '~', '!', '(', ',', '|', '^', '&', '{', ' ', '\t', '+'])
/**
 * The same characters percent-encoded (`%3D'x'` from `encodeURIComponent`, which leaves `'` raw).
 * Not listed: `+` (`%2B`) and tab (`%09`).
 */
const ENCODED_OPENER_RE = /^%(?:3D|3C|3E|7E|21|28|2C|7C|5E|26|7B|20)$/iu

/** Whether `str[i]` starts a token: the string start, or after a raw or percent-encoded opener. */
function atTokenStart(str: string, i: number): boolean {
  return (
    i === 0 ||
    QUOTE_OPENERS.has(str[i - 1]!) ||
    (str.charCodeAt(i - 3) === 37 /* % */ && ENCODED_OPENER_RE.test(str.slice(i - 3, i)))
  )
}

/**
 * The one quote scanner of the URL splitters, for one `str`. Called at a `'`, `skipQuote(i)`
 * returns the index of the `'` closing the quoted value that opens at `i`, or `i` itself when
 * the quote opens none (not at a token start, or never closed). Once a quote never closes no
 * later one can (the failed scan passed over each as escaped), so later scans are skipped: a
 * run of quotes stays linear.
 */
function quoteScanner(str: string): (i: number) => number {
  let unclosed = false
  return (i) => {
    if (unclosed || !atTokenStart(str, i)) return i
    const close = closingQuote(str, i)
    if (close < str.length) return close
    unclosed = true
    return i
  }
}

/**
 * Split a string by `sep` at the top level, ignoring separators inside balanced
 * parentheses and inside quoted values (see {@link splitUrlSegments}).
 */
function splitTopLevel(str: string, sep: string): string[] {
  const parts: string[] = []
  const skipQuote = quoteScanner(str)
  let depth = 0
  let start = 0

  for (let i = 0; i < str.length; i++) {
    // A skipped quoted value ends on its closing `'`, which matches none of the branches below.
    if (str[i] === "'") i = skipQuote(i)
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

const ALIAS_SRC = '[\\w.]+'
/** `:alias` — the whole text after a `$select` call. */
const ALIAS_RE = new RegExp(`^:(${ALIAS_SRC})$`, 'u')
/** `*`, `field` or `a,b,…` — the argument of a plain aggregate item (`fn(field)[:alias]`). */
const FIELD_LIST_RE = /^(?:\*|[\w.]+)(?:,(?:\*|[\w.]+))*$/u

/** The `alias` of `:alias`, or `undefined` when `rest` is not exactly that. */
function parseAlias(rest: string): string | undefined {
  return ALIAS_RE.exec(rest)?.[1]
}

/** `findCloseParen` results besides an index. */
const UNBALANCED = -1
const NESTED_PAREN = -2

/**
 * Index of the `)` closing the `(` at `open`, skipping quoted values (see {@link splitUrlSegments}).
 * With `nested` an inner `(…)` is balanced (`coalesce(a,0)`); without it an inner
 * `(` gives {@link NESTED_PAREN}. {@link UNBALANCED} when never closed.
 */
function findCloseParen(str: string, open: number, nested: boolean): number {
  const skipQuote = quoteScanner(str)
  let depth = 0
  for (let i = open; i < str.length; i++) {
    if (str[i] === "'") i = skipQuote(i)
    else if (str[i] === '(') {
      if (!nested && depth > 0) return NESTED_PAREN
      depth++
    } else if (str[i] === ')' && --depth === 0) return i
  }
  return UNBALANCED
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
  const close = findCloseParen(item, open, false)
  if (close > 0 && item.slice(open, close).includes('|')) {
    throw new SyntaxError(`Malformed $select item "${item}": a condition applies to aggregates only`)
  }
  if (close === NESTED_PAREN) fail(item, 'unexpected "("')
  if (close === UNBALANCED) fail(item, 'missing ")"')
  const args = splitTopLevel(item.slice(open + 1, close), ',')
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
    expr.$as = parseAlias(rest)
    if (expr.$as === undefined) fail(item, 'invalid alias')
  }
  expr.$as ??= resolveAlias(expr)
  return expr
}

/** A `$select` call item split at its matching parens: `name(arg)rest`. */
interface SelectCall {
  name: string
  arg: string
  rest: string
}

/** Split `name(arg)rest` at the `)` matching the first `(`; `undefined` when unbalanced. */
function splitCall(item: string): SelectCall | undefined {
  const open = item.indexOf('(')
  const close = findCloseParen(item, open, true)
  if (close === UNBALANCED) return undefined
  return { name: item.slice(0, open), arg: item.slice(open + 1, close), rest: item.slice(close + 1) }
}

/**
 * Parse an arithmetic `$select` item:
 *
 *   expr(<arith>):alias          → `{ $expr, $as }`
 *   sum|avg|min|max(<arith>):alias → `{ $fn, $expr, $as }`
 *
 * The argument runs to the matching `)` (nested `coalesce(a,0)` stays whole); the
 * alias is required; any other function name is malformed. The argument is parsed by
 * core's `parseArith`; its rules (operators, limits, operand types) are validated
 * downstream. A raw `+` and a decoded `%2B` both read as plus. `expr` is a reserved
 * name, like `bucket`.
 */
function parseExprItem(item: string, call: SelectCall, where?: FilterExpr): SelectArithExpr | AggregateOfExpr {
  const fn = EXPR_AGGREGATE_FNS.find((f) => f === call.name)
  if (where && !fn) {
    throw new SyntaxError(
      `Malformed $select item "${item}": a condition applies to aggregates only — put it on the aggregates the expression reads`,
    )
  }
  if (call.name !== 'expr' && !fn) {
    throw new SyntaxError(
      `Malformed $select item "${item}": unknown function "${call.name}" — use ${EXPR_AGGREGATE_FNS.join('/')} or expr(<arith>)`,
    )
  }
  const alias = parseAlias(call.rest)
  if (alias === undefined) {
    throw new SyntaxError(`Malformed $select item "${item}": expected :alias after the expression`)
  }
  let expr
  try {
    expr = parseArith(call.arg)
  } catch (e) {
    throw new SyntaxError(`Malformed $select item "${item}": ${(e as Error).message}`)
  }
  if (!fn) return { $expr: expr, $as: alias }
  return where ? { $fn: fn, $expr: expr, $as: alias, $where: where } : { $fn: fn, $expr: expr, $as: alias }
}

/**
 * Parse a `$select` call item other than `bucket(…)`:
 *
 *   fn(field)[:alias]   fn(*)[:alias]   fn(a,b,…)[:alias]  → `{ $fn, $field, $as }`
 *   fn(<arith>):alias   expr(<arith>):alias                → {@link parseExprItem}
 *
 * A field list is `countDistinct`'s only (several fields → `$field: [a, b]`; one field stays a
 * string); `fn(*)` is passed through for core to validate. The default
 * alias is `{fn}_{field}`, the fields of a list joined with `_` (`countDistinct_a_b`).
 *
 * Conditional aggregate: the text after the first `|` inside the call is a filter, the
 * aggregate's `$where` (`count(*|status=open):openCount`, `sum(amount|status{a,b}&qty>1):s`,
 * `sum(price*qty|paid=true):revenue`). It is parsed like `$having` (`&`, `^`, `!(…)`,
 * groups, quoted values); the alias is required. A field list and an arithmetic argument
 * never contain `|`, so the first one always starts the condition.
 */
function parseCallItem(item: string, call: SelectCall | undefined): AggregateExpr | SelectArithExpr | AggregateOfExpr {
  if (!call) throw new SyntaxError(`Malformed $select item "${item}": missing ")"`)
  const bar = call.arg.indexOf('|')
  const head = bar === -1 ? call.arg : call.arg.slice(0, bar)
  const where = bar === -1 ? undefined : parseWhere(item, call.arg.slice(bar + 1))
  if (call.name === 'expr' || !FIELD_LIST_RE.test(head)) return parseExprItem(item, { ...call, arg: head }, where)
  let alias: string | undefined
  if (call.rest) {
    alias = parseAlias(call.rest)
    if (alias === undefined) throw new SyntaxError(`Malformed $select item "${item}": invalid alias`)
  } else if (where) {
    throw new SyntaxError(`Malformed $select item "${item}": a conditional aggregate needs an :alias`)
  }
  const fields = head.split(',')
  if (fields.length > 1 && call.name !== 'countDistinct') {
    throw new SyntaxError(`Malformed $select item "${item}": only countDistinct takes several fields`)
  }
  const field = fields.length === 1 ? fields[0] : fields
  const expr: AggregateExpr = { $fn: call.name, $field: field, $as: alias ?? resolveAlias({ $fn: call.name, $field: field }) }
  if (where) expr.$where = where
  return expr
}

/** The `$where` filter of a conditional `$select` item: the text after its `|`. */
function parseWhere(item: string, text: string): FilterExpr {
  if (!text) throw new SyntaxError(`Malformed $select item "${item}": empty condition after "|"`)
  try {
    return parseFilterExpr(text)
  } catch (e) {
    throw new SyntaxError(`Malformed $select item "${item}": condition: ${(e as Error).message}`)
  }
}

/** Lex + parse a raw filter expression string. */
function parseFilterExpr(raw: string) {
  const tokens = lex(raw)
  const parser = new Parser(tokens)
  const expr = parser.parseExpression()
  parser.expectEof()
  return expr
}

/**
 * Parse the body of `$from=( … )`, the inner level of a two-level aggregate:
 * `$groupBy`, `$select`, `$rowOrder` (with `:first` / `:last`) and `$having`, joined by `&`,
 * read like a `$with` body (each segment decoded once more). A filter term inside is
 * rejected — the query's filter applies to the rows the inner level groups — and so are
 * other controls and a second level.
 */
function parseFromBody(value: string): UniqueryControls {
  if (value[0] !== '(' || findCloseParen(value, 0, true) !== value.length - 1) {
    throw new SyntaxError('Malformed $from: expected $from=( $groupBy=…&$select=… )')
  }
  const parts: string[] = []
  for (const raw of splitUrlSegments(value.slice(1, -1))) {
    const p = decodeLenient(raw)
    if (!p) continue
    if (!isControlPart(p)) {
      throw new SyntaxError(
        `Filter terms are not allowed inside $from ("${p}") — put the filter on the query itself; it applies to the rows $from groups`,
      )
    }
    const eq = p.indexOf('=')
    const key = eq === -1 ? p : p.slice(0, eq)
    if (key === '$from') throw new SyntaxError('A $from cannot have its own $from — a query has two levels at most')
    // `$nulls` passes on to handleControls, which explains the `:first` / `:last` suffix.
    if (!NESTED_STAGE_CONTROLS.includes(key)) {
      throw new SyntaxError(`${key} is not allowed inside $from — use $groupBy, $select, $rowOrder, $having or $nulls`)
    }
    parts.push(p)
  }
  return handleControls(parts)
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

/** Record the `:first` / `:last` suffix of a `$sort` / `$order` / `$rowOrder` item in `$nulls`. */
function setNulls(controls: UniqueryControls, key: string, item: string, field: string, placement: string): void {
  if (!field) throw new SyntaxError(`Malformed ${key} item "${item}": missing field`)
  if (!isNullsPlacement(placement)) {
    throw new SyntaxError(`Malformed ${key} item "${item}": null placement must be "first" or "last"`)
  }
  const nulls: Partial<Record<string, NullsPlacement>> = (controls.$nulls ??= {})
  const prev = Object.hasOwn(nulls, field) ? nulls[field] : undefined
  if (prev !== undefined && prev !== placement) {
    throw new SyntaxError(`Conflicting null placement for "${field}": "${prev}" and "${placement}"`)
  }
  nulls[field] = placement
}

/** `nested`: the controls of a `$with` relation body, where `$from` is not valid. */
function handleControls(parts: string[], nested = false): UniqueryControls {
  const controls = {} as UniqueryControls

  for (const raw of parts) {
    const eqIdx = raw.indexOf('=')
    const key = eqIdx === -1 ? raw : raw.slice(0, eqIdx)
    const value = eqIdx === -1 ? '' : raw.slice(eqIdx + 1)

    switch (key) {
      case '$from': {
        if (nested) {
          throw new SyntaxError('$from is only valid at the top level of a query, not inside a $with relation')
        }
        if (controls.$from !== undefined) {
          throw new SyntaxError('Duplicate $from: a two-level aggregate has one inner level')
        }
        controls.$from = parseFromBody(value)
        break
      }

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
        const items = splitTopLevel(value, ',')
        // Quick scan: determine form (array vs object)
        let hasExclusion = false
        let hasComputed = false
        for (const f of items) {
          if (!f) continue
          if (f.startsWith('-')) hasExclusion = true
          else if (/^\w+\(/.test(f)) hasComputed = true
        }

        if (hasComputed || !hasExclusion) {
          const arr: (string | AggregateExpr | BucketExpr | AggregateOfExpr | SelectArithExpr)[] = Array.isArray(controls.$select)
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
            arr.push(parseCallItem(f, splitCall(f)))
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

      case '$rowOrder':
      case '$sort':
      case '$order': {
        const orderKey = key === '$rowOrder' ? '$rowOrder' : '$sort'
        const order: Partial<Record<string, 1 | -1>> = (controls[orderKey] ??= {})
        const hasNulls = value.includes(':')
        for (const item of value.split(',')) {
          if (!item) continue
          // `[-]field[:first|:last]` — the null placement follows the last `:`.
          const colon = hasNulls ? item.lastIndexOf(':') : -1
          const f = colon === -1 ? item : item.slice(0, colon)
          const desc = f.charCodeAt(0) === 45 /* - */
          const field = desc ? f.slice(1) : f
          order[field] = desc ? -1 : 1
          if (colon !== -1) setNulls(controls, key, item, field, item.slice(colon + 1))
        }
        break
      }

      case '$nulls':
        throw new SyntaxError(
          '$nulls is not a URL control: write the null placement as a suffix on the order key ($sort=-amount:last)',
        )

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
        const expr = parseFilterExpr(value)
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
