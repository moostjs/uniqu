# @uniqu/url

<p align="center">
  <img src="../../logo.svg" alt="uniqu" height="80">
</p>

URL query string parser and builder for the [Uniqu](../../README.md) canonical query format. Human-readable URL syntax with full filter expressions, sorting, pagination, projection, and aggregation.

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

Comparison fields and a logical operator in the same filter object are ANDed
together (see the [`@uniqu/core` README](../core/README.md#filter-expressions)),
so `buildUrl` emits them `&`-joined and parenthesizes an `$or` that has
siblings: `{ id: 101, $or: [{ s: 'a' }, { s: 'b' }] }` → `id=101&(s=a^s=b)`.
Conversely, a multi-part AND inside an `$or` is always parenthesized, whether
it is an explicit `$and` or an implicit one:
`{ $or: [{ $and: [{ a: 1 }, { b: 2 }] }, { c: 3 }] }` → `(a=1&b=2)^c=3`.

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
$search=Maison%20%26%20O%27Brien%20%231  → $search: "Maison & O'Brien #1"
```

A `$with` relation body is itself a query string, so it is decoded once more when parsed: a value inside a body needs one more level of encoding than at the top (`$with=posts(name='50%2525')` → `'50%'`). Building a `$with` value with `URLSearchParams` or `encodeURIComponent` produces exactly that. A body segment that is not valid percent-encoding at that second decode is kept as written, so a hand-written `$with=posts(name='50%25')` also yields `'50%'`.

## Control Keywords

Control keywords start with `$` and are separated from filter expressions:

| Keyword | Aliases | Example | Result |
|---------|---------|---------|--------|
| `$select` | — | `$select=name,email` | `{ $select: ['name', 'email'] }` |
| `$order` | `$sort` | `$order=-createdAt,score` | `{ $sort: { createdAt: -1, score: 1 } }` |
| `$limit` | `$top` | `$limit=20` | `{ $limit: 20 }` |
| `$skip` | — | `$skip=40` | `{ $skip: 40 }` |
| `$count` | — | `$count` | `{ $count: true }` |
| `$groupBy` | — | `$groupBy=currency,region` | `{ $groupBy: ['currency', 'region'] }` |
| `$having` | — | `$having=total>1000` | `{ $having: { total: { $gt: 1000 } } }` |
| `$with` | — | `$with=posts,author` | `{ $with: [{ name: 'posts', filter: {}, controls: {} }, ...] }` |
| `$<custom>` | — | `$search=term` | `{ $search: 'term' }` |

Prefix a field with `-` in `$select` to exclude it. When any exclusion is present, `$select` produces an object (`{ name: 1, password: 0 }`); otherwise it produces an array (`['name', 'email']`). Prefix with `-` in `$order` for descending sort.

### Aggregate Functions in `$select`

`$select` supports aggregate function calls using `fn(field)` syntax. An optional alias can be specified with `:alias`:

```
$select=sum(amount)                → [{ $fn: 'sum', $field: 'amount', $as: 'sum_amount' }]
$select=sum(amount):total          → [{ $fn: 'sum', $field: 'amount', $as: 'total' }]
$select=count(*)                   → [{ $fn: 'count', $field: '*', $as: 'count_star' }]
$select=sum(amount),currency       → [{ $fn: 'sum', $field: 'amount', $as: 'sum_amount' }, 'currency']
```

When no alias is given, one is auto-generated as `{fn}_{field}` (with `*` becoming `star`).

Supported functions: `sum`, `count`, `avg`, `min`, `max`, plus any custom function name — consumers validate supported functions.

When aggregates are present, `$select` always uses the array form (even if `-` prefixed fields are mixed in). Entries keep their URL order.

### Calendar Buckets in `$select`

`bucket(field,unit[,tz][,weekStart])[:alias]` groups a timestamp field by calendar day, week, month, quarter or year — see [calendar buckets](../core/README.md#calendar-buckets-bucketexpr) for units, zones and the `YYYY-MM-DD` label the server returns. Group, sort and filter by its alias:

```
$select=bucket(openedAt,week,'Europe/Berlin',sun):week,status,count(*):n
  &$groupBy=week,status&$having=week>='2026-03-01'&$sort=week
```

```
bucket(openedAt,day)                              → { $bucket: 'day', $field: 'openedAt', $as: 'day_openedAt' }
bucket(openedAt,day,'Europe/Berlin'):day          → { $bucket: 'day', $field: 'openedAt', $tz: 'Europe/Berlin', $as: 'day' }
bucket(openedAt,week,'America/New_York',sun):wk   → { $bucket: 'week', …, $tz: 'America/New_York', $weekStart: 'sun', $as: 'wk' }
bucket(openedAt,week,,sun)                        → default zone (UTC), Sunday weeks
```

- The zone is quoted when it contains `/` (`UTC` may be bare); an empty slot means the default zone.
- Without an alias it is `{unit}_{field}`; a dotted field (`stats.firstSeenAt`) needs an explicit `:alias`.
- `bucket` is a reserved name: `bucket(…)` always parses as a bucket, never as a custom aggregate, and a one-argument `bucket(x)` is malformed (`SyntaxError`).
- Parsing is syntactic only: an unknown unit, week start or zone passes through for the server to reject with a precise message. Malformed syntax — unbalanced parens, a missing field or unit, more than four arguments — throws.

### Grouping (`$groupBy`)

`$groupBy` declares which fields to group by. Comma-separated:

```
$groupBy=currency           → ['currency']
$groupBy=currency,region    → ['currency', 'region']
```

#### Aggregation Example

```
$select=sum(amount):total,count(*),currency&$groupBy=currency&$sort=-total&$limit=10
```

Produces:

```ts
{
  controls: {
    $select: [
      'currency',
      { $fn: 'sum', $field: 'amount', $as: 'total' },
      { $fn: 'count', $field: '*', $as: 'count_star' },
    ],
    $groupBy: ['currency'],
    $sort: { total: -1 },
    $limit: 10,
  },
  insights: Map {
    'amount'   => Set { 'sum' },
    '*'        => Set { 'count' },
    'currency' => Set { '$select', '$groupBy' },
    'total'    => Set { '$order' },
  },
}
```

Insights track aggregate functions with bare names (`'sum'`, `'count'`), distinct from `$`-prefixed control ops (`'$select'`, `'$groupBy'`).

Aggregates and `$groupBy` work inside `$with` sub-queries too:

```
$with=orders($select=sum(total):revenue&$groupBy=status)
```

### Post-Aggregation Filter (`$having`)

`$having` filters groups after aggregation (SQL `HAVING`). It accepts the same filter expression syntax as the main query:

```
$having=total>1000                          → { $having: { total: { $gt: 1000 } } }
$having=total>1000&$having=count_star>=5    → { $having: { $and: [...] } }   (AND-merged)
$having=total>1000^avg_price<50             → { $having: { $or: [...] } }    (OR via ^)
$having=!(total<100)                        → { $having: { $not: {...} } }   (NOT via !())
```

For multi-condition `$having` with AND, either use multiple `$having` params (AND-merged automatically) or wrap in parentheses:

```
$having=(total>1000&count_star>=5)
```

`$having` works inside `$with` sub-queries:

```
$with=orders($select=sum(total):revenue&$groupBy=status&$having=revenue>500)
```

Insights track `$having` fields with the `'$having'` op.

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
    controls: { $sort: { createdAt: -1 }, $limit: 5 },
  },
]
```

Each relation is a full `Uniquery` sub-query with its own `filter`, `controls`, and `insights`. All controls are supported inside parens: `$sort`, `$limit`, `$skip`, `$select`, `$count`, and nested `$with`.

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
    filter: {},
    controls: {
      $sort: { createdAt: -1 },
      $limit: 5,
      $with: [
        {
          name: 'comments',
          filter: {},
          controls: {
            $limit: 10,
            $with: [{ name: 'author', filter: {}, controls: {} }],
          },
        },
        { name: 'tags', filter: {}, controls: {} },
      ],
    },
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
        controls: {
          $sort: { createdAt: -1 },
          $limit: 5,
          $select: ['title', 'body'],
        },
        insights: Map { 'status' => Set { '$eq' }, ... },
      },
      { name: 'author', filter: {}, controls: {} },
    ],
  },
  insights: Map {
    'status' => Set { '$eq' },
    'posts'  => Set { '$with' },
    'posts.status' => Set { '$eq' },
    'author' => Set { '$with' },
  },
}
```

Each `$with` relation carries its own scoped `insights`, and nested insights bubble up to the root with dot-notation prefixed field names.

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

Insights are computed **eagerly** during URL parsing — a `Map<string, Set<InsightOp>>` recording which fields are used and with which operators. This includes filter operators, control usage (`$select`, `$order`, `$groupBy`), and aggregate functions (`sum`, `avg`, etc. — bare names without `$` prefix).

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
      {
        name: 'posts',
        filter: { status: 'published' },
        controls: { $sort: { date: -1 }, $limit: 5 },
      },
      { name: 'profile', filter: {}, controls: {} },
    ],
  },
}
```

