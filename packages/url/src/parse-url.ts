import type {
  AggregateExpr,
  FilterExpr,
  WithRelation,
  UniqueryControls,
  UniqueryInsights,
  InsightOp,
  Uniquery,
} from '@uniqu/core'
import { lex } from './tokens'
import { Parser } from './parser'

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
  const parts = splitTopLevel(raw, '&')

  const controlParts: string[] = []
  const exprParts: string[] = []

  for (const _p of parts) {
    const p = decodeURIComponent(_p)
    if (
      /^\$[A-Za-z0-9_!]+/.test(p) &&
      !p.startsWith('$exists=') &&
      !p.startsWith('$!exists=')
    )
      controlParts.push(p)
    else if (p.length) exprParts.push(p)
  }

  const { controls, controlInsights } = handleControls(controlParts)

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

  for (const [field, op] of controlInsights) {
    parser.captureInsight(field, op)
  }

  return {
    filter,
    controls,
    insights: parser.getInsights(),
  }
}

/** Split a string by `sep` at the top level (ignoring separators inside balanced parentheses). */
function splitTopLevel(str: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(') depth++
    else if (str[i] === ')') depth--
    else if (str[i] === sep && depth === 0) {
      parts.push(str.slice(start, i))
      start = i + 1
    }
  }

  parts.push(str.slice(start))
  return parts
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
  const sub = parseUrl(inner)
  const rel: WithRelation = {
    name,
    filter: sub.filter,
    controls: sub.controls,
  }
  if (sub.insights.size) rel.insights = sub.insights

  return rel
}

function handleControls(parts: string[]): {
  controls: UniqueryControls
  controlInsights: Array<[string, InsightOp]>
} {
  const controls = {} as UniqueryControls
  const controlInsights: Array<[string, InsightOp]> = []

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
          controlInsights.push([rel.name, '$with'])
          if (rel.insights) {
            for (const [field, ops] of rel.insights) {
              const prefixed = `${rel.name}.${field}`
              for (const op of ops) {
                controlInsights.push([prefixed, op])
              }
            }
          }
        }
        break
      }

      case '$select': {
        const items = value.split(',')
        // Quick scan: determine form (array vs object)
        let hasExclusion = false
        let hasAggregate = false
        for (const f of items) {
          if (!f) continue
          if (f.startsWith('-')) hasExclusion = true
          else if (/^\w+\(/.test(f)) hasAggregate = true
        }

        if (hasAggregate || !hasExclusion) {
          const arr: (string | AggregateExpr)[] = Array.isArray(controls.$select) ? controls.$select : []
          // Plain fields first, then aggregates (stable ordering)
          for (const f of items) {
            if (!f || /^\w+\(/.test(f)) continue
            arr.push(f)
            controlInsights.push([f, '$select'])
          }
          for (const f of items) {
            if (!f) continue
            const aggMatch = /^(\w+)\((\*|[\w.]+)\)(?::([\w.]+))?$/.exec(f)
            if (!aggMatch) continue
            const fn = aggMatch[1]
            const field = aggMatch[2]
            const alias = aggMatch[3] ?? (field === '*' ? `${fn}_star` : `${fn}_${field}`)
            arr.push({ $fn: fn, $field: field, $as: alias })
            controlInsights.push([field, fn])
          }
          controls.$select = arr
        } else {
          const obj: Record<string, 0 | 1> = (controls.$select as Record<string, 0 | 1>) ?? {}
          for (const f of items) {
            if (!f) continue
            if (f.startsWith('-')) {
              const name = f.slice(1)
              obj[name] = 0
              controlInsights.push([name, '$select'])
            } else {
              obj[f] = 1
              controlInsights.push([f, '$select'])
            }
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
          if (f.startsWith('-')) {
            const name = f.slice(1)
            controls.$sort![name] = -1
            controlInsights.push([name, '$order'])
          } else {
            controls.$sort![f] = 1
            controlInsights.push([f, '$order'])
          }
        }
        break
      }

      case '$groupBy': {
        if (!value) break
        controls.$groupBy ??= []
        for (const f of value.split(',')) {
          if (!f) continue
          controls.$groupBy!.push(f)
          controlInsights.push([f, '$groupBy'])
        }
        break
      }

      case '$having': {
        if (!value) break
        const { expr, parser: hp } = parseFilterExpr(value)
        if (controls.$having) {
          controls.$having = { $and: [controls.$having, expr] }
        } else {
          controls.$having = expr
        }
        for (const [field] of hp.getInsights()) {
          controlInsights.push([field, '$having'])
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

  return { controls, controlInsights }
}
