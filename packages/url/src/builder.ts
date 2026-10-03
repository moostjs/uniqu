import type {
  AggregateExpr,
  BucketExpr,
  FilterExpr,
  FilterVisitor,
  Uniquery,
  UniqueryControls,
  WithRelation,
} from '@uniqu/core'
import { isBucketExpr, isPlainObject, resolveAlias, walkFilter } from '@uniqu/core'

/**
 * Build a URL query string from a Uniquery object.
 * Produces output compatible with `parseUrl` from `@uniqu/url`.
 *
 * @param query - The canonical query to serialize
 * @returns URL query string without leading "?"
 */
export function buildUrl(query: Uniquery): string {
  const filterStr = query.filter ? serializeFilter(query.filter) : ''
  const controlStr = query.controls ? serializeControls(query.controls) : ''
  if (filterStr && controlStr) return filterStr + '&' + controlStr
  return filterStr || controlStr
}

interface TUrlPart {
  s: string
  kind: 'leaf' | 'and' | 'or'
  /** Serialized to nothing yet matches no row (`{ $or: [] }`, `{ $not: {} }`). */
  never?: boolean
}

/**
 * Join the non-empty parts with `&` (and) or `^` (or). `&` binds tighter than
 * `^`, so an `or` child inside an `and` and a multi-part `and` child inside an
 * `or` are parenthesized. A single non-empty part is returned as is — its kind
 * is preserved so an enclosing node can still group it correctly.
 */
function joinParts(children: TUrlPart[], kind: 'and' | 'or'): TUrlPart {
  // An empty member is either "matches no row" (`never`) or "matches every row". One
  // absorbing member decides the whole node: a never-member in an AND, an every-member
  // in an OR — dropping it would widen (AND) or narrow (OR) the filter.
  if (kind === 'and' ? children.some((c) => c.never) : children.some((c) => !c.s && !c.never)) {
    return { s: '', kind: 'leaf', never: kind === 'and' }
  }
  const parts = children.filter((child) => child.s)
  if (parts.length === 0) {
    // AND of tautologies matches every row; OR of never-members (`{ $or: [] }`) matches none.
    return { s: '', kind: 'leaf', never: kind === 'or' }
  }
  if (parts.length === 1) return parts[0]
  const wrap = kind === 'and' ? 'or' : 'and'
  const separator = kind === 'and' ? '&' : '^'
  return {
    s: parts.map((child) => (child.kind === wrap ? `(${child.s})` : child.s)).join(separator),
    kind,
  }
}

/**
 * URL serializer as a `walkFilter` visitor. The walker owns the traversal
 * rules (every member of a node is an implicit AND, `undefined` logical keys
 * are skipped, a single-member node passes through unwrapped, one comparison
 * per operator), so the serializer only decides how to spell each node.
 */
const urlVisitor: FilterVisitor<TUrlPart> = {
  comparison(field, op, value) {
    // A RegExp under `$eq` (a bare `{ field: /re/ }` value) is emitted with
    // the regex operator, matching `{ field: { $regex } }`.
    const s =
      op === '$eq' && value instanceof RegExp
        ? `${field}~=${serializeValue(value)}`
        : serializeComparison(field, op, value)
    return { s, kind: 'leaf' }
  },
  and: (children) => joinParts(children, 'and'),
  or: (children) => joinParts(children, 'or'),
  not: (child) =>
    child.s ? { s: `!(${child.s})`, kind: 'leaf' } : { s: '', kind: 'leaf', never: !child.never },
  // `field=$some(<operand>)` — the operand is a filter on the related entity,
  // serialized recursively; values inside are percent-encoded like any other.
  relation(field, op, operand) {
    if (!isPlainObject(operand)) {
      throw new TypeError(`Relational predicate "${op}" on "${field}" needs a filter object operand`)
    }
    // A plain object always walks to a part (never `undefined`).
    const part = walkFilter(operand, urlVisitor)!
    // An empty body means "any related row" (`$some()` / `$none()`). An operand
    // that serializes to nothing but matches no row (`{ $or: [] }`,
    // `{ $not: {} }`) has no URL spelling — refuse rather than widen it.
    if (part.never) {
      throw new TypeError(
        `Relational predicate "${op}" on "${field}" has an operand that matches no row; it cannot be expressed in a URL`,
      )
    }
    return { s: `${field}=${op}(${part.s})`, kind: 'leaf' }
  },
}

