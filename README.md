<p align="center">
  <img src="./logo.svg" alt="uniqu" height="128">
</p>

# Uniqu

Canonical query representation for filters, sorting, pagination, and projection — agnostic to transport layer.

Uniqu defines a single intermediate format for queries that can be **parsed from** various sources (URL query strings, JSON objects, SQL-like clauses) and **rendered to** various targets (SQL WHERE, MongoDB filters, ORM queries) through adapter callbacks.

## Packages

| Package                          | Description                                            |
| -------------------------------- | ------------------------------------------------------ |
| [`@uniqu/core`](./packages/core) | Query format types, generic tree walker, lazy insights |
| [`@uniqu/url`](./packages/url)   | URL query string parser and builder for the uniqu format |

## Quick Example

```ts
import { parseUrl } from "@uniqu/url";
import { walkFilter } from "@uniqu/core";

// Parse a URL query string
const { filter, controls, insights } = parseUrl(
  "age>=18&status!=DELETED&name~=/^Jo/i&$select=name,email&$limit=20",
);

// filter   → { age: { $gte: 18 }, status: { $ne: 'DELETED' }, name: { $regex: '/^Jo/i' } }
// controls → { $select: ['name', 'email'], $limit: 20 }
// insights → Map { 'age' => Set { '$gte' }, 'status' => Set { '$ne' }, ... }

// Walk the filter tree with a custom visitor
const sql = walkFilter(filter, {
  comparison: (field, op, value) => `${field} ${op} ${JSON.stringify(value)}`,
  and: (children) => children.join(" AND "),
  or: (children) => `(${children.join(" OR ")})`,
  not: (child) => `NOT (${child})`,
});
```

## Type-safe Queries

Uniqu supports fully typed queries when you provide entity shapes:

```ts
import type { Uniquery, FilterExpr } from "@uniqu/core";

interface User {
  name: string;
  age: number;
  active: boolean;
}

// Only 'name', 'age', 'active' are valid filter keys
const filter: FilterExpr<User> = {
  name: "Alice",
  age: { $gte: 18 },
};

// Typed relations via Nav generic
interface UserNav {
  posts: { __ownProps: Post; __navProps: PostNav };
  profile: { __ownProps: Profile };
}

const query: Uniquery<User, UserNav> = {
  filter: { active: true },
  controls: {
    $limit: 10,
    // $with accepts strings (name-only) or objects (with sub-query)
    $with: [
      "profile",
      { name: "posts", filter: { published: true }, controls: { $limit: 5 } },
    ],
  },
};
```

When no generic is provided, any string key is accepted (untyped mode).

## Aggregation

Uniqu supports aggregate queries with `$groupBy` and aggregate functions in `$select`:

```ts
import { parseUrl } from "@uniqu/url";

const { controls, insights } = parseUrl(
  "$select=sum(amount):total,currency&$groupBy=currency&$sort=-total&$limit=10",
);

// controls → {
//   $select: [
//     { $fn: 'sum', $field: 'amount', $as: 'total' },
//     'currency',
//   ],
//   $groupBy: ['currency'],
//   $sort: { total: -1 },
//   $limit: 10,
// }

// insights → Map {
//   'amount'   => Set { 'sum' },
//   'currency' => Set { '$select', '$groupBy' },
//   'total'    => Set { '$order' },
// }
```

Aggregate functions (`sum`, `count`, `avg`, `min`, `max`) appear as `AggregateExpr` objects in `$select`. The `$fn` field accepts any string for extensibility — consumers validate supported functions.

## URL Builder

Build URL query strings from `Uniquery` objects — the inverse of `parseUrl`. Available as a separate entry point for optimal bundle size in UI apps:

```ts
import { buildUrl } from "@uniqu/url/builder";

const url = buildUrl({
  filter: { status: "active", age: { $gte: 18 } },
  controls: {
    $select: ["name", "email"],
    $sort: { createdAt: -1 },
    $limit: 20,
    $with: ["profile"],
  },
});
// → "status=active&age>=18&$select=name,email&$sort=-createdAt&$limit=20&$with=profile"
```

Round-trips with `parseUrl`: `parseUrl(buildUrl(query))` reproduces the original query.

## Architecture

```
  URL string ──→ @uniqu/url ──→ Uniquery ──→ @uniqu/url/builder ──→ URL string
                                    │
                        ┌───────────┼───────────┐
                        ▼           ▼           ▼
                   walkFilter  computeInsights  (future adapters)
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
         SQL WHERE          MongoDB filter
        (via visitor)       (via visitor)
```

The core package defines the canonical `FilterExpr` tree and provides tools to traverse it. `@uniqu/url` parses URL query strings into this format and builds them back. Adapter packages (future) render it to target query languages via the `walkFilter` visitor pattern.

## Development

```bash
pnpm install
pnpm build        # types + bundles for all packages
pnpm test         # run all tests
pnpm lint         # oxlint
pnpm fmt          # oxfmt
```

## License

[MIT](./LICENSE)
