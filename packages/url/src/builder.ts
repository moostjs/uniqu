import type {
  AggregateExpr,
  FilterExpr,
  Uniquery,
  UniqueryControls,
  WithRelation,
} from '@uniqu/core'
import { isPrimitive } from '@uniqu/core'

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

function serializeFilter(expr: FilterExpr, parentOp?: '$and' | '$or'): string {
  if ('$and' in expr && expr.$and !== undefined) {
    let result = ''
    for (const child of expr.$and as FilterExpr[]) {
      const s = serializeFilter(child, '$and')
      if (s) result = result ? result + '&' + s : s
    }
    return result
  }

  if ('$or' in expr && expr.$or !== undefined) {
    let result = ''
    for (const child of expr.$or as FilterExpr[]) {
      const s = serializeFilter(child, '$or')
      if (s) result = result ? result + '^' + s : s
    }
    // `&` binds tighter than `^`, so an $or embedded in an $and must be grouped.
    return parentOp === '$and' && result ? `(${result})` : result
  }

  if ('$not' in expr && expr.$not !== undefined) {
    const inner = serializeFilter(expr.$not as FilterExpr)
    return inner ? `!(${inner})` : ''
  }

  // Comparison node
  let result = ''
  for (const [field, value] of Object.entries(expr as Record<string, unknown>)) {
    if (value instanceof RegExp) {
      const part = `${field}~=${serializeValue(value)}`
      result = result ? result + '&' + part : part
    } else if (isPrimitive(value)) {
      const part = `${field}=${serializeValue(value)}`
      result = result ? result + '&' + part : part
    } else {
      for (const [op, opValue] of Object.entries(value as Record<string, unknown>)) {
        const part = serializeComparison(field, op, opValue)
        result = result ? result + '&' + part : part
      }
    }
  }
  // Implicit-AND (>1 part joined by `&`) inside an $or needs grouping.
  return parentOp === '$or' && result.includes('&') ? `(${result})` : result
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
      const needsParens = '$and' in controls.$having
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
