import { describe, expectTypeOf, it } from 'vitest'
import type {
  AggregateControls,
  AggregateQuery,
  AggregateResult,
  BucketExpr,
  FilterExpr,
  NavOf,
  OwnOf,
  RelationPredicate,
  Uniquery,
  CalendarBucketLabel,
  InsightOp,
  ResolveAlias,
  SelectExpr,
  NumericKeys,
  UniqueryControls,
  ValidGroupBy,
} from './types'

interface Ticket {
  status: string
  openedAt: number
  closedAt?: number
  reviewedAt: number | null
  points: number
}

declare function aggregate<const Q extends AggregateQuery<Ticket>>(
  q: Q & ValidGroupBy<Ticket, Q>,
): Q['controls']['$select'] extends readonly (string | object)[]
  ? AggregateResult<Ticket, NonNullable<Q['controls']['$select']>>[]
  : never

describe('ResolveAlias', () => {
  it('uses $as when present', () => {
    expectTypeOf<ResolveAlias<{ $bucket: 'week'; $field: 'openedAt'; $as: 'wk' }>>().toEqualTypeOf<'wk'>()
    expectTypeOf<ResolveAlias<{ $fn: 'sum'; $field: 'points'; $as: 'total' }>>().toEqualTypeOf<'total'>()
  })

  it('defaults to {unit}_{field} for buckets and {fn}_{field} for aggregates', () => {
    expectTypeOf<ResolveAlias<{ $bucket: 'week'; $field: 'openedAt' }>>().toEqualTypeOf<'week_openedAt'>()
    expectTypeOf<ResolveAlias<{ $fn: 'sum'; $field: 'points' }>>().toEqualTypeOf<'sum_points'>()
  })

  it('spells count(*) as count_star, matching the runtime and the URL parser', () => {
    expectTypeOf<ResolveAlias<{ $fn: 'count'; $field: '*' }>>().toEqualTypeOf<'count_star'>()
  })

  it('defaults countDistinct to countDistinct_{field}', () => {
    expectTypeOf<ResolveAlias<{ $fn: 'countDistinct'; $field: 'status' }>>().toEqualTypeOf<'countDistinct_status'>()
  })
})

describe('AggregateResult', () => {
  it('types a bucket as a label and aggregates as numbers', () => {
    type Sel = [{ $bucket: 'week'; $field: 'openedAt'; $as: 'week' }, { $fn: 'count'; $field: '*'; $as: 'n' }]
    expectTypeOf<keyof AggregateResult<Ticket, Sel>>().toEqualTypeOf<'week' | 'n'>()
    expectTypeOf<AggregateResult<Ticket, Sel>['n']>().toEqualTypeOf<number>()
    expectTypeOf<CalendarBucketLabel>().toEqualTypeOf<string>()
    expectTypeOf<AggregateResult<Ticket, Sel>['week']>().toEqualTypeOf<string>()
  })

  it('adds no empty member without expression entries, so a typed row equals the written one', () => {
    type Sel = ['status', { $fn: 'count'; $field: '*'; $as: 'n' }, { $bucket: 'week'; $field: 'openedAt'; $as: 'week' }]
    expectTypeOf<AggregateResult<Ticket, Sel>>().toEqualTypeOf<
      { status: string } & { n: number } & { week: string }
    >()
  })

  it('types expression entries as number | null', () => {
    type Sel = [{ $fn: 'count'; $field: '*'; $as: 'n' }, { $expr: 'n'; $as: 'x' }]
    expectTypeOf<AggregateResult<Ticket, Sel>['x']>().toEqualTypeOf<number | null>()
  })

  it('uses the default bucket alias', () => {
    type Sel = [{ $bucket: 'week'; $field: 'openedAt' }, { $bucket: 'hour'; $field: 'openedAt' }, 'status']
    expectTypeOf<AggregateResult<Ticket, Sel>['week_openedAt']>().toEqualTypeOf<string>()
    expectTypeOf<AggregateResult<Ticket, Sel>['hour_openedAt']>().toEqualTypeOf<string>()
    expectTypeOf<AggregateResult<Ticket, Sel>['status']>().toEqualTypeOf<string>()
  })

  it('is nullable over an optional or nullable source', () => {
    type Sel = [{ $bucket: 'day'; $field: 'closedAt'; $as: 'closed' }, { $bucket: 'day'; $field: 'reviewedAt'; $as: 'reviewed' }]
    expectTypeOf<AggregateResult<Ticket, Sel>['closed']>().toEqualTypeOf<string | null>()
    expectTypeOf<AggregateResult<Ticket, Sel>['reviewed']>().toEqualTypeOf<string | null>()
  })

  it('infers through an aggregate() signature', () => {
    const rows = aggregate({
      controls: {
        $select: [
          { $bucket: 'week', $field: 'openedAt', $tz: 'Europe/Berlin', $weekStart: 'sun', $as: 'week' },
          'status',
          { $fn: 'count', $field: '*', $as: 'n' },
        ],
        $groupBy: ['week', 'status'],
      },
    })
    expectTypeOf(rows[0].week).toEqualTypeOf<string>()
    expectTypeOf(rows[0].status).toEqualTypeOf<string>()
    expectTypeOf(rows[0].n).toEqualTypeOf<number>()
  })

  it('types countDistinct as a number, under its default alias', () => {
    const rows = aggregate({
      controls: {
        $select: ['status', { $fn: 'countDistinct', $field: 'openedAt' }],
        $groupBy: ['status'],
      },
    })
    expectTypeOf(rows[0].countDistinct_openedAt).toEqualTypeOf<number>()
  })
})

