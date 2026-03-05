# @uniqu/url

<p align="center">
  <img src="../../logo.svg" alt="uniqu" height="80">
</p>

URL query string parser that produces the [Uniqu](../../README.md) canonical query format. Human-readable URL syntax with full filter expressions, sorting, pagination, and projection.

## Install

```bash
pnpm add @uniqu/url
```

## Usage

```ts
import { parseUrl } from '@uniqu/url'

const { filter, controls, insights } = parseUrl(
  'age>=18&status!=DELETED&name~=/^Jo/i&$select=name,email&$limit=20'
)
```

**Result:**

```ts
filter = {
  age: { $gte: 18 },
  status: { $ne: 'DELETED' },
  name: { $regex: '/^Jo/i' },
}

controls = {
  $select: ['name', 'email'],
  $limit: 20,
}

insights = Map {
  'age'    => Set { '$gte' },
  'status' => Set { '$ne' },
  'name'   => Set { '$regex', '$select' },
  'email'  => Set { '$select' },
}
```

## Query Syntax

### Comparison Operators

| Syntax | Operator | Example | Result |
|--------|----------|---------|--------|
| `=` | `$eq` | `status=ACTIVE` | `{ status: 'ACTIVE' }` |
| `!=` | `$ne` | `status!=DELETED` | `{ status: { $ne: 'DELETED' } }` |
| `>` | `$gt` | `age>25` | `{ age: { $gt: 25 } }` |
| `>=` | `$gte` | `age>=18` | `{ age: { $gte: 18 } }` |
| `<` | `$lt` | `price<100` | `{ price: { $lt: 100 } }` |
| `<=` | `$lte` | `price<=99.99` | `{ price: { $lte: 99.99 } }` |
| `~=` | `$regex` | `name~=/^Jo/i` | `{ name: { $regex: '/^Jo/i' } }` |

### Lists (IN / NOT IN)

```
role{Admin,Editor}        → { role: { $in: ['Admin', 'Editor'] } }
status!{Draft,Deleted}    → { status: { $nin: ['Draft', 'Deleted'] } }
```

### Between

```
25<age<35     → { age: { $gt: 25, $lt: 35 } }
25<=age<=35   → { age: { $gte: 25, $lte: 35 } }
```

### Exists

```
$exists=phone,email       → { phone: { $exists: true }, email: { $exists: true } }
$!exists=deletedAt        → { deletedAt: { $exists: false } }
```

### Negation (NOT)

`!(...)` negates a grouped expression:

```
!(status=DELETED)
→ { $not: { status: 'DELETED' } }

!(age>18&status=active)
→ { $not: { age: { $gt: 18 }, status: 'active' } }

!(status=DELETED^status=ARCHIVED)
→ { $not: { $or: [{ status: 'DELETED' }, { status: 'ARCHIVED' }] } }
```

`$not` can be combined with other operators via `&` and `^`:

```
!(role{Guest,Anonymous})&age>=18
→ { $and: [{ $not: { role: { $in: ['Guest', 'Anonymous'] } } }, { age: { $gte: 18 } }] }
```

### Logical Operators

`&` is AND (higher precedence), `^` is OR (lower precedence). Parentheses override precedence:

```
age>25^score>550&status=VIP
→ { $or: [{ age: { $gt: 25 } }, { score: { $gt: 550 }, status: 'VIP' }] }

(age>25^score>550)&status=VIP
→ { $and: [{ $or: [{ age: { $gt: 25 } }, { score: { $gt: 550 } }] }, { status: 'VIP' }] }
```

Adjacent AND conditions on the same field are merged when safe:

```
age>=18&age<=30  → { age: { $gte: 18, $lte: 30 } }
```

### Literal Types

| Syntax | Type | Examples |
|--------|------|---------|
| Bare number | `number` | `42`, `-3.14`, `0` |
| Leading zero | `string` | `007`, `00`, `01` |
| `true` / `false` | `boolean` | `flag=true` |
| `null` | `null` | `deleted=null` |
| `'quoted'` | `string` | `name='John Doe'` |
| Bare word | `string` | `status=ACTIVE` |
| `/pattern/flags` | `string` | `name~=/^Jo/i` |

### Percent Encoding

All parts are decoded with `decodeURIComponent()` before parsing. Encode special characters in URLs:

```
name=%27John%20Doe%27  → name: 'John Doe'
name~=%2F%5EJo%2Fi     → name: { $regex: '/^Jo/i' }
```

## Control Keywords

Control keywords start with `$` and are separated from filter expressions:

| Keyword | Aliases | Example | Result |
|---------|---------|---------|--------|
| `$select` | — | `$select=name,email` | `{ $select: ['name', 'email'] }` |
| `$order` | `$sort` | `$order=-createdAt,score` | `{ $sort: { createdAt: -1, score: 1 } }` |
| `$limit` | `$top` | `$limit=20` | `{ $limit: 20 }` |
| `$skip` | — | `$skip=40` | `{ $skip: 40 }` |
| `$count` | — | `$count` | `{ $count: true }` |
| `$with` | — | `$with=posts,author` | `{ $with: [{ name: 'posts' }, { name: 'author' }] }` |
| `$<custom>` | — | `$search=term` | `{ $search: 'term' }` |