## URL Builder

Build URL query strings from `Uniquery` objects — the inverse of `parseUrl`. Available as a separate entry point for optimal bundle size:

```ts
import { buildUrl } from '@uniqu/url/builder'
```

### Usage

```ts
const url = buildUrl({
  filter: { status: 'active', age: { $gte: 18 } },
  controls: {
    $select: ['name', 'email'],
    $sort: { createdAt: -1 },
    $limit: 20,
  },
})
// → "status=active&age>=18&$select=name,email&$sort=-createdAt&$limit=20"
```

### `buildUrl(query: Uniquery): string`

Accepts a `Uniquery` object and returns a URL query string (without leading `?`).

All features are supported:
- Filter expressions (comparisons, `$and`/`$or`/`$not`, `$in`/`$nin`, `$exists`, `$regex`)
- Controls (`$select`, `$sort`, `$limit`, `$skip`, `$count`, `$groupBy`, `$having`, `$with`)
- Aggregates in `$select` (`sum(amount):total`)
- Nested `$with` sub-queries
- Pass-through custom `$`-prefixed controls

### Value serialization

- Strings that look like numbers, booleans, or `null` are automatically quoted (`'25'`, `'true'`, `'null'`)
- Strings with special characters (`&`, `^`, `=`, spaces, quotes) are quoted and escaped; inside quotes `%`, `&`, `(`, `)`, `#`, tab and line breaks are percent-encoded, so no value can end a segment or unbalance a paren group
- Custom control values (`$search`, `$relevance`, any `$<custom>`) are percent-encoded for the same characters plus `'` — `"Maison & O'Brien #1"` becomes `$search=Maison %26 O%27Brien %231`. Up to 0.1.8 they were written raw, so a search term containing `&`, `%` or `'` broke the URL
- A `$with` body gets one extra level of `%` encoding, matching the extra decode on parse
- Calendar buckets are written as `bucket(field,unit[,tz][,weekStart]):alias`, always with the alias
- Leading-zero numbers (`007`) stay as bare strings
- `Date` values are serialized as quoted ISO strings
- `RegExp` values are serialized as `/pattern/flags`

