import type {
  FilterExpr,
  WithRelation,
  UniqueryControls,
  UniqueryInsights,
  InsightOp,
  Uniquery,
} from '@uniqu/core'
import { lex } from './tokens'
import { Parser } from './parser'

/** Result of parsing a URL query string. Narrows `Uniquery.insights` from optional to required (eagerly computed during parsing). */
export interface UrlQuery extends Uniquery {
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
    const tokens = lex(rawExpr)
    parser = new Parser(tokens)
    filter = parser.parseExpression()
    parser.expectEof()
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
    const [key, ...rest] = raw.split('=')
    const value = rest.join('=')

    switch (key) {
      case '$with': {
        if (!value) break
        controls.$with ??= []
        const seen = new Set(controls.$with.map((r) => r.name))
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
        let hasExclusion = false
        const fields: Array<{ name: string; include: boolean }> = []
        value.split(',').forEach((f) => {
          if (!f) return
          if (f.startsWith('-')) {
            hasExclusion = true
            fields.push({ name: f.slice(1), include: false })
          } else {
            fields.push({ name: f, include: true })
          }
        })

        if (hasExclusion) {
          const obj: Record<string, 0 | 1> = (controls.$select as Record<string, 0 | 1>) ?? {}
          for (const { name, include } of fields) {
            obj[name] = include ? 1 : 0
            controlInsights.push([name, '$select'])
          }
          controls.$select = obj
        } else {
          const arr: string[] = Array.isArray(controls.$select) ? controls.$select : []
          for (const { name } of fields) {
            arr.push(name)
            controlInsights.push([name, '$select'])
          }
          controls.$select = arr
        }
        break
      }

      case '$sort':
      case '$order': {
        controls.$sort ??= {}
        value.split(',').forEach((f) => {
          if (!f) return
          controlInsights.push([f.replace(/^-/, ''), '$order'])
          if (f.startsWith('-')) controls.$sort![f.slice(1)] = -1
          else controls.$sort![f] = 1
        })
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