Prefix a field with `-` in `$select` to exclude it. When any exclusion is present, `$select` produces an object (`{ name: 1, password: 0 }`); otherwise it produces an array (`['name', 'email']`). Prefix with `-` in `$order` for descending sort.

### Relation Loading (`$with`)

`$with` declares which relations to populate alongside the primary query. Relations are comma-separated:

```
$with=posts,comments,author
```

#### Per-Relation Sub-Queries

Each relation can include an inline sub-query in parentheses. Inside the parens, the full query syntax applies — filters, controls, and nested `$with`:

```
$with=posts($sort=-createdAt&$limit=5&status=published)
```

This parses to:

```ts
controls.$with = [
  {
    name: 'posts',
    filter: { status: 'published' },
    $sort: { createdAt: -1 },
    $limit: 5,
  },
]
```

All controls are supported inside parens: `$sort`, `$limit`, `$skip`, `$select`, and nested `$with`.

#### Nested Relations

`$with` is recursive — relations can load their own sub-relations to any depth:

```
$with=posts($sort=-createdAt&$limit=5&$with=comments($limit=10&$with=author),tags)
```

This produces a tree:

```ts
controls.$with = [
  {
    name: 'posts',
    $sort: { createdAt: -1 },
    $limit: 5,
    $with: [
      { name: 'comments', $limit: 10, $with: [{ name: 'author' }] },
      { name: 'tags' },
    ],
  },
]
```

Inside each level of parens, `&` separates parameters and `,` separates sibling relations within `$with=`. The parser handles balanced parentheses correctly across nesting levels.

#### Combined Example

```
status=active&$with=posts($sort=-createdAt&$limit=5&$select=title,body&status=published),author
```

Produces:

```ts
{
  filter: { status: 'active' },
  controls: {
    $with: [
      {
        name: 'posts',
        filter: { status: 'published' },
        $sort: { createdAt: -1 },
        $limit: 5,
        $select: ['title', 'body'],
      },
      { name: 'author' },
    ],
  },
  insights: Map {
    'status' => Set { '$eq' },
    'posts'  => Set { '$with' },
    'author' => Set { '$with' },
  },
}
```

#### Edge Cases

| Case | Behavior |
|------|----------|
| `$with=posts,posts` | Deduplicated — one entry |
| `$with=` or `$with` | No relations (empty/omitted) |
| `$with=posts()` | Empty parens — same as `$with=posts` |
| Unknown relation names | Recorded as-is — consumer validates against its schema |

#### Consumer Responsibility

Uniqu parses and types the `$with` declaration. The consumer (e.g. a database adapter) is responsible for:

- **Execution strategy** — JOINs, subqueries, or separate queries
- **Relation validation** — checking that relation names exist on the entity
- **Circular reference detection** — preventing infinite `$with` chains
- **Depth limits** — restricting nesting depth for performance

## Insights

Insights are computed **eagerly** during URL parsing — a `Map<string, Set<InsightOp>>` recording which fields are used and with which operators. This includes both filter operators and control usage (`$select`, `$order`).

For queries constructed as JSON objects (not parsed from URL), use `computeInsights()` from `@uniqu/core` for **lazy** computation.

## Full Example

```
$select=firstName,-client.ssn
&$order=-createdAt,score
&$limit=50&$skip=10
&$count
&$with=posts($sort=-date&$limit=5&status=published),profile
&$exists=client.phone
&$!exists=deletedAt
&age>=18&age<=30
&status!=DELETED
&name~=/^Jo/i
&role{Admin,Editor}
&25<height<35
^score>550&price>50&price<100
```

Produces:

```ts
{
  filter: {
    $or: [
      {
        'client.phone': { $exists: true },
        deletedAt: { $exists: false },
        age: { $gte: 18, $lte: 30 },
        status: { $ne: 'DELETED' },
        name: { $regex: '/^Jo/i' },
        role: { $in: ['Admin', 'Editor'] },
        height: { $gt: 25, $lt: 35 },
      },
      {
        score: { $gt: 550 },
        price: { $gt: 50, $lt: 100 },
      },
    ],
  },
  controls: {
    $select: { firstName: 1, 'client.ssn': 0 },
    $sort: { createdAt: -1, score: 1 },
    $limit: 50,
    $skip: 10,
    $count: true,
    $with: [
      { name: 'posts', filter: { status: 'published' }, $sort: { date: -1 }, $limit: 5 },
      { name: 'profile' },
    ],
  },
}
```

## API Reference

### `parseUrl(raw: string): UrlQuery`

Parse a URL query string (without the leading `?`) into the uniqu format.

### `UrlQuery`

```ts
interface UrlQuery extends Uniquery {
  insights: UniqueryInsights
}
```

Narrows the optional `insights` field from `Uniquery` to required — insights are eagerly computed during URL parsing. Use `getInsights()` from `@uniqu/core` to transparently handle both URL-parsed queries (pre-computed) and manually constructed queries (lazy).

## License

[MIT](../../LICENSE)