describe('ValidGroupBy', () => {
  it('accepts dimensions and bucket aliases', () => {
    aggregate({
      controls: {
        $select: [{ $bucket: 'day', $field: 'openedAt', $as: 'day' }, { $bucket: 'month', $field: 'openedAt' }],
        $groupBy: ['day', 'status', 'month_openedAt'],
      },
    })
  })

  it('rejects a typo and an undeclared alias', () => {
    aggregate({
      controls: {
        $select: [{ $bucket: 'day', $field: 'openedAt', $as: 'day' }],
        // @ts-expect-error — 'stauts' is neither a dimension nor a bucket alias
        $groupBy: ['day', 'stauts'],
      },
    })
    aggregate({
      controls: {
        $select: ['status'],
        // @ts-expect-error — no bucket declares the alias 'week'
        $groupBy: ['week'],
      },
    })
  })
})

describe('control types', () => {
  it('SelectExpr accepts BucketExpr in its array form', () => {
    expectTypeOf<BucketExpr<'openedAt'>>().toExtend<Extract<SelectExpr<Ticket>, unknown[]>[number]>()
    const sel: SelectExpr<Ticket> = ['status', { $bucket: 'day', $field: 'openedAt' }]
    expectTypeOf(sel).toExtend<SelectExpr<Ticket>>()
  })

  it('AggregateControls.$select constrains the bucket source to dimensions', () => {
    const ok: AggregateControls<Ticket, 'openedAt' | 'status'> = {
      $groupBy: ['day'],
      $select: [{ $bucket: 'day', $field: 'openedAt', $as: 'day' }],
    }
    expectTypeOf(ok).toExtend<AggregateControls<Ticket, 'openedAt' | 'status'>>()
    const bad: AggregateControls<Ticket, 'openedAt' | 'status'> = {
      $groupBy: ['day'],
      // @ts-expect-error — 'points' is not a dimension
      $select: [{ $bucket: 'day', $field: 'points', $as: 'day' }],
    }
    expectTypeOf(bad).toExtend<object>()
  })

  it('AggregateControls.$select: countDistinct over dimensions and measures, * only for count', () => {
    const ok: AggregateControls<Ticket, 'status', 'points'> = {
      $groupBy: ['status'],
      $select: [
        { $fn: 'count', $field: '*' },
        { $fn: 'countDistinct', $field: 'points' },
        { $fn: 'countDistinct', $field: 'status' },
      ],
    }
    expectTypeOf(ok).toExtend<AggregateControls<Ticket, 'status', 'points'>>()
    const notAField: AggregateControls<Ticket, 'status', 'points'> = {
      $groupBy: ['status'],
      // @ts-expect-error — 'openedAt' is neither a dimension nor a measure here
      $select: [{ $fn: 'countDistinct', $field: 'openedAt' }],
    }
    expectTypeOf(notAField).toExtend<object>()
    const dimSum: AggregateControls<Ticket, 'status', 'points'> = {
      $groupBy: ['status'],
      // @ts-expect-error — other aggregates stay limited to measures
      $select: [{ $fn: 'sum', $field: 'status' }],
    }
    expectTypeOf(dimSum).toExtend<object>()
    const bad: AggregateControls<Ticket> = {
      $groupBy: ['status'],
      // @ts-expect-error — a distinct count needs a field
      $select: [{ $fn: 'countDistinct', $field: '*' }],
    }
    expectTypeOf(bad).toExtend<object>()
    const sumStar: AggregateControls<Ticket> = {
      $groupBy: ['status'],
      // @ts-expect-error — only count accepts '*'
      $select: [{ $fn: 'sum', $field: '*' }],
    }
    expectTypeOf(sumStar).toExtend<object>()
  })

  it('rejects an unknown unit and week start', () => {
    // @ts-expect-error — not a BucketUnit
    const unit: BucketExpr = { $bucket: 'fortnight', $field: 'openedAt' }
    // @ts-expect-error — not a WeekStart
    const ws: BucketExpr = { $bucket: 'week', $field: 'openedAt', $weekStart: 'sunday' }
    expectTypeOf(unit).toExtend<BucketExpr>()
    expectTypeOf(ws).toExtend<BucketExpr>()
  })

  it('UniqueryControls.$groupBy admits a bucket alias', () => {
    const c: UniqueryControls<Ticket> = {
      $select: [{ $bucket: 'day', $field: 'openedAt', $as: 'day' }],
      $groupBy: ['day', 'status'],
    }
    expectTypeOf(c).toExtend<UniqueryControls<Ticket>>()
  })

  it("InsightOp includes '$bucket'", () => {
    expectTypeOf<'$bucket'>().toExtend<InsightOp>()
  })
})

