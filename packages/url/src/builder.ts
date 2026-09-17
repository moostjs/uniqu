import type {
  AggregateExpr,
  FilterExpr,
  FilterVisitor,
  Uniquery,
  UniqueryControls,
  WithRelation,
} from '@uniqu/core'
import { walkFilter } from '@uniqu/core'

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
}

/**
 * Join the non-empty parts with `&` (and) or `^` (or). `&` binds tighter than
 * `^`, so an `or` child inside an `and` and a multi-part `and` child inside an
 * `or` are parenthesized. A single non-empty part is returned as is — its kind
 * is preserved so an enclosing node can still group it correctly.
 */
function joinParts(children: TUrlPart[], kind: 'and' | 'or'): TUrlPart {
  const parts = children.filter((child) => child.s)
  if (parts.length === 0) return { s: '', kind: 'leaf' }
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
  not: (child) => ({ s: child.s ? `!(${child.s})` : '', kind: 'leaf' }),
}

/**
 * Serialize a filter expression. Every member of a node is an implicit AND,
 * in key insertion order — comparison fields and logical operators may be
 * mixed in the same object (Mongo semantics), e.g.
 * `{ id: 101, $or: [...] }` → `id=101&(…^…)`.
 */
function serializeFilter(expr: FilterExpr): string {
  return walkFilter(expr, urlVisitor)?.s ?? ''
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

// A bare value in `field=<value>` position is round-trip-safe only when the
// lexer in tokens.ts would consume the entire string as a single `word` token
// (`[A-Za-z0-9_.]+`). Anything else must be single-quoted so it tokenizes as
// a `string` literal. Pinning this allowlist to the tokenizer's `word` shape
// keeps the encoder in sync if new operator/delimiter chars are added later —
// the previous denylist drifted silently every time tokens.ts grew.
const WORD_RE = /^[A-Za-z0-9_.]+$/u
// Mirrors the tokenizer's `number` rule (full-string match). Strings matching
// this would otherwise be lexed as numbers and lose their string identity on
// round-trip. Leading-zero forms like '007' are intentionally NOT matched —
// the tokenizer rejects them, so they parse cleanly as `word` tokens.
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u

function quote(str: string): string {
  // parseUrl runs `decodeURIComponent` on each top-level segment before lexing,
  // so any `%XX` we emit here is decoded back to its literal char before the
  // lexer ever sees it. We percent-encode exactly the chars a real URL (WHATWG
  // `new URL` / `fetch` / the address bar) would otherwise mangle *in transit*,
  // before parseUrl runs at all:
  //   `%`         — a stray `%` not followed by two hex digits makes the
  //                 `decodeURIComponent` in parseUrl throw; must go first so the
  //                 `%` we introduce below (`%23` etc.) isn't itself re-encoded.
  //   `#`         — the fragment delimiter: the browser/URL parser cuts the query
  //                 string here, so everything after `#` never reaches the server.
  //   `\t \n \r`  — ASCII tab/newline are stripped from the input entirely by the
  //                 URL parser, silently corrupting the value.
  // Other URL-syntactic chars (`&`, `?`, `+`) survive the query string untouched,
  // and the ones the URL parser percent-encodes (space, `"`, `<`, `>`, …) are
  // decoded back by parseUrl's `decodeURIComponent`, so none need encoding here.
  return `'${str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/\t/g, '%09')
    .replace(/\n/g, '%0A')
    .replace(/\r/g, '%0D')}'`
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
      // splits on `&` outside parentheses and ignores quotes, so a quoted
      // value such as `name='a&b'` needs the wrap as much as an AND does.
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
        s = inner ? `${rel.name}(${inner})` : rel.name
      }
      seg = seg ? seg + ',' + s : s
    }
    if (seg) {
      const part = `$with=${seg}`
      result = result ? result + '&' + part : part
    }
  }

  // Pass-through unknown $-prefixed controls
  for (const [key, value] of Object.entries(controls)) {
    if (key.startsWith('$') && !KNOWN_CONTROL_KEYS.has(key)) {
      const part = value !== undefined && value !== '' ? `${key}=${value}` : key
      result = result ? result + '&' + part : part
    }
  }

  return result
}
