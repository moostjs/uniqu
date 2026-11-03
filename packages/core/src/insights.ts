import {
  aggregateFields,
  computedAliases,
  isAggregateExpr,
  isAggregateOfExpr,
  isBucketExpr,
  isComputedExpr,
  isSelectArithExpr,
  resolveAlias,
} from './aggregate'
import { arithNames } from './arith'
import type {
  ComparisonOp,
  FilterExpr,
  RelationOp,
  UniqueryControls,
  UniqueryInsights,
  InsightOp,
  Uniquery,
} from './types'
import { filterShapeProblem, isPlainObject, walkFilter, type FilterVisitor } from './walk'

type Capture = (field: string, op: InsightOp) => void

/**
 * Compute insights (field → operators map) from an already-built query.
 * This is the lazy counterpart to the eager insight capture done during
 * URL parsing.
 *
 * - The fields of an aggregate's `$where` condition are reported exactly like
 *   `filter` fields (comparison operators, relational predicates), so a gate on
 *   filterable fields covers conditional aggregates too.
 * - Two-level aggregate (`controls.$from` at the top level): the inner level is
 *   reported like any grouped query. The root controls are reported too, except
 *   the names that are inner or outer computed aliases (they are not table
 *   fields), so a consumer that runs the root controls against the table is
 *   still covered.
 * - Fail closed: a control insights cannot read (a `$where` that is not a filter
 *   object, a filter whose walk fails, a `$select` entry of no known kind, a
 *   `$groupBy` / `$sort` / `$with` of the wrong type), and a `$from` anywhere but the
 *   top level, are reported under the
 *   control's own name with itself as the operator (`'$where' => { '$where' }`).
 *   A name starting with `$` is never a field, so a field gate rejects the query.
 *   Insights never throw on a malformed query.
 */
export function computeInsights(
  filter?: FilterExpr,
  controls?: UniqueryControls,
): UniqueryInsights {
  return collect(filter, controls, true)
}

