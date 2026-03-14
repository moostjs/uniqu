import type {
  AggregateExpr,
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
      for (const entry of controls.$select) {
        if (typeof entry === 'string') {
          capture(entry, '$select')
        } else {
          capture((entry as AggregateExpr).$field, (entry as AggregateExpr).$fn)
        }
      }
    } else {
      for (const field of Object.keys(controls.$select)) {
        capture(field, '$select')
      }
    }
  }
  if (controls?.$groupBy) {
    for (const field of controls.$groupBy) {
      capture(field, '$groupBy')
    }
  }
  if (controls?.$having) {
    const havingVisitor: FilterVisitor<void> = {
      comparison(field) { capture(field, '$having') },
      and() {},
      or() {},
      not() {},
    }
    walkFilter(controls.$having, havingVisitor)
  }
  if (controls?.$sort) {
    for (const field of Object.keys(controls.$sort)) {
      capture(field, '$order')
    }
  }
  if (controls?.$with) {
    for (const entry of controls.$with) {
      if (typeof entry === 'string') {
        capture(entry, '$with')
        continue
      }
      capture(entry.name, '$with')
      const nested = entry.insights ?? computeInsights(entry.filter, entry.controls)
      if (nested.size) entry.insights = nested
      for (const [field, ops] of nested) {
        const prefixed = `${entry.name}.${field}`
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
