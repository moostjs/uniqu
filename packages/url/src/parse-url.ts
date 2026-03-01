import type {
  FilterExpr,
  UniqueryControls,
  UniqueryInsights,
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
  const parts = raw.split('&')

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

  const { controls, selectInsights, orderInsights } =
    handleControls(controlParts)

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

  for (const f of selectInsights) {
    parser.captureInsight(f, '$select')
  }
  for (const f of orderInsights) {
    parser.captureInsight(f, '$order')
  }

  return {
    filter,
    controls,
    insights: parser.getInsights(),
  }
}

function handleControls(parts: string[]): {
  controls: UniqueryControls
  selectInsights: Set<string>
  orderInsights: Set<string>
} {
  const controls = {} as UniqueryControls
  const selectInsights = new Set<string>()
  const orderInsights = new Set<string>()

  for (const raw of parts) {
    const [key, ...rest] = raw.split('=')
    const value = decodeURIComponent(rest.join('='))

    switch (key) {
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
            selectInsights.add(name)
          }
          controls.$select = obj
        } else {
          const arr: string[] = Array.isArray(controls.$select) ? controls.$select : []
          for (const { name } of fields) {
            arr.push(name)
            selectInsights.add(name)
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
          orderInsights.add(f.replace(/^-/, ''))
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

  return { controls, selectInsights, orderInsights }
}
