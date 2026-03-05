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

A `FilterExpr` is either a **comparison node** (leaf) or a **logical node** (branch):

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
| `$select` | `string[] \| Record<string, 0 \| 1>` | Field projection — array for inclusion, object for exclusion/mixed |
| `$with` | `WithRelation[]` | Relations to populate alongside the primary query |
| `$<custom>` | `unknown` | Arbitrary pass-through keywords |

### Relation Loading (`$with`)

`$with` declares which relations to populate alongside the primary query. Each relation is a full `Uniquery` sub-query (a `WithRelation`) with its own `name`, `filter`, `controls`, and `insights`:

```ts
import type { Uniquery, WithRelation } from '@uniqu/core'

const query: Uniquery = {
  filter: { status: 'active' },
  controls: {
    $with: [
      {
        name: 'posts',
        filter: { status: 'published' },
        controls: {
          $sort: { createdAt: -1 },
          $limit: 5,
          $select: ['title', 'body'],
          $with: [
            { name: 'comments', filter: {}, controls: { $limit: 10 } },
            { name: 'author', filter: {}, controls: {} },
          ],
        },
      },
      { name: 'profile', filter: {}, controls: {} },
    ],
  },
}
```

`WithRelation` is a `Uniquery` with a required `name`:

```ts
type WithRelation = Uniquery & { name: string }
```

The `Uniquery` type itself has an optional `name` — when present it is a nested relation, when absent it is the root query. This means every `$with` entry is a self-contained query with its own `filter`, `controls` (including `$sort`, `$skip`, `$limit`, `$select`, nested `$with`, and pass-through keywords), and optional `insights`. The structure is recursive to any depth.

Uniqu is a query parser, not an ORM. It records what was requested — the consumer (e.g. a database adapter) decides how to execute it (JOINs, subqueries, separate queries), validates relation names against its schema, and enforces depth/security limits.

## Type-Safe Filters

`FilterExpr<T>` accepts a generic entity type for compile-time field and value checking. Dot-notation paths are always allowed for nested access:

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
  'address.city': 'NYC',     // dot-notation — always allowed
  // age: { $gte: 'old' },   // type error: string not assignable to number
}
```

Without a generic argument, `FilterExpr` accepts any string keys with any values (untyped mode).

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
}
```

### Walker Behavior

- Bare primitive values (`{ name: 'John' }`) are normalized to `comparison(field, '$eq', value)` calls
- Multi-field comparison nodes (`{ age: ..., status: ... }`) are expanded into individual `comparison` calls wrapped in `visitor.and(...)`
- `$and` / `$or` nodes recurse into children and call the corresponding visitor method
- `$not` nodes recurse into the single child and call `visitor.not(...)`
- Empty nodes call `visitor.and([])`

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
| `FilterExpr<T>` | `ComparisonNode<T> \| LogicalNode<T>` |
| `ComparisonNode<T>` | Leaf node with typed field comparisons |
| `LogicalNode<T>` | `{ $and: ... } \| { $or: ... } \| { $not: ... }` — variants are mutually exclusive via `never` |
| `UniqueryControls<T>` | Pagination, sorting, projection — `$select`/`$sort` constrained to `keyof T` when typed |
| `Uniquery<T>` | `{ name?, filter, controls, insights? }` — root query (no name) or nested relation (with name) |
| `WithRelation` | `Uniquery & { name: string }` — a `$with` relation with a required name |
| `InsightOp` | `ComparisonOp \| '$select' \| '$order' \| '$with'` |
| `UniqueryInsights` | `Map<string, Set<InsightOp>>` |

### Functions

| Export | Signature | Description |
|--------|-----------|-------------|
| `walkFilter` | `<R>(expr: FilterExpr, visitor: FilterVisitor<R>) => R` | Traverse filter tree with visitor callbacks |
| `computeInsights` | `(filter: FilterExpr, controls?: UniqueryControls) => UniqueryInsights` | Lazily compute field/operator usage map |
| `getInsights` | `(query: Uniquery) => UniqueryInsights` | Return pre-computed or lazily computed insights |
| `isPrimitive` | `(x: unknown) => x is Primitive` | Type guard for primitive values |

## License

[MIT](../../LICENSE)
