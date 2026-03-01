# Uniqu

<p align="center">
  <img src="./logo.svg" alt="uniqu" height="80">
</p>

Canonical query representation for filters, sorting, pagination, and projection — agnostic to transport layer.

Uniqu defines a single intermediate format for queries that can be **parsed from** various sources (URL query strings, JSON objects, SQL-like clauses) and **rendered to** various targets (SQL WHERE, MongoDB filters, ORM queries) through adapter callbacks.

## Packages

| Package | Description |
|---------|-------------|
| [`@uniqu/core`](./packages/core) | Query format types, generic tree walker, lazy insights |
| [`@uniqu/url`](./packages/url) | URL query string parser producing the uniqu format |

## Quick Example

```ts
import { parseUrl } from '@uniqu/url'
import { walkFilter, computeInsights } from '@uniqu/core'

// Parse a URL query string
const { filter, controls, insights } = parseUrl(
  'age>=18&status!=DELETED&name~=/^Jo/i&$select=name,email&$limit=20'
)

// filter   → { age: { $gte: 18 }, status: { $ne: 'DELETED' }, name: { $regex: '/^Jo/i' } }
// controls → { $select: ['name', 'email'], $limit: 20 }
// insights → Map { 'age' => Set { '$gte' }, 'status' => Set { '$ne' }, ... }

// Walk the filter tree with a custom visitor
const sql = walkFilter(filter, {
  comparison: (field, op, value) => `${field} ${op} ${JSON.stringify(value)}`,
  and: (children) => children.join(' AND '),
  or: (children) => `(${children.join(' OR ')})`,
  not: (child) => `NOT (${child})`,
})
```

## Architecture

```
  URL string ──→ @uniqu/url ──→ Uniquery ←── JSON (manual construction)
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

The core package defines the canonical `FilterExpr` tree and provides tools to traverse it. Transport-specific packages (like `@uniqu/url`) parse input into this format. Adapter packages (future) render it to target query languages via the `walkFilter` visitor pattern.

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
