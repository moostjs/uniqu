# @uniqu/core

<p align="center">
  <img src="../../logo.svg" alt="uniqu" height="80">
</p>

Canonical query format types and transport-agnostic utilities for the Uniqu query representation.

## Install

```bash
pnpm add @uniqu/core
```

## Query Format

A `Uniquery` consists of a **filter** (recursive expression tree) and **controls** (pagination, projection, sorting):

```ts
import type { Uniquery, FilterExpr } from '@uniqu/core'

const query: Uniquery = {
  filter: {
    age: { $gte: 18, $lte: 30 },
    status: { $ne: 'DELETED' },
    role: { $in: ['Admin', 'Editor'] },
  },
  controls: {
    $sort: { createdAt: -1 },
    $limit: 20,
    $select: ['name', 'email'],
  },
}
```

### Filter Expressions

A `FilterExpr` is a **comparison node** (leaf), a **logical node** (branch), or a mix of both in one object (see [below](#mixing-comparison-fields-with-logical-operators)):

```ts
// Comparison — one or more field conditions
{ age: { $gte: 18 }, status: 'active' }

// Bare primitive is implicit $eq
{ name: 'John' }  // equivalent to { name: { $eq: 'John' } }

// Logical — $and / $or wrapping child expressions
{ $or: [
  { age: { $gt: 25 } },
  { status: 'VIP' },
]}

// Negation — $not wrapping a single child
{ $not: { status: 'DELETED' } }
```

#### Mixing comparison fields with logical operators

Comparison fields and logical operators may appear in the **same** object. All
members of an object are combined with an implicit **AND**, in key order
(MongoDB semantics):

```ts
// Both the field conditions and the $or branch apply
{ id: 101, nextRefreshAt: { $lte: now }, $or: [{ status: 'a' }, { status: 'b' }] }

// …is equivalent to
{ $and: [
  { id: 101, nextRefreshAt: { $lte: now } },
  { $or: [{ status: 'a' }, { status: 'b' }] },
]}
```

The same holds for `$and` and `$not` members, and for several logical keys in
one object — each is simply another AND member: `{ a: 1, $and: [...], $or: [...] }`
means `a = 1` AND the `$and` branch AND the `$or` branch.

### Comparison Operators

| Operator | Description | Value Type |
|----------|-------------|------------|
| `$eq` | Equal (implicit when bare value) | `Primitive` |
| `$ne` | Not equal | `Primitive` |
| `$gt` | Greater than | `Primitive` |
| `$gte` | Greater than or equal | `Primitive` |
| `$lt` | Less than | `Primitive` |
| `$lte` | Less than or equal | `Primitive` |
| `$in` | In list | `Primitive[]` |
| `$nin` | Not in list | `Primitive[]` |
| `$regex` | Regular expression match | `RegExp \| string` |
| `$exists` | Field existence check | `boolean` |

`Primitive` = `string | number | boolean | null | RegExp | Date`

> **Note on `Date`:** `Date` is included for direct code usage (e.g. `{ createdAt: { $gt: new Date() } }`). The URL parser produces ISO strings, not `Date` instances. Adapters are responsible for converting `Date` to their native format (`.toISOString()` for SQL, native `Date` for MongoDB).

### Controls

| Field | Type | Description |
|-------|------|-------------|
| `$sort` | `Record<string, 1 \| -1>` | Sort fields (1 = asc, -1 = desc) |
| `$skip` | `number` | Skip N results |
| `$limit` | `number` | Limit to N results |
| `$count` | `boolean` | Request total count |
| `$select` | `SelectExpr<T>` | Field projection — array of strings/aggregates for inclusion, object for exclusion/mixed |
| `$rowOrder` | `Record<string, 1 \| -1>` | Row order inside each group for `first()` / `last()` — see [representative row](#representative-row-first--last-and-roworder) |
| `$groupBy` | `string[]` | Fields — or [calendar bucket](#calendar-buckets-bucketexpr) aliases — to group by for aggregate queries |
| `$having` | `FilterExpr` | Post-aggregation filter on aliases and dimension fields |
| `$with` | `(WithRelation \| string)[]` | Relations to populate alongside the primary query |
| `$<custom>` | `unknown` | Arbitrary pass-through keywords |

### Relation Loading (`$with`)

`$with` declares which relations to populate alongside the primary query. Each entry can be a **string** (relation name only) or a full **object** (a `WithRelation` sub-query with its own `filter`, `controls`, and `insights`):

```ts
import type { Uniquery, WithRelation } from '@uniqu/core'

const query: Uniquery = {
  filter: { status: 'active' },
  controls: {
    $with: [
      // String shorthand — just the relation name
      'profile',
      // Object form — full sub-query
      {
        name: 'posts',
        filter: { status: 'published' },
        controls: {
          $sort: { createdAt: -1 },
          $limit: 5,
          $select: ['title', 'body'],
          $with: [
            { name: 'comments', filter: {}, controls: { $limit: 10 } },
            'author',
          ],
        },
      },
    ],
  },
}
```

`WithRelation` is a `Uniquery` with a required `name`:

```ts
type WithRelation = Uniquery & { name: string }
```

The `Uniquery` type itself has an optional `name` — when present it is a nested relation, when absent it is the root query. This means every `$with` object entry is a self-contained query with its own `filter`, `controls` (including `$sort`, `$skip`, `$limit`, `$select`, nested `$with`, and pass-through keywords), and optional `insights`. The structure is recursive to any depth.

When a `Nav` generic is provided, string entries and `name` fields are constrained to `keyof Nav & string`. Without a generic, any string is accepted.

Uniqu is a query parser, not an ORM. It records what was requested — the consumer (e.g. a database adapter) decides how to execute it (JOINs, subqueries, separate queries), validates relation names against its schema, and enforces depth/security limits.

### Relational Predicates (`$some` / `$none`)

A navigation field in a filter takes a relational predicate: an operator map that filters the **parent** rows by the existence of related rows. The operand is a filter on the related entity — its keys are the target's fields:

```ts
const query: Uniquery = {
  filter: {
    // issues whose ticket is open and belongs to team t1 or t2
    ticket: { $some: { teamId: { $in: ['t1', 't2'] }, status: 'open' } },
    // ... and that have no labels named "wontfix"
    labels: { $none: { name: 'wontfix' } },
  },
}
```

| Operator | Matches a parent row when |
|----------|---------------------------|
| `$some: F` | at least one related row matches `F` |
| `$none: F` | no related row matches `F` |
| `$some: {}` | it has any related row |
| `$none: {}` | it has no related row |

- One meaning for to-one and to-many relations. Several operators on one key are ANDed (`{ ticket: { $some: A, $none: B } }`).
- The operand may hold predicates on the target's own navigation fields (`{ ticket: { $some: { team: { $none: { name: 'x' } } } } }`).
- There is no `$every`: "every related row matches `F`" is `$none: { $not: F }`.
- Predicates sit anywhere a comparison can — under `$and` / `$or` / `$not`, and inside `$with` sub-query filters.
- `$with` and predicates are independent: `$with` filters the **loaded children**, a predicate filters the **parents**.

Uniqu defines the shape only. Which relations exist, how a predicate is executed (SQL `EXISTS`, a `$lookup`, …) and which callers may use it is the consumer's decision.

### Aggregation (`$groupBy` + `$select`)

`$groupBy` declares grouping fields. Aggregate functions appear as `AggregateExpr` objects in the `$select` array alongside plain field names:

```ts
import type { Uniquery, AggregateExpr } from '@uniqu/core'

const query: Uniquery = {
  filter: { status: 'active' },
  controls: {
    $select: [
      'currency',
      { $fn: 'sum', $field: 'amount', $as: 'total' },
      { $fn: 'count', $field: '*', $as: 'count' },
    ],
    $groupBy: ['currency'],
    $sort: { total: -1 },
    $limit: 10,
  },
}
```

`AggregateExpr` has three fields:

```ts
interface AggregateExpr {
  $fn: AggregateFn | (string & {})  // 'sum' | 'count' | 'countDistinct' | 'avg' | 'min' | 'max' | 'first' | 'last' | custom
  $field: string                     // field name, or '*' for count(*)
  $as?: string                       // optional alias for the result
}
```

Known functions are `sum`, `count`, `countDistinct`, `avg`, `min`, `max`, `first`, `last` (`AggregateFn`), but `$fn` accepts any string for extensibility — consumers validate and execute supported functions. `AGGREGATE_FNS` lists the known names at runtime and `isAggregateFn(name)` checks one.

`countDistinct` counts the distinct non-null values of `$field`; the result is a number. In `AggregateControls` it may target a dimension or a measure field (other aggregates take measures only). Only `count` accepts `'*'` (`STAR_AGGREGATE_FNS`): `countDistinct(*)` is not valid.

Without `$as`, an entry's alias is `${fn}_${field}` (`count(*)` → `count_star`, `countDistinct(customerId)` → `countDistinct_customerId`). `resolveAlias(expr)` applies that rule for aggregates and buckets alike — use it instead of re-deriving aliases.

#### Arithmetic expressions (`ArithExpr`)

A closed arithmetic grammar for aggregates over expressions and for expressions over other aggregates. `ArithExpr` is a number literal, a name, or an operator node:

```ts
type ArithExpr =
  | number
  | string                                                       // a name
  | { $op: '+' | '-' | '*' | '/'; $args: [ArithExpr, ArithExpr] }
  | { $op: '-'; $args: [ArithExpr] }                             // negation
  | { $op: 'coalesce'; $args: [ArithExpr, ArithExpr, ...ArithExpr[]] }
```

Two `$select` entry kinds use it; both require `$as`:

```ts
{ $fn: 'sum', $expr: { $op: '*', $args: ['price', 'qty'] }, $as: 'revenue' }   // AggregateOfExpr: row-level, $fn is sum | avg | min | max
{ $expr: { $op: '/', $args: ['est', 'open'] }, $as: 'avgEst' }                  // SelectArithExpr: group-level
```

A row-level expression's names are fields of the row. A group-level expression's names are the aliases of other numeric entries (aggregates, `first` / `last`, other expressions, in any order, without cycles) or plain `$groupBy` fields; it is evaluated after grouping, and an inline aggregate call (`sum(a)/count(*)`) is not part of the grammar. Both entry kinds are valid in grouped queries only, and an expression alias cannot be a `$groupBy` entry. Results are typed `number | null` in `AggregateResult`. `isAggregateOfExpr` and `isSelectArithExpr` tell the kinds apart (`isAggregateExpr` stays strict: it needs a string `$field`). `NumericKeys<T>` lists the number-valued keys of `T`.

One grammar serves JSON users and the URL:

```ts
import { parseArith, formatArith, arithNames, arithNullable, validateArith } from '@uniqu/core'

parseArith('open*10+sevMax')             // { $op: '+', $args: [{ $op: '*', $args: ['open', 10] }, 'sevMax'] }
formatArith(expr)                        // 'open*10+sevMax'
formatArith(expr, { encodePlus: true })  // 'open*10%2BsevMax' (for a URL)
```

- `parseArith(text)`: `+ - * /` (left-associative, `*` `/` bind tighter), unary `-`, parentheses, number literals (`2`, `0.5`, `1e3`), names (`[A-Za-z_][\w.]*`) and `coalesce(a, b, …)`. A `-` directly before a number in operand position is a negative literal; `-(5)` is a negation node. Whitespace is skipped. It throws `SyntaxError` with the offset (missing operator, unbalanced paren, unknown function, a literal that underflows to 0).
- `formatArith(expr, { encodePlus? })`: canonical text with minimal parentheses (`a-(b-c)` keeps them), the inverse of `parseArith`: `parseArith(formatArith(x))` deep-equals `x`. It throws `TypeError` for a malformed expression.
- `arithNames(expr)`: the distinct names, in first-use order. `arithNullable(expr, isNullable)`: whether the result may be NULL (a `/`, a nullable name, or a `coalesce` whose arguments are all nullable).
- `validateArith(expr)`: schema-free rules as `QueryIssue[]`: operators and arities (`-` takes 1 or 2 arguments, `coalesce` at least 2, the rest 2), identifier names, finite literals within `Number.MAX_SAFE_INTEGER`, at least one name (a constant is rejected), and at most `ARITH_MAX_NODES` (64) nodes and `ARITH_MAX_DEPTH` (16) levels. The limits are a guard: the URL is user input.

Semantics are the consumer's (a typical engine uses IEEE doubles, NULL propagates, and division by zero gives NULL).

#### Representative row: `first` / `last` and `$rowOrder`

`first` / `last` read one field of a representative row of each group. The row is chosen by the query's `$rowOrder` control (same shape as `$sort`) and is the same row for every `first()`; every `last()` reads the opposite end. `$rowOrder` is required when `first` / `last` is used and rejected otherwise; `first(*)` is not valid. Results are typed as the field (like `min` / `max`).

```ts
{
  $groupBy: ['ticketId'],
  $select: ['ticketId', { $fn: 'first', $field: 'title', $as: 'oldestTitle' }, { $fn: 'last', $field: 'raisedAt', $as: 'newestAt' }],
  $rowOrder: { raisedAt: 1 },
}
```

#### Calendar buckets (`BucketExpr`)

A bucket groups a timestamp field (epoch milliseconds) by local hour, calendar day, week, month, quarter or year in a chosen time zone. It is a computed entry in `$select` with an alias, and `$groupBy`, `$sort` and `$having` refer to that alias:

```ts
const query: Uniquery = {
  filter: { openedAt: { $gte: from, $lt: to } }, // keep a range on the raw timestamp
  controls: {
    $select: [
      { $bucket: 'week', $field: 'openedAt', $tz: 'Europe/Berlin', $weekStart: 'sun', $as: 'week' },
      'status',
      { $fn: 'count', $field: '*', $as: 'n' },
    ],
    $groupBy: ['week', 'status'],
    $having: { week: { $gte: '2026-03-01' } },
    $sort: { week: 1 },
  },
}
// → rows like { week: '2026-03-22', status: 'open', n: 4 }
```

| Field | Values | Default |
|-------|--------|---------|
| `$bucket` | `'hour' \| 'day' \| 'week' \| 'month' \| 'quarter' \| 'year'` | — |
| `$field` | timestamp field (epoch ms) | — |
| `$tz` | canonical IANA zone (`'Europe/Berlin'`, `'Asia/Kolkata'`) | `'UTC'` |
| `$weekStart` | `'mon'` … `'sun'` — only with `$bucket: 'week'` | `'mon'` (ISO 8601) |
| `$as` | alias; required when `$field` contains `.` | `${unit}_${field}` |

**The value is a label, not a timestamp:** the local calendar date of the bucket's first day as `YYYY-MM-DD` — `'2026-03-22'` for a week starting Sunday 22 March, `'2026-03-01'` for March, `'2026-01-01'` for Q1 — and for `'hour'` the local date and hour as `YYYY-MM-DDTHH:00`. Labels are wall-clock times in the bucket's zone, computed only from instant → local time (so they are DST-safe); use `bucketStartInstant(label, tz)` for the instant a bucket starts — `new Date(label)` would read it in the runtime's zone. They sort chronologically as plain strings (so `$sort` and string comparisons in `$having` just work), and a week may start in the previous month or year (week(mon) of 2027-01-01 is `'2026-12-28'`). A null source, or an instant outside `[1970-01-02T00:00Z, 3000-01-01T00:00Z)`, gives a `null` label — those rows form one null group. `AggregateResult` types the label as `CalendarBucketLabel` (a string), `| null` when the source field is optional or nullable.

**Hour buckets** are labelled with the local date and wall-clock hour (`'2026-03-29T14:00'`). The hour is the hour on the clock in `$tz`, so in zones with a non-whole-hour offset it starts at :30 or :45 past a UTC hour (10:00 in `Asia/Kolkata` is 04:30Z). Around DST transitions the label follows the clock, the same rule as `'day'` (whose fall-back day lasts 25 hours):

- **Fall-back:** the repeated hour is one label. In `Europe/Berlin` on 2026-10-25, `'2026-10-25T02:00'` covers 00:00Z–02:00Z — both passes of 02:00–03:00 local.
- **Spring-forward:** the skipped hour has no label. In `Europe/Berlin` on 2026-03-29, `'2026-03-29T01:00'` is followed by `'2026-03-29T03:00'`. A shift of 30 minutes (`Australia/Lord_Howe`) leaves a half-hour bucket instead.

Validation that needs no schema lives here, so every consumer rejects the same inputs with the same wording. `resolveBuckets(controls)` returns `{ ok: true, buckets, exprs, rowOrder? }` or `{ ok: false, issues: [{ path, message }] }` — it rejects unknown units, zones and week starts, a `$weekStart` on a non-week unit, a bucket outside a grouped query or missing from `$groupBy`, duplicate aliases, `$select` entries that are neither a field, an aggregate nor a bucket, and aggregates that fail `validateAggregateExpr`. Pass `{ isField: (name) => boolean }` to also reject an alias that collides with a real field of your schema (by default only fields selected in `$select` are checked), `{ aggregate: true }` when the query is grouped by other means, and `{ fns: AGGREGATE_FNS }` (or your own list) to reject unknown aggregate functions. `checkTimeZone(tz)` validates a zone and returns its canonical spelling (an alias such as `'US/Eastern'` is rejected with a hint naming `'America/New_York'`). Which fields may be bucketed (for example only timestamp-typed ones) is up to the consumer.

`validateAggregateExpr(expr, { fns? })` checks one aggregate: its `$fn` is in `fns` (only when given — by default any name passes, so custom functions work), and a known function other than `count` is not applied to `'*'`. It returns `{ ok: true }` or `{ ok: false, message }`.

`resolveBuckets` also validates the arithmetic entries and `first` / `last` (rules above): `exprs` lists the arithmetic entries as `{ alias, expr, names, level: 'row' | 'group', fn? }`, row-level first, then group-level in dependency order (a cycle is reported as `Expression cycle: a → b → a`); `rowOrder` is `[{ field, desc }]` when `first` / `last` is used. Pass `$rowOrder` in the controls. It reports an expression alias that collides with a field or another alias, an operand that is not an alias or `$groupBy` field, a bucket alias used as an operand, grouping by an expression alias, and a missing or superfluous `$rowOrder`. Whether an operand is numeric is the caller's rule. Issue paths are `$select`, `$groupBy` or `$rowOrder`.

`groupByFields(controls)` maps `$groupBy` to source fields — a bucket alias becomes its `$field` — for access-control whitelists. `isAggregateExpr` / `isBucketExpr` / `isAggregateOfExpr` / `isSelectArithExpr` tell `$select` entries apart.

The date math is exported too, so clients produce exactly the labels servers return:

```ts
import { bucketLabel, bucketer, bucketSeries, nextBucketLabel, bucketStartInstant } from '@uniqu/core'

bucketLabel(Date.UTC(2026, 2, 29, 0, 30), 'day', 'Europe/Berlin') // '2026-03-29'
const weekOf = bucketer('week', 'Europe/Berlin', 'sun')            // resolve once, label many rows
rows.map((r) => weekOf(r.openedAt))
bucketStartInstant('2026-03-29', 'Europe/Berlin')                  // first instant of that local date (ms)
bucketLabel(Date.UTC(2026, 2, 29, 1, 30), 'hour', 'Europe/Berlin') // '2026-03-29T03:00'

// the full axis between two returned labels — fill the empty buckets of a chart
bucketSeries('2026-03-29T00:00', '2026-03-29T04:00', 'hour', { tz: 'Europe/Berlin' })
// ['2026-03-29T00:00', '2026-03-29T01:00', '2026-03-29T03:00', '2026-03-29T04:00'] — the DST gap is left out
nextBucketLabel('2026-01-31', 'month')                             // '2026-02-01' — one step
```

`bucketSeries(first, last, unit, { weekStart?, tz?, maxLength? })` lists every label from the bucket holding `first` through the one holding `last`; pass the query's unit, `$weekStart` and `$tz`. With `tz` it leaves out labels no instant has in that zone — the hour a spring-forward skips, or a skipped date such as `Pacific/Apia`'s 2011-12-30 — so the axis matches what the server can return. It throws a `RangeError` past `maxLength` labels (default 100 000). `nextBucketLabel(label, unit, { weekStart?, tz? })` is the single step (the third argument may also be just the week start, the older form); it is zone-free unless `tz` is given. `bucketStartInstant(label, tz)` accepts either label format and returns the first instant of that local day or hour; a repeated hour starts at its first pass, and a start that falls in a DST gap resolves to the transition instant.

#### Post-Aggregation Filter (`$having`)

`$having` filters groups after aggregation — the equivalent of SQL `HAVING`. It operates on aggregate result aliases and dimension fields:

```ts
const query: Uniquery = {
  filter: { status: 'active' },
  controls: {
    $select: [
      'currency',
      { $fn: 'sum', $field: 'amount', $as: 'total' },
    ],
    $groupBy: ['currency'],
    $having: { total: { $gt: 1000 } },
    $sort: { total: -1 },
  },
}
```

`$having` accepts a full `FilterExpr` — logical operators (`$and`, `$or`, `$not`) and all comparison operators are supported. It is untyped (`FilterExpr` without a generic) because its fields are aggregate aliases that don't exist on the entity type `T`.

Insights record **source fields**, never aliases: an alias used in `$having`, `$sort` or `$groupBy` is resolved to the field behind it. An expression aggregate records each operand field under its function (`sum(price*qty)` → `price` and `qty` get `'sum'`), `first` / `last` record the field under `'first'` / `'last'`, each `$rowOrder` key is recorded as `'$order'`, and an expression alias is not a field, so it is not recorded. Aggregate usage is recorded with bare function names (not `$`-prefixed), and a bucket with `'$bucket'`:

```ts
// insights for the query above:
// 'status'   => Set { '$eq' }
// 'currency' => Set { '$select', '$groupBy' }
// 'amount'   => Set { 'sum', '$having', '$order' }   // 'total' resolves to 'amount'

// insights for the calendar-bucket query above:
// 'openedAt' => Set { '$bucket', '$groupBy', '$having', '$order' }
// 'status'   => Set { '$select', '$groupBy' }
// '*'        => Set { 'count' }
```

Up to 0.1.8 an alias used in `$having` was recorded as if it were a field (`'total' => Set { '$having' }`).

## Type-Safe Filters

`FilterExpr<T>` accepts a generic entity type for compile-time field and value checking:

```ts
interface User {
  name: string
  age: number
  active: boolean
}

const filter: FilterExpr<User> = {
  name: 'John',              // string — ok
  age: { $gte: 18 },         // number — ok
  active: true,              // boolean — ok
  // age: { $gte: 'old' },   // type error: string not assignable to number
  // foo: 'bar',             // type error: 'foo' is not a key of User
}
```

When typed, only keys of `T` are allowed — no arbitrary string keys. Without a generic argument, `FilterExpr` accepts any string keys with any values (untyped mode).

A second generic, `Nav`, types [relational predicates](#relational-predicates-some--none). Each `Nav` key accepts `{ $some?, $none? }` whose operand is typed by the target's `__ownProps` (fields) and `__navProps` (nested predicates). Array targets (to-many) use their element type:

```ts
type TicketNav = { team: { __ownProps: { id: string; name: string }; __navProps: {} } }
type Ticket = { __ownProps: { key: string; status: string }; __navProps: TicketNav }
type IssueNav = { ticket: Ticket }

const filter: FilterExpr<{ id: number; title: string }, IssueNav> = {
  title: 'Crash on save',
  ticket: { $some: { status: 'open', team: { $none: { name: 'Ops' } } } },
  // ticket: { $some: { nope: 1 } },  // type error: 'nope' is not a Ticket field
  // title: { $some: {} },            // type error: title is not a navigation field
}
```

`Uniquery<T, Nav>` passes `Nav` to its filter, and typed `$with` entries pass the target's navigation props to theirs. `Nav` defaults to `{}`; a wide `Record<string, unknown>` contributes nothing, so untyped filters are unchanged.

### Type-Safe Controls

`UniqueryControls<T>` constrains `$select` and `$sort` field names when a type parameter is provided:

```ts
const query: Uniquery<User> = {
  filter: { name: 'John' },
  controls: {
    $select: ['name', 'email'],     // ✅ autocomplete, catches typos
    $sort: { name: 1 },             // ✅ only known fields
    // $select: ['foo'],            // type error: 'foo' is not keyof User
  },
}
```

## Tree Walker

`walkFilter` traverses a filter tree and calls a visitor at each node. The generic return type `R` is controlled by the visitor — `string` for SQL rendering, `boolean` for validation, `void` for side-effect traversals:

```ts
import { walkFilter, type FilterVisitor } from '@uniqu/core'

// Example: render to a SQL WHERE clause
const sqlVisitor: FilterVisitor<string> = {
  comparison(field, op, value) {
    const ops: Record<string, string> = {
      $eq: '=', $ne: '!=', $gt: '>', $gte: '>=', $lt: '<', $lte: '<=',
    }
    if (ops[op]) return `${field} ${ops[op]} ${JSON.stringify(value)}`
    if (op === '$in') return `${field} IN (${(value as unknown[]).map(v => JSON.stringify(v)).join(', ')})`
    if (op === '$regex') return `${field} ~ ${value}`
    if (op === '$exists') return value ? `${field} IS NOT NULL` : `${field} IS NULL`
    return `${field} ${op} ${JSON.stringify(value)}`
  },
  and: (children) => children.join(' AND '),
  or: (children) => `(${children.join(' OR ')})`,
  not: (child) => `NOT (${child})`,
}

const where = walkFilter(query.filter, sqlVisitor)
// "age >= 18 AND age <= 30 AND status != \"DELETED\" AND role IN (\"Admin\", \"Editor\")"
```

### Visitor Interface

```ts
interface FilterVisitor<R> {
  /** Called for each field comparison (bare values normalized to $eq). */
  comparison(field: string, op: ComparisonOp, value: Primitive | Primitive[]): R

  /** Combine children with AND logic. */
  and(children: R[]): R

  /** Combine children with OR logic. */
  or(children: R[]): R

  /** Negate a child expression. */
  not(child: R): R

  /** Relational predicate `{ field: { $some | $none: operand } }` (optional). */
  relation?(field: string, op: RelationOp, operand: FilterExpr): R
}
```

`relation` receives the operand **unwalked**: it is a filter on another entity, so the visitor decides what to do with it — render a subquery, walk it with a visitor bound to the related table, prefix insights, and so on. A visitor without `relation` makes `walkFilter` throw `Relational predicate "$some" on "<field>" is not supported by this filter visitor` when a filter contains a predicate; filters without predicates never reach it.

### Walker Behavior

- Every member of a node is ANDed, in key order — comparison fields and logical keys alike. A field with several operators (`{ age: { $gte: 18, $lte: 30 } }`) contributes one `comparison` call per operator
- Bare primitive values (`{ name: 'John' }`) are normalized to `comparison(field, '$eq', value)` calls
- A single-member node returns its result unwrapped: `and()` is not called for `{ a: 1 }` or a lone `{ $or: [...] }`, but it is called with one child for `{ $and: [x] }`
- `$and` / `$or` recurse into their children and call `and(...)` / `or(...)`; `$not` recurses into its single child and calls `not(...)`
- Children are visited before their parent (depth-first, post-order)
- A logical key whose value is `undefined` is skipped
- An empty node calls `and([])`
- A `$some` / `$none` operator on a field calls `relation(field, op, operand)` once per operator; the walker does not descend into `operand`

## Lazy Insights

`computeInsights` walks an already-built query to produce a map of field names to the set of operators used on each field. This is the lazy counterpart to the eager insights computed during URL parsing:

```ts
import { computeInsights } from '@uniqu/core'

const insights = computeInsights(query.filter, query.controls)
// Map {
//   'age'       => Set { '$gte', '$lte' },
//   'status'    => Set { '$ne' },
//   'role'      => Set { '$in' },
//   'createdAt' => Set { '$order' },
//   'name'      => Set { '$select' },
//   'email'     => Set { '$select' },
//   'posts'     => Set { '$with' },
// }
```

Relation names from `$with` are captured with the `$with` insight operator. Nested `$with` insights bubble up to the parent with dot-notation prefixed field names, and each relation also carries its own scoped `insights`:

```ts
const controls: UniqueryControls = {
  $with: [
    {
      name: 'tasks',
      filter: {},
      controls: {
        $with: [
          { name: 'comments', filter: { body: { $regex: 'Great' } }, controls: {} },
        ],
      },
    },
  ],
}

const insights = computeInsights({}, controls)
// Map {
//   'tasks'               => Set { '$with' },
//   'tasks.comments'      => Set { '$with' },
//   'tasks.comments.body' => Set { '$regex' },
// }

// Each relation also has its own scoped insights:
// tasks.insights        => Map { 'comments' => Set { '$with' }, 'comments.body' => Set { '$regex' } }
// comments.insights     => Map { 'body' => Set { '$regex' } }
```

Relational predicates are captured the same way: the navigation field with its operator, and the operand's fields with the navigation-field prefix:

```ts
computeInsights({ ticket: { $some: { status: 'open', team: { $none: { name: 'x' } } } } })
// Map {
//   'ticket'           => Set { '$some' },
//   'ticket.status'    => Set { '$eq' },
//   'ticket.team'      => Set { '$none' },
//   'ticket.team.name' => Set { '$eq' },
// }
```

Use cases: field whitelisting, operator auditing, index planning, relation validation.

### `getInsights`

`getInsights` returns pre-computed insights when present on the query, or computes them lazily:

```ts
import { getInsights } from '@uniqu/core'

const insights = getInsights(query)
// Uses query.insights if present (e.g. from parseUrl), otherwise calls computeInsights
```

## API Reference

### Types

| Export | Description |
|--------|-------------|
| `Primitive` | `string \| number \| boolean \| null \| RegExp \| Date` |
| `ComparisonOp` | Union of all `$`-prefixed operator names |
| `FieldOpsFor<V>` | Per-field typed operator map |
| `FieldOps` | Untyped operator map (`FieldOpsFor<Primitive>`) |
| `FieldValue` | `Primitive \| FieldOps` |
| `FilterExpr<T, Nav>` | `ComparisonNode<T, Nav> \| LogicalNode<T, Nav>` |
| `ComparisonNode<T, Nav>` | Leaf node — keys constrained to `keyof T` when typed; typed `Nav` keys accept a `RelationPredicate` |
| `RelationOp` | `'$some' \| '$none'` |
| `RelationPredicate<E>` | `{ $some?, $none? }` — operands typed by `E`'s `__ownProps` / `__navProps` |
| `OwnOf<E>` / `NavOf<E>` | `E['__ownProps']` / `E['__navProps']`, or untyped / `{}` |
| `LogicalNode<T, Nav>` | `{ $and: ... } \| { $or: ... } \| { $not: ... }` — at most one logical key per object at the type level (the others are `never`); comparison fields may sit alongside it, and the runtime ANDs several logical keys |
| `AggregateFn` | `'sum' \| 'count' \| 'countDistinct' \| 'avg' \| 'min' \| 'max' \| 'first' \| 'last'` |
| `ArithExpr<N>` | Number literal, name, or `{ $op, $args }` node (`+ - * /`, unary `-`, `coalesce`) |
| `AggregateOfExpr` | `{ $fn: 'sum' \| 'avg' \| 'min' \| 'max', $expr, $as }`: aggregate over a per-row expression |
| `SelectArithExpr` | `{ $expr, $as }`: group-level arithmetic over aliases / `$groupBy` fields |
| `NumericKeys<T>` | Keys of `T` whose value is a number (optionally null / undefined) |
| `AggregateExpr<Fn, Field, Alias>` | `{ $fn, $field, $as? }` — aggregate function call in `$select`. Generic params preserve literal types for result inference |
| `SelectExpr<T>` | `((keyof T & string) \| AggregateExpr)[] \| Record<keyof T & string, 0 \| 1>` |
| `UniqueryControls<T>` | Pagination, sorting, projection, grouping, `$having` — `$select`/`$sort`/`$groupBy` constrained to `keyof T` when typed |
| `Uniquery<T>` | `{ name?, filter, controls, insights? }` — root query (no name) or nested relation (with name) |
| `TypedWithRelation<Nav>` | Typed `$with` entry — `keyof Nav & string` or object with typed filter/controls |
| `WithRelation` | Untyped `$with` relation with `{ name: string, filter?, controls?, insights? }` |
| `AggregateSelectExpr<D, M>` | Aggregate allowed in a typed `$select` — `count` over a measure or `'*'`, `countDistinct` over a dimension or measure, the rest over a measure |
| `AggregateControls<T, D, M>` | Typed aggregate controls — `$groupBy` required, `$with` forbidden, `$select` constrained to dimensions, `AggregateSelectExpr<D, M>` and buckets |
| `AggregateQuery<T, D, M>` | Typed aggregate query — `{ filter?, controls, insights? }` with dimension/measure constraints |
| `AggregateResult<T, Select>` | Infer result row type from `$select` — dimensions preserve original types, aggregates → `number` (min/max/first/last preserve field type), expressions → `number \| null` |
| `ResolveAlias<A>` | Resolve the output alias of an `AggregateExpr` — uses `$as` if provided, otherwise `{fn}_{field}` |
| `InsightOp` | `ComparisonOp \| RelationOp \| '$select' \| '$order' \| '$with' \| '$groupBy' \| '$having' \| AggregateFn \| string` |
| `UniqueryInsights` | `Map<string, Set<InsightOp>>` |

### Functions

| Export | Signature | Description |
|--------|-----------|-------------|
| `walkFilter` | `<R>(expr: FilterExpr, visitor: FilterVisitor<R>) => R` | Traverse filter tree with visitor callbacks |
| `computeInsights` | `(filter: FilterExpr, controls?: UniqueryControls) => UniqueryInsights` | Lazily compute field/operator usage map |
| `getInsights` | `(query: Uniquery) => UniqueryInsights` | Return pre-computed or lazily computed insights |
| `isPrimitive` | `(x: unknown) => x is Primitive` | Type guard for primitive values |
| `RELATION_OPS` | `readonly RelationOp[]` | `['$some', '$none']` (frozen) |
| `isRelationOp` | `(op: string) => op is RelationOp` | True for `$some` / `$none` |
| `isRelationPredicate` | `(value: unknown) => value is RelationPredicate` | True for a well-formed predicate: a non-empty plain object whose keys are all relation operators and whose operands are all plain objects (`{ $some: undefined }` and mixed maps are not) |
| `hasRelationOp` | `(value: unknown) => boolean` | True for an operator map carrying any `$some` / `$none` key, malformed or mixed. Like `walkFilter`, it treats a primitive, `RegExp`, `Date` or class instance as a value, never an operator map. `walkFilter` dispatches every such key to `relation`, so a gate should reject values where `hasRelationOp` holds but `isRelationPredicate` does not |
| `AGGREGATE_FNS` | `readonly AggregateFn[]` | The known aggregate function names |
| `isAggregateFn` | `(name: unknown) => name is AggregateFn` | True for a known aggregate function name |
| `ROW_ORDER_FNS` / `EXPR_AGGREGATE_FNS` | `readonly AggregateFn[]` | `['first', 'last']` (need `$rowOrder`) / `['sum', 'avg', 'min', 'max']` (accept `$expr`) |
| `parseArith` / `formatArith` | `(text) => ArithExpr` / `(expr, { encodePlus? }) => string` | The single arithmetic grammar, text ⇄ JSON |
| `arithNames` / `arithNullable` / `validateArith` | see [Arithmetic expressions](#arithmetic-expressions-arithexpr) | Names, nullability and schema-free validation (limits `ARITH_MAX_NODES` 64, `ARITH_MAX_DEPTH` 16) |
| `isAggregateOfExpr` / `isSelectArithExpr` | `(v: unknown) => v is …` | Type guards for the expression `$select` entries |
| `STAR_AGGREGATE_FNS` | `readonly AggregateFn[]` | Known functions that accept `'*'` as `$field` (`count`) |
| `validateAggregateExpr` | `(expr: AggregateExpr, opts?: { fns?: readonly string[] }) => AggregateExprCheck` | Schema-free aggregate check — `$fn` allow-list (when `fns` given) and the `'*'` rule; returns `{ ok: true }` or `{ ok: false, message }` |

## License

[MIT](../../LICENSE)