### Round-tripping

`buildUrl` produces output compatible with `parseUrl`:

```ts
import { parseUrl } from '@uniqu/url'
import { buildUrl } from '@uniqu/url/builder'

const query = { filter: { age: { $gte: 18 } }, controls: { $limit: 10 } }
const url = buildUrl(query)
const parsed = parseUrl(url)
// parsed.filter → { age: { $gte: 18 } }
// parsed.controls.$limit → 10
```

Round-trips are semantic, not structural: `parseUrl` returns the canonical
explicit-`$and` form, with logical branches first and the merged comparison
fields last, so `{ id: 101, $or: [...] }` comes back as
`{ $and: [{ $or: [...] }, { id: 101 }] }`. Likewise an explicit `$and` inside
an `$or` is emitted parenthesized (`(a=1&b=2)^c=3`), which parses to the same
tree as the unparenthesized form.

### Bundle optimization

The builder is a separate entry point (`@uniqu/url/builder`) so that apps using only `buildUrl` don't pull in the lexer and parser code, and vice versa.

## API Reference

### `parseUrl(raw: string): UrlQuery`

Parse a URL query string (without the leading `?`) into the uniqu format.

### `buildUrl(query: Uniquery): string`

Build a URL query string from a `Uniquery` object. Imported from `@uniqu/url/builder`.

### `UrlQuery`

```ts
interface UrlQuery extends Uniquery {
  insights: UniqueryInsights
}
```

Narrows the optional `insights` field from `Uniquery` to required — insights are eagerly computed during URL parsing. Use `getInsights()` from `@uniqu/core` to transparently handle both URL-parsed queries (pre-computed) and manually constructed queries (lazy).

## License

[MIT](../../LICENSE)