/** {@link computeInsights}; `top` is false for `$with` relations and relational operands. */
function collect(filter: unknown, controls: UniqueryControls | undefined, top: boolean): UniqueryInsights {
  const insights: UniqueryInsights = new Map()

  const capture: Capture = (field, op) => {
    let set = insights.get(field)
    if (!set) {
      set = new Set()
      insights.set(field, set)
    }
    set.add(op)
  }
  /** Report the control `name` as unreadable (fail closed). */
  const unreadable = (name: string) => capture(name, name)

  /** A visitor reporting filter fields through `cap`. */
  const filterVisitor = (cap: Capture): FilterVisitor<void> =>
    leafVisitor(cap, (field, op, operand) => {
      // The operand filters the related entity: its fields are reported with
      // the nav-field prefix, the same way `$with` sub-query insights are.
      cap(field, op)
      // A malformed operand (array, string, null, a resolved adapter node, …)
      // has no field paths to report; consumers reject it on their own.
      if (isPlainObject(operand)) prefixed(field, collect(operand, undefined, false), cap)
    })
  /** Walk a filter-shaped value; one that is not an object, or whose walk fails, is reported as `marker`. */
  const walkSafe = (expr: unknown, visitor: FilterVisitor<void>, marker: string) => {
    if (!isPlainObject(expr)) {
      unreadable(marker)
      return
    }
    try {
      walkFilter(expr as FilterExpr, visitor)
    } catch {
      unreadable(marker)
    }
  }

  if (filter !== undefined && filter !== null) walkSafe(filter, filterVisitor(capture), '$filter')

  /** Report the controls of one level through `cap`. */
  const reportControls = (controls: UniqueryControls, cap: Capture) => {
    const visitor = filterVisitor(cap)
    // Computed-column alias → source field, so alias references in
    // $groupBy / $having / $sort are reported against the real field.
    const aliasToField = computedAliases(controls.$select)
    // An expression alias has no single source field, so it is not reported at all.
    const exprAliases = new Set<unknown>()
    const select: unknown = controls.$select
    if (Array.isArray(select)) {
      for (const entry of select) {
        if (isPlainObject(entry) && '$field' in entry && '$expr' in entry) {
          // Ambiguous: which of the two an engine reads is unknown.
          unreadable('$select')
        } else if (typeof entry === 'string') {
          cap(entry, '$select')
        } else if (isBucketExpr(entry)) {
          cap(entry.$field, '$bucket')
        } else if (isAggregateExpr(entry) || isAggregateOfExpr(entry)) {
          if (isAggregateExpr(entry)) {
            for (const field of aggregateFields(entry.$field)) cap(field, entry.$fn)
          } else {
            // An expression alias has no single source field. Each operand is read by the row-level aggregate.
            exprAliases.add(entry.$as)
            for (const name of arithNames(entry.$expr)) cap(name, entry.$fn)
          }
          // An aggregate's condition reads the table like the filter does. A malformed one (validation
          // rejects it) would walk to no field or a fake one, so it is reported as the $where marker.
          if (entry.$where !== undefined) {
            if (filterShapeProblem(entry.$where)) unreadable('$where')
            else walkSafe(entry.$where, visitor, '$where')
          }
        } else if (isSelectArithExpr(entry)) {
          // A group-level expression reads aliases / $groupBy fields only, reported where they are defined.
          exprAliases.add(entry.$as)
        } else {
          // An entry of no known kind (a field list with a non-string, …) cannot be read.
          unreadable('$select')
        }
      }
    } else if (isPlainObject(select)) {
      for (const field of Object.keys(select)) cap(field, '$select')
    } else if (select !== undefined) {
      unreadable('$select')
    }
    /** Report `name` against the real field behind it (a computed alias resolves to its source field). */
    const captureSource = (name: string, op: InsightOp) => {
      if (!exprAliases.has(name)) for (const field of aggregateFields(aliasToField.get(name) ?? name)) cap(field, op)
    }
    const groupBy: unknown = controls.$groupBy
    if (Array.isArray(groupBy)) {
      for (const field of groupBy) if (typeof field === 'string') captureSource(field, '$groupBy')
    } else if (typeof groupBy === 'string') {
      captureSource(groupBy, '$groupBy')
    } else if (groupBy !== undefined) {
      unreadable('$groupBy')
    }
    if (controls.$having !== undefined) {
      const havingVisitor = leafVisitor(
        (field) => captureSource(field, '$having'),
        // Relational predicates are not valid in `$having`; report the key so
        // consumers reject it as an unknown/invalid `$having` field.
        (field) => cap(field, '$having'),
      )
      walkSafe(controls.$having, havingVisitor, '$having')
    }
    // `$rowOrder` orders rows inside each group (first() / last()). Both are reported as
    // '$order' so the sortability gates consumers apply to `$sort` cover them by default;
    // `$sort` keys may name an alias, `$rowOrder` keys are fields.
    const orders = [['$sort', controls.$sort, true], ['$rowOrder', controls.$rowOrder, false]] as const
    for (const [name, order, byAlias] of orders) {
      if (isPlainObject(order)) {
        for (const field of Object.keys(order)) {
          if (byAlias) captureSource(field, '$order')
          else cap(field, '$order')
        }
      } else if (order !== undefined) {
        unreadable(name)
      }
    }
    const withList: unknown = controls.$with
    if (Array.isArray(withList)) {
      for (const entry of withList) {
        if (typeof entry === 'string') {
          cap(entry, '$with')
          continue
        }
        if (!isPlainObject(entry) || typeof entry.name !== 'string') {
          unreadable('$with')
          continue
        }
        cap(entry.name, '$with')
        const nested =
          entry.insights instanceof Map
            ? (entry.insights as UniqueryInsights)
            : collect(entry.filter, entry.controls as UniqueryControls | undefined, false)
        if (nested.size) entry.insights = nested
        prefixed(entry.name, nested, cap)
      }
    } else if (withList !== undefined) {
      unreadable('$with')
    }
  }

  const stage = (controls as { $from?: unknown } | undefined)?.$from
  if (controls && stage !== undefined) {
    if (top && isPlainObject(stage)) {
      // The root reads inner columns; a name that is not a computed alias of either level is a
      // table field to an engine that ignores `$from`, so it is reported.
      reportControls(stage as UniqueryControls, capture)
      const aliases = new Set([...aliasesOf(stage.$select), ...aliasesOf(controls.$select)])
      reportControls(controls, (field, op) => {
        if (!aliases.has(field)) capture(field, op)
      })
    } else {
      // Not valid here (inside a `$with` relation) or malformed: report everything, and the marker.
      unreadable('$from')
      if (isPlainObject(stage)) reportControls(stage as UniqueryControls, capture)
      reportControls(controls, capture)
    }
  } else if (controls) {
    reportControls(controls, capture)
  }

  return insights
}

/** Report a related entity's insights under the `prefix.` field path. */
function prefixed(prefix: string, nested: UniqueryInsights, cap: Capture) {
  for (const [field, ops] of nested) {
    const path = `${prefix}.${field}`
    for (const op of ops) cap(path, op)
  }
}

/** The aliases of the computed entries of a `$select`. */
function aliasesOf(select: unknown): string[] {
  const out: string[] = []
  if (Array.isArray(select)) {
    for (const entry of select) {
      if (isComputedExpr(entry)) {
        const alias: unknown = resolveAlias(entry)
        if (typeof alias === 'string' && alias) out.push(alias)
      }
    }
  }
  return out
}

/** A visitor reporting a filter's leaves only (comparisons and relational predicates). */
function leafVisitor(
  comparison: (field: string, op: ComparisonOp) => void,
  relation: (field: string, op: RelationOp, operand: FilterExpr) => void,
): FilterVisitor<void> {
  return { comparison, relation, and() {}, or() {}, not() {} }
}

/**
 * Return insights for a query — uses pre-computed insights when present,
 * computes lazily otherwise.
 */
export function getInsights(query: Uniquery): UniqueryInsights {
  return query.insights ?? computeInsights(query.filter ?? {}, query.controls)
}
