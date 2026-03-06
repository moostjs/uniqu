import type {
  FilterExpr,
  UniqueryControls,
  UniqueryInsights,
  InsightOp,
  Uniquery,
} from './types'
import { walkFilter, type FilterVisitor } from './walk'

/**
 * Compute insights (field → operators map) from an already-built query.
 * This is the lazy counterpart to the eager insight capture done during
 * URL parsing.
 */
export function computeInsights(
  filter?: FilterExpr,
  controls?: UniqueryControls,
): UniqueryInsights {
  const insights: UniqueryInsights = new Map()

  function capture(field: string, op: InsightOp) {
    let set = insights.get(field)
    if (!set) {
      set = new Set()
      insights.set(field, set)
    }
    set.add(op)
  }

  const visitor: FilterVisitor<void> = {
    comparison(field, op) {
      capture(field, op)
    },
    and() {},
    or() {},
    not() {},
  }
  if (filter) walkFilter(filter, visitor)

  if (controls?.$select) {
    if (Array.isArray(controls.$select)) {
      for (const field of controls.$select) {
        capture(field, '$select')
      }
    } else {
      for (const field of Object.keys(controls.$select)) {
        capture(field, '$select')
      }
    }
  }
  if (controls?.$sort) {
    for (const field of Object.keys(controls.$sort)) {
      capture(field, '$order')
    }
  }
  if (controls?.$with) {
    for (const rel of controls.$with) {
      capture(rel.name, '$with')
      const nested = rel.insights ?? computeInsights(rel.filter, rel.controls)
      if (nested.size) rel.insights = nested
      for (const [field, ops] of nested) {
        const prefixed = `${rel.name}.${field}`
        for (const op of ops) {
          capture(prefixed, op)
        }
      }
    }
  }

  return insights
}

/**
 * Return insights for a query — uses pre-computed insights when present,
 * computes lazily otherwise.
 */
export function getInsights(query: Uniquery): UniqueryInsights {
  return query.insights ?? computeInsights(query.filter ?? {}, query.controls)
}