/**
 * Serialize a filter expression. Every member of a node is an implicit AND,
 * in key insertion order — comparison fields and logical operators may be
 * mixed in the same object (Mongo semantics), e.g.
 * `{ id: 101, $or: [...] }` → `id=101&(…^…)`.
 */
function serializeFilter(expr: FilterExpr): string {
  const part = walkFilter(expr, urlVisitor)
  // An empty query string means "every row" — refuse rather than widen a filter that matches none.
  if (part?.never) {
    throw new TypeError('The filter matches no row; it cannot be expressed in a URL')
  }
  return part?.s ?? ''
}

function serializeComparison(field: string, op: string, value: unknown): string {
  switch (op) {
    case '$eq':
      return `${field}=${serializeValue(value)}`
    case '$ne':
      return `${field}!=${serializeValue(value)}`
    case '$gt':
      return `${field}>${serializeValue(value)}`
    case '$gte':
      return `${field}>=${serializeValue(value)}`
    case '$lt':
      return `${field}<${serializeValue(value)}`
    case '$lte':
      return `${field}<=${serializeValue(value)}`
    case '$regex':
      return `${field}~=${serializeValue(value)}`
    case '$in': {
      let list = ''
      for (const item of value as unknown[]) {
        const s = serializeValue(item)
        list = list ? list + ',' + s : s
      }
      return `${field}{${list}}`
    }
    case '$nin': {
      let list = ''
      for (const item of value as unknown[]) {
        const s = serializeValue(item)
        list = list ? list + ',' + s : s
      }
      return `${field}!{${list}}`
    }
    case '$exists':
      return value ? `$exists=${field}` : `$!exists=${field}`
    default:
      return `${field}${op}${serializeValue(value)}`
  }
}

// A value is emitted bare only when the lexer (tokens.ts) reads the whole
// string as one `word` token (`[A-Za-z0-9_.]+`) — an allowlist pinned to that
// token shape, so new operator/delimiter chars can never leak out unquoted.
// Everything else is single-quoted. Hyphenated words (`in-progress`) parse bare
// too, but stay quoted so the URL emitted for a value is stable.
const WORD_RE = /^[A-Za-z0-9_.]+$/u
// Mirrors the tokenizer's `number` rule (full-string match). Strings matching
// this would otherwise be lexed as numbers and lose their string identity on
// round-trip. Leading-zero forms like '007' are intentionally NOT matched —
// the tokenizer rejects them, so they parse cleanly as `word` tokens.
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u