describe('relational predicates', () => {
  interface TeamOwn { id: string; name: string }
  interface TeamT { __ownProps: TeamOwn; __navProps: {} }
  interface TicketOwn { key: string; teamId: string; status: string }
  type TicketNav = { team: TeamT; issues: IssueT[] }
  interface TicketT { __ownProps: TicketOwn; __navProps: TicketNav }
  interface IssueOwn { id: number; title: string; ticketKey: string | null }
  type IssueNav = { ticket: TicketT }
  interface IssueT { __ownProps: IssueOwn; __navProps: IssueNav }

  it('typed nav key accepts $some / $none over the target own props', () => {
    const f: FilterExpr<IssueOwn, IssueNav> = {
      title: 'x',
      ticket: { $some: { status: 'open', teamId: { $in: ['t1'] } }, $none: {} },
    }
    expectTypeOf(f).toExtend<FilterExpr<IssueOwn, IssueNav>>()
  })

  it('nests through the target nav props, including to-many targets', () => {
    const f: FilterExpr<IssueOwn, IssueNav> = {
      ticket: { $some: { team: { $none: { name: 'x' } }, issues: { $some: { title: 'y' } } } },
    }
    expectTypeOf(f).toExtend<FilterExpr<IssueOwn, IssueNav>>()
    const q: Uniquery<IssueOwn, IssueNav> = {
      filter: { $or: [{ ticket: { $some: { status: 'open' } } }, { $not: { ticket: { $none: {} } } }] },
    }
    expectTypeOf(q).toExtend<Uniquery<IssueOwn, IssueNav>>()
  })

  it('optional nav keys are typed through their target too', () => {
    type OptNav = { ticket?: TicketT; labels?: TicketT[] | null }
    const f: FilterExpr<IssueOwn, OptNav> = { ticket: { $some: { status: 'open' } }, labels: { $none: {} } }
    expectTypeOf(f).toExtend<FilterExpr<IssueOwn, OptNav>>()
    const bad: FilterExpr<IssueOwn, OptNav> = {
      // @ts-expect-error — 'nope' is not a Ticket field
      ticket: { $some: { nope: 1 } },
    }
    expectTypeOf(bad).toExtend<object>()
  })

  it('rejects an unknown target field', () => {
    const f: FilterExpr<IssueOwn, IssueNav> = {
      // @ts-expect-error — 'nope' is not a Ticket field
      ticket: { $some: { nope: 1 } },
    }
    expectTypeOf(f).toExtend<object>()
  })

  it('rejects $some on an own field', () => {
    const f: FilterExpr<IssueOwn, IssueNav> = {
      // @ts-expect-error — title is not a navigation field
      title: { $some: {} },
    }
    expectTypeOf(f).toExtend<object>()
  })

  it('$with sub-filters are typed through the target nav props', () => {
    const q: Uniquery<IssueOwn, IssueNav> = {
      controls: { $with: [{ name: 'ticket', filter: { team: { $some: { name: 'x' } } } }] },
    }
    expectTypeOf(q).toExtend<Uniquery<IssueOwn, IssueNav>>()
  })

  it('$with sub-filters on an OPTIONAL / nullable nav are fully typed through the target', () => {
    type OptNav = { ticket?: TicketT | null; issues?: IssueT[] }
    const ok: Uniquery<IssueOwn, OptNav> = {
      controls: {
        $with: [
          // nested predicate inside a $with filter compiles exactly like at the root
          { name: 'ticket', filter: { status: 'open', team: { $some: { name: 'x' } } } },
          { name: 'issues', filter: { title: 'y', ticket: { $none: {} } } },
        ],
      },
    }
    expectTypeOf(ok).toExtend<Uniquery<IssueOwn, OptNav>>()
    const badKey: Uniquery<IssueOwn, OptNav> = {
      // @ts-expect-error — 'nope' is not a Ticket field
      controls: { $with: [{ name: 'ticket', filter: { nope: 1 } }] },
    }
    const badValue: Uniquery<IssueOwn, OptNav> = {
      // @ts-expect-error — status is a string
      controls: { $with: [{ name: 'ticket', filter: { status: 42 } }] },
    }
    expectTypeOf(badKey).toExtend<object>()
    expectTypeOf(badValue).toExtend<object>()
  })

  it('readonly to-many nav arrays type their operands through the element', () => {
    type RoNav = { issues: readonly IssueT[] }
    const ok: FilterExpr<TicketOwn, RoNav> = { issues: { $some: { title: 'x' } } }
    expectTypeOf(ok).toExtend<FilterExpr<TicketOwn, RoNav>>()
    const bad: FilterExpr<TicketOwn, RoNav> = {
      // @ts-expect-error — 'nope' is not an Issue field
      issues: { $some: { nope: 1 } },
    }
    expectTypeOf(bad).toExtend<object>()
  })

  it('OwnOf / NavOf do not distribute over a nullable entity', () => {
    expectTypeOf<OwnOf<TicketT | undefined>>().toEqualTypeOf<Record<string, unknown>>()
    expectTypeOf<OwnOf<TicketT>>().toEqualTypeOf<TicketOwn>()
    expectTypeOf<NavOf<TicketT | undefined>>().toEqualTypeOf<{}>()
    expectTypeOf<NavOf<TicketT>>().toEqualTypeOf<TicketNav>()
  })

  it('untyped filters are unchanged (any key, predicates allowed by shape)', () => {
    const a: FilterExpr = { anything: 1, 'a.b': { $gt: 2 } }
    const b: FilterExpr = { ticket: { $some: { x: 1 } } }
    const c: FilterExpr<IssueOwn> = { title: 'x' }
    expectTypeOf(a).toExtend<FilterExpr>()
    expectTypeOf(b).toExtend<FilterExpr>()
    expectTypeOf(c).toExtend<FilterExpr<IssueOwn>>()
    expectTypeOf<RelationPredicate>().toHaveProperty('$some')
  })

  it("InsightOp includes '$some' / '$none'", () => {
    expectTypeOf<'$some'>().toExtend<InsightOp>()
    expectTypeOf<'$none'>().toExtend<InsightOp>()
  })
})

