import { computedAliases, isAggregateExpr, isAggregateOfExpr, isBucketExpr, isSelectArithExpr } from './aggregate'
import { arithNames } from './arith'
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
  // An expression alias has no single source field, so it is not reported at all.
  const exprAliases = new Set<string>()
  if (controls?.$select) {
    if (Array.isArray(controls.$select)) {
      for (const entry of controls.$select) {
        if (typeof entry === 'string') {
          capture(entry, '$select')
        } else if (isBucketExpr(entry)) {
          capture(entry.$field, '$bucket')
        } else if (isAggregateExpr(entry)) {
          capture(entry.$field, entry.$fn)
        } else if (isAggregateOfExpr(entry) || isSelectArithExpr(entry)) {
          exprAliases.add(entry.$as)
          // Each operand is read by a row-level aggregate. A group-level expression reads
          // aliases / $groupBy fields only, reported where they are defined.
          if (isAggregateOfExpr(entry)) for (const name of arithNames(entry.$expr)) capture(name, entry.$fn)
        }
      }
    } else {
      for (const field of Object.keys(controls.$select)) {
        capture(field, '$select')
      }
    }
  }
  /** Report `name` against the real field behind it (a computed alias resolves to its source field). */
  const captureSource = (name: string, op: InsightOp) => {
    if (!exprAliases.has(name)) capture(aliasToField.get(name) ?? name, op)
  }
  if (controls?.$groupBy) {
    for (const field of controls.$groupBy) {
      if (typeof field === 'string') captureSource(field, '$groupBy')
    }
  }
  if (controls?.$having) {
    const havingVisitor: FilterVisitor<void> = {
      comparison(field) { captureSource(field, '$having') },
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
      captureSource(field, '$order')
    }
  }
  // Rows are ordered by these fields inside each group (first() / last()). Reported as
  // '$order' so the sortability gates consumers already apply to `$sort` cover them by default.
  const rowOrder = controls?.$rowOrder
  if (rowOrder) {
    for (const field of Object.keys(rowOrder)) capture(field, '$order')
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