// Chars percent-encoded in every emitted value (parseUrl decodes each segment once):
//   `%`         — a stray `%` makes parseUrl's `decodeURIComponent` throw; `%XX` would be decoded.
//   `&`         — the top-level segment separator: the value would be cut there.
//   `( )`       — the top-level split tracks paren depth, not quotes: an unbalanced paren
//                 swallows (or detaches) every following segment.
//   `#`         — the URL fragment delimiter: everything after it never reaches the server.
//   `\t \n \r`  — stripped from a URL by the WHATWG parser.
// Single pass, so the `%` introduced here is never re-encoded.
const VALUE_UNSAFE_RE = /[%&()#\t\n\r]/gu
// Control values are written bare (not inside a quoted literal), so `'` is
// encoded too: a quote-aware consumer of the query string would otherwise treat
// it as an opening quote and swallow every following control. Filter values
// don't need it — `'` is backslash-escaped inside their quoted literal.
const CONTROL_UNSAFE_RE = /[%&()#'\t\n\r]/gu

function percentEncode(str: string, unsafe: RegExp): string {
  return str.replace(unsafe, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

function quote(str: string): string {
  return `'${percentEncode(str.replace(/\\/g, '\\\\').replace(/'/g, "\\'"), VALUE_UNSAFE_RE)}'`
}

function serializeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') return String(value)
  if (value instanceof RegExp) return quote(value.toString())
  if (value instanceof Date) return quote(value.toISOString())
  const str = String(value)
  if (
    str === '' ||
    str === 'null' || str === 'true' || str === 'false' ||
    NUMBER_RE.test(str) ||
    !WORD_RE.test(str)
  ) {
    return quote(str)
  }
  return str
}

/**
 * `bucket(<field>,<unit>[,<tz>][,<weekStart>]):<alias>` — always with the alias
 * (`$as` or the default), so a round-trip keeps it. The zone follows the filter
 * value rule (`UTC` bare, `'Europe/Berlin'` quoted); an absent zone with a week
 * start leaves an empty slot.
 */
function serializeBucket(b: BucketExpr): string {
  let args = `${b.$field},${b.$bucket}`
  if (b.$tz !== undefined || b.$weekStart !== undefined) {
    args += ',' + (b.$tz === undefined ? '' : serializeValue(b.$tz))
    if (b.$weekStart !== undefined) args += ',' + b.$weekStart
  }
  return `bucket(${args}):${resolveAlias(b)}`
}

const KNOWN_CONTROL_KEYS = new Set(['$select', '$groupBy', '$having', '$sort', '$limit', '$skip', '$count', '$with'])

function serializeControls(controls: UniqueryControls): string {
  let result = ''

  if (controls.$select) {
    let seg = ''
    if (Array.isArray(controls.$select)) {
      for (const entry of controls.$select) {
        let s: string
        if (typeof entry === 'string') {
          s = entry
        } else if (isBucketExpr(entry)) {
          s = serializeBucket(entry)
        } else {
          const agg = entry as AggregateExpr
          s = agg.$as ? `${agg.$fn}(${agg.$field}):${agg.$as}` : `${agg.$fn}(${agg.$field})`
        }
        seg = seg ? seg + ',' + s : s
      }
    } else {
      for (const [field, val] of Object.entries(controls.$select)) {
        const s = val === 0 ? `-${field}` : field
        seg = seg ? seg + ',' + s : s
      }
    }
    if (seg) result = `$select=${seg}`
  }

  if (controls.$groupBy?.length) {
    let seg = ''
    for (const field of controls.$groupBy) {
      seg = seg ? seg + ',' + field : field
    }
    const part = `$groupBy=${seg}`
    result = result ? result + '&' + part : part
  }

  if (controls.$having) {
    const havingStr = serializeFilter(controls.$having)
    if (havingStr) {
      // A $having containing `&` must be grouped: without parens the parser
      // stops the $having value at the first `&` and reads the rest as filter.
      // This is deliberately a textual check, not a structural one, because
      // the parser boundary is textual too — `splitTopLevel` in parse-url.ts
      // splits on `&` outside parentheses. Values percent-encode `&` (see
      // `quote`), so any `&` left here is a structural AND.
      const needsParens = havingStr.includes('&')
      const part = needsParens
        ? `$having=(${havingStr})`
        : `$having=${havingStr}`
      result = result ? result + '&' + part : part
    }
  }

  if (controls.$sort) {
    let seg = ''
    for (const [field, dir] of Object.entries(controls.$sort)) {
      const s = dir === -1 ? `-${field}` : field
      seg = seg ? seg + ',' + s : s
    }
    if (seg) {
      const part = `$sort=${seg}`
      result = result ? result + '&' + part : part
    }
  }

  if (controls.$limit !== undefined) {
    const part = `$limit=${controls.$limit}`
    result = result ? result + '&' + part : part
  }

  if (controls.$skip !== undefined) {
    const part = `$skip=${controls.$skip}`
    result = result ? result + '&' + part : part
  }

  if (controls.$count) {
    result = result ? result + '&$count' : '$count'
  }

  if (controls.$with) {
    let seg = ''
    for (const entry of controls.$with) {
      let s: string
      if (typeof entry === 'string') {
        s = entry
      } else {
        const rel = entry as WithRelation
        const inner = buildUrl({ filter: rel.filter, controls: rel.controls })
        // A relation body is itself a query string embedded in this one, so
        // parseUrl decodes it once per nesting level (the `$with=…` segment,
        // then each segment of the body). Escaping the body's `%` keeps every
        // `%XX` the nested builder emitted intact through the outer decode.
        s = inner ? `${rel.name}(${inner.replace(/%/g, '%25')})` : rel.name
      }
      seg = seg ? seg + ',' + s : s
    }
    if (seg) {
      const part = `$with=${seg}`
      result = result ? result + '&' + part : part
    }
  }

  // Pass-through unknown $-prefixed controls ($search, $search:<index>, …).
  // Key and value are free-form strings, so both are percent-encoded; `$` and
  // `:` are never in the unsafe set, so the key structure is left intact.
  for (const [key, value] of Object.entries(controls)) {
    if (key.startsWith('$') && !KNOWN_CONTROL_KEYS.has(key)) {
      const k = percentEncode(key, CONTROL_UNSAFE_RE)
      const part =
        value !== undefined && value !== ''
          ? `${k}=${percentEncode(String(value), CONTROL_UNSAFE_RE)}`
          : k
      result = result ? result + '&' + part : part
    }
  }

  return result
}