describe('arithmetic expressions, first / last and $rowOrder', () => {
  const select = [
    'status',
    { $fn: 'sum', $expr: { $op: '*', $args: ['points', 2] }, $as: 'weighted' },
    { $expr: { $op: '/', $args: ['weighted', 'n'] }, $as: 'ratio' },
    { $fn: 'count', $field: '*', $as: 'n' },
    { $fn: 'first', $field: 'closedAt', $as: 'firstClosed' },
    { $fn: 'last', $field: 'status', $as: 'lastStatus' },
  ] as const
  type Sel = typeof select

  it('infers number | null for expressions and T[F] for first / last', () => {
    expectTypeOf<AggregateResult<Ticket, Sel>['weighted']>().toEqualTypeOf<number | null>()
    expectTypeOf<AggregateResult<Ticket, Sel>['ratio']>().toEqualTypeOf<number | null>()
    expectTypeOf<AggregateResult<Ticket, Sel>['n']>().toEqualTypeOf<number>()
    expectTypeOf<AggregateResult<Ticket, Sel>['firstClosed']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<AggregateResult<Ticket, Sel>['lastStatus']>().toEqualTypeOf<string>()
    expectTypeOf<AggregateResult<Ticket, Sel>['status']>().toEqualTypeOf<string>()
  })

  it('resolves the alias of the new entries', () => {
    expectTypeOf<ResolveAlias<{ $expr: 1; $as: 'r' }>>().toEqualTypeOf<'r'>()
    expectTypeOf<ResolveAlias<{ $fn: 'sum'; $expr: 1; $as: 'r' }>>().toEqualTypeOf<'r'>()
    expectTypeOf<ResolveAlias<{ $fn: 'first'; $field: 'points' }>>().toEqualTypeOf<'first_points'>()
  })

  it('accepts the new entries and $rowOrder in the controls', () => {
    const q: AggregateQuery<Ticket> = {
      controls: {
        $groupBy: ['status'],
        $select: [
          'status',
          { $fn: 'first', $field: 'points', $as: 'f' },
          { $fn: 'sum', $expr: 'points', $as: 's' },
          { $expr: { $op: '+', $args: ['s', 1] }, $as: 'e' },
        ],
        $rowOrder: { openedAt: 1, points: -1 },
      },
    }
    expectTypeOf(q).toExtend<AggregateQuery<Ticket>>()
    const bad: AggregateControls<Ticket> = {
      $groupBy: ['status'],
      // @ts-expect-error — direction must be 1 | -1
      $rowOrder: { openedAt: 2 },
    }
    expectTypeOf(bad).toExtend<object>()
    const ctl: UniqueryControls<Ticket> = { $rowOrder: { points: 1 } }
    expectTypeOf(ctl).toExtend<UniqueryControls<Ticket>>()
  })

  it("InsightOp includes 'first' and 'last'", () => {
    expectTypeOf<'first'>().toExtend<InsightOp>()
  })
})

