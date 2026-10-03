import { computedAliases, isAggregateExpr, isBucketExpr } from './aggregate'
import type {
  FilterExpr,
  UniqueryControls,
  UniqueryInsights,
  InsightOp,
  Uniquery,
} from './types'
import { isPlainObject, walkFilter, type FilterVisitor } from './walk'

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

  /** Report a related entity's insights under the `prefix.` field path. */
  function capturePrefixed(prefix: string, nested: UniqueryInsights) {
    for (const [field, ops] of nested) {
      const prefixed = `${prefix}.${field}`
      for (const op of ops) capture(prefixed, op)
    }
  }

  const visitor: FilterVisitor<void> = {
    comparison(field, op) {
      capture(field, op)
    },
    and() {},
    or() {},
    not() {},
    relation(field, op, operand) {
      // The operand filters the related entity: its fields are reported with
      // the nav-field prefix, the same way `$with` sub-query insights are.
      capture(field, op)
      // A malformed operand (array, string, null, a resolved adapter node, …)
      // has no field paths to report; consumers reject it on their own.
      if (isPlainObject(operand)) capturePrefixed(field, computeInsights(operand))
    },
  }
  if (filter) walkFilter(filter, visitor)

  // Computed-column alias → source field, so alias references in
  // $groupBy / $having / $sort are reported against the real field.
  const aliasToField = computedAliases(controls?.$select)
  if (controls?.$select) {
    if (Array.isArray(controls.$select)) {
      for (const entry of controls.$select) {
        if (typeof entry === 'string') {
          capture(entry, '$select')
        } else if (isBucketExpr(entry)) {
          capture(entry.$field, '$bucket')
        } else if (isAggregateExpr(entry)) {
          capture(entry.$field, entry.$fn)
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
      if (typeof field === 'string') capture(aliasToField.get(field) ?? field, '$groupBy')
    }
  }
  if (controls?.$having) {
    const havingVisitor: FilterVisitor<void> = {
      comparison(field) { capture(aliasToField.get(field) ?? field, '$having') },
      // Relational predicates are not valid in `$having`; report the key so
      // consumers reject it as an unknown/invalid `$having` field.
      relation(field) { capture(field, '$having') },
      and() {},
      or() {},
      not() {},
    }
    walkFilter(controls.$having, havingVisitor)
  }
  if (controls?.$sort) {
    for (const field of Object.keys(controls.$sort)) {
      capture(aliasToField.get(field) ?? field, '$order')
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
      capturePrefixed(entry.name, nested)
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
