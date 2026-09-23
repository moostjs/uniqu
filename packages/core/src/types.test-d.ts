import { describe, expectTypeOf, it } from 'vitest'
import type {
  AggregateControls,
  AggregateQuery,
  AggregateResult,
  BucketExpr,
  CalendarBucketLabel,
  InsightOp,
  ResolveAlias,
  SelectExpr,
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
})

describe('AggregateResult', () => {
  it('types a bucket as a label and aggregates as numbers', () => {
    type Sel = [{ $bucket: 'week'; $field: 'openedAt'; $as: 'week' }, { $fn: 'count'; $field: '*'; $as: 'n' }]
    expectTypeOf<keyof AggregateResult<Ticket, Sel>>().toEqualTypeOf<'week' | 'n'>()
    expectTypeOf<AggregateResult<Ticket, Sel>['n']>().toEqualTypeOf<number>()
    expectTypeOf<CalendarBucketLabel>().toEqualTypeOf<string>()
    expectTypeOf<AggregateResult<Ticket, Sel>['week']>().toEqualTypeOf<string>()
  })

  it('uses the default bucket alias', () => {
    type Sel = [{ $bucket: 'week'; $field: 'openedAt' }, 'status']
    expectTypeOf<AggregateResult<Ticket, Sel>['week_openedAt']>().toEqualTypeOf<string>()
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