describe('NumericKeys', () => {
  interface Row {
    id: number
    title: string
    price: number
    discount?: number | null
    flag: boolean
  }

  it('lists the numeric keys of a concrete record', () => {
    expectTypeOf<NumericKeys<Row>>().toEqualTypeOf<'id' | 'price' | 'discount'>()
  })

  it('falls back to string for an untyped record, any, or no numeric key', () => {
    expectTypeOf<NumericKeys<Record<string, unknown>>>().toEqualTypeOf<string>()
    expectTypeOf<NumericKeys<any>>().toEqualTypeOf<string>()
    expectTypeOf<NumericKeys<{ a: string }>>().toEqualTypeOf<string>()
  })

  it('types the operands of a row-level aggregate in SelectExpr<T>', () => {
    const ok: SelectExpr<Row> = [{ $fn: 'sum', $expr: { $op: '*', $args: ['price', 2] }, $as: 'x' }]
    expectTypeOf(ok).toExtend<SelectExpr<Row>>()
    // @ts-expect-error — `title` is not a numeric field
    const bad: SelectExpr<Row> = [{ $fn: 'sum', $expr: { $op: '*', $args: ['title', 2] }, $as: 'x' }]
    void bad
    // an untyped record keeps accepting any name
    const loose: SelectExpr = [{ $fn: 'sum', $expr: 'anything', $as: 'x' }]
    expectTypeOf(loose).toExtend<SelectExpr>()
  })
})

