import { describe, it, expect } from 'vitest'
import { buildUrl } from './builder'
import { parseUrl } from './parse-url'
import { resolveAlias } from '@uniqu/core'
import type { BucketExpr, Uniquery, WithRelation } from '@uniqu/core'

/** The query string a server sees after a real WHATWG URL parse (`fetch`, the address bar, `req.url`). */
const viaRealUrl = (qs: string) => new URL('http://host/path?' + qs).search.slice(1)
const roundTrip = (query: Uniquery) => parseUrl(buildUrl(query))
const roundTripViaUrl = (query: Uniquery) => parseUrl(viaRealUrl(buildUrl(query)))

describe('buildUrl', () => {
  it('empty query', () => {
    expect(buildUrl({})).toBe('')
  })

  it('simple equality filter', () => {
    expect(buildUrl({ filter: { name: 'Alice' } })).toBe('name=Alice')
  })

  it('numeric filter value', () => {
    expect(buildUrl({ filter: { age: 25 } })).toBe('age=25')
  })

  it('boolean filter value', () => {
    expect(buildUrl({ filter: { active: true } })).toBe('active=true')
  })

  it('null filter value', () => {
    expect(buildUrl({ filter: { deleted: null } })).toBe('deleted=null')
  })

  it('comparison operators', () => {
    const url = buildUrl({ filter: { age: { $gte: 18, $lte: 30 } } })
    expect(url).toContain('age>=18')
    expect(url).toContain('age<=30')
  })

  it('not-equal operator', () => {
    expect(buildUrl({ filter: { status: { $ne: 'DELETED' } } })).toBe('status!=DELETED')
  })

  it('greater/less operators', () => {
    expect(buildUrl({ filter: { age: { $gt: 18 } } })).toBe('age>18')
    expect(buildUrl({ filter: { age: { $lt: 65 } } })).toBe('age<65')
  })

  it('regex operator', () => {
    expect(buildUrl({ filter: { name: { $regex: '/^Jo/i' } } })).toBe("name~='/^Jo/i'")
  })

  it('$in list', () => {
    expect(buildUrl({ filter: { role: { $in: ['Admin', 'Editor'] } } })).toBe('role{Admin,Editor}')
  })

  it('$nin list', () => {
    expect(buildUrl({ filter: { status: { $nin: ['Draft', 'Deleted'] } } })).toBe('status!{Draft,Deleted}')
  })

  it('$exists true', () => {
    expect(buildUrl({ filter: { email: { $exists: true } } })).toBe('$exists=email')
  })

  it('$exists false', () => {
    expect(buildUrl({ filter: { deletedAt: { $exists: false } } })).toBe('$!exists=deletedAt')
  })

  it('$or logical', () => {
    const url = buildUrl({ filter: { $or: [{ age: { $gt: 25 } }, { status: 'VIP' }] } })
    expect(url).toBe('age>25^status=VIP')
  })

  it('$and logical', () => {
    const url = buildUrl({ filter: { $and: [{ age: { $gte: 18 } }, { status: 'active' }] } })
    expect(url).toBe('age>=18&status=active')
  })

  it('$not logical', () => {
    expect(buildUrl({ filter: { $not: { status: 'DELETED' } } })).toBe('!(status=DELETED)')
  })

  it('$or inside $and is parenthesized', () => {
    const url = buildUrl({
      filter: {
        $and: [
          { $or: [{ category: 'electronics' }, { category: 'clothing' }] },
          { createdAt: 0 },
        ],
      },
    })
    expect(url).toBe('(category=electronics^category=clothing)&createdAt=0')
  })

  it('explicit $and inside $or is grouped like an implicit one', () => {
    // `&` binds tighter than `^`, so `a=1&b=2^c=3` would parse to the same
    // tree — but a multi-part AND inside an $or is always parenthesized,
    // whether it is an explicit $and or an implicit one (`{ b: 2, c: 3 }`),
    // so both spell the same way.
    const url = buildUrl({
      filter: {
        $or: [
          { $and: [{ a: 1 }, { b: 2 }] },
          { c: 3 },
        ],
      },
    })
    expect(url).toBe('(a=1&b=2)^c=3')
  })

  it('multi-field comparison child inside $or is parenthesized', () => {
    const url = buildUrl({
      filter: {
        $or: [{ status: 'A' }, { status: 'B', tier: 'gold' }],
      },
    })
    expect(url).toBe('status=A^(status=B&tier=gold)')
  })

  it('single-field multi-operator child inside $or is parenthesized', () => {
    const url = buildUrl({
      filter: {
        $or: [{ age: { $gte: 18, $lte: 30 } }, { role: 'admin' }],
      },
    })
    expect(url).toBe('(age>=18&age<=30)^role=admin')
  })

  it('mixed comparison + $or node groups the $or', () => {
    const url = buildUrl({
      filter: {
        id: 101,
        nextRefreshAt: { $lte: 1000 },
        $or: [{ status: 'a' }, { status: 'b' }],
      },
    })
    expect(url).toBe('id=101&nextRefreshAt<=1000&(status=a^status=b)')
  })

  it('mixed comparison + $and node inlines the $and members', () => {
    const url = buildUrl({ filter: { a: 1, $and: [{ b: 2 }, { c: 3 }] } })
    expect(url).toBe('a=1&b=2&c=3')
  })

  it('mixed comparison + $not node', () => {
    const url = buildUrl({ filter: { a: 1, $not: { status: 'DELETED' } } })
    expect(url).toBe('a=1&!(status=DELETED)')
  })

  it('mixed node inside an $or is grouped as a whole', () => {
    const url = buildUrl({
      filter: { $or: [{ x: 9 }, { a: 1, $or: [{ b: 2 }, { c: 3 }] }] },
    })
    expect(url).toBe('x=9^(a=1&(b=2^c=3))')
  })

  it('logical key with undefined value is skipped', () => {
    const url = buildUrl({ filter: { a: 1, $and: undefined } as Uniquery['filter'] })
    expect(url).toBe('a=1')
  })

  it('quotes string values that look like numbers', () => {
    expect(buildUrl({ filter: { code: '25' } })).toBe("code='25'")
  })

  it('quotes string values that look like booleans', () => {
    expect(buildUrl({ filter: { flag: 'true' } })).toBe("flag='true'")
  })

  it('quotes string values that look like null', () => {
    expect(buildUrl({ filter: { note: 'null' } })).toBe("note='null'")
  })

  it('escapes quotes in string values', () => {
    expect(buildUrl({ filter: { name: "John's" } })).toBe("name='John\\'s'")
  })

  it('quotes string with spaces', () => {
    expect(buildUrl({ filter: { name: 'John Doe' } })).toBe("name='John Doe'")
  })

  it('leading-zero number stays as bare string', () => {
    expect(buildUrl({ filter: { code: '007' } })).toBe('code=007')
  })

  it('multiple fields in comparison node', () => {
    const url = buildUrl({ filter: { name: 'Alice', age: 30 } })
    expect(url).toBe('name=Alice&age=30')
  })

  it('quotes string with ampersand (and percent-encodes the `&`)', () => {
    // parseUrl splits on `&` before decoding and ignores quotes, so a literal
    // `&` inside the quoted value would cut it at the split.
    expect(buildUrl({ filter: { name: 'A&B' } })).toBe("name='A%26B'")
  })

  it('quotes string with caret (OR)', () => {
    expect(buildUrl({ filter: { name: 'A^B' } })).toBe("name='A^B'")
  })

  it('quotes string with equals sign', () => {
    expect(buildUrl({ filter: { name: 'a=b' } })).toBe("name='a=b'")
  })

  it('quotes string with exclamation mark', () => {
    expect(buildUrl({ filter: { name: 'a!b' } })).toBe("name='a!b'")
  })

  it('quotes string with angle brackets', () => {
    expect(buildUrl({ filter: { name: 'a<b' } })).toBe("name='a<b'")
    expect(buildUrl({ filter: { name: 'a>b' } })).toBe("name='a>b'")
  })

  it('quotes string with tilde', () => {
    expect(buildUrl({ filter: { name: 'a~b' } })).toBe("name='a~b'")
  })

  it('quotes string with parentheses (and percent-encodes them)', () => {
    // parseUrl's top-level split tracks paren depth without regard to quotes,
    // so an unbalanced paren inside a value would swallow following parts.
    expect(buildUrl({ filter: { name: 'a(b)' } })).toBe("name='a%28b%29'")
  })

  it('quotes string with curly braces', () => {
    expect(buildUrl({ filter: { name: 'a{b}' } })).toBe("name='a{b}'")
  })

  it('quotes string with comma', () => {
    expect(buildUrl({ filter: { name: 'a,b' } })).toBe("name='a,b'")
  })

  it('escapes backslash inside quoted string', () => {
    expect(buildUrl({ filter: { path: 'a\\b' } })).toBe("path='a\\\\b'")
  })

  it('escapes both backslash and quote', () => {
    expect(buildUrl({ filter: { val: "it\\'s" } })).toBe("val='it\\\\\\'s'")
  })

  it('Date values serialize as quoted ISO string', () => {
    const d = new Date('2026-01-15T12:00:00.000Z')
    expect(buildUrl({ filter: { created: d as unknown as string } })).toBe("created='2026-01-15T12:00:00.000Z'")
  })

  it('RegExp values serialize as /pattern/flags', () => {
    expect(buildUrl({ filter: { name: { $regex: '/^test/gi' } } })).toBe("name~='/^test/gi'")
  })

  it('RegExp object in $regex', () => {
    expect(buildUrl({ filter: { name: { $regex: /^Ali/i } } })).toBe("name~='/^Ali/i'")
  })

  it('RegExp as direct field value', () => {
    expect(buildUrl({ filter: { name: /^Ali/i } as any })).toBe("name~='/^Ali/i'")
  })

  it('$or with regex fields', () => {
    const url = buildUrl({
      filter: {
        $or: [
          { firstName: { $regex: '/^Ali/i' } },
          { email: { $regex: '/^Ali/i' } },
          { id: 1 },
        ],
      },
    })
    expect(url).toBe("firstName~='/^Ali/i'^email~='/^Ali/i'^id=1")
  })
})

describe('buildUrl – controls', () => {
  it('$select inclusion array', () => {
    expect(buildUrl({ controls: { $select: ['name', 'email'] } })).toBe('$select=name,email')
  })

  it('$select exclusion object', () => {
    expect(buildUrl({ controls: { $select: { name: 1, password: 0 } } })).toBe('$select=name,-password')
  })

  it('$sort ascending and descending', () => {
    expect(buildUrl({ controls: { $sort: { createdAt: -1, name: 1 } } })).toBe('$sort=-createdAt,name')
  })

  it('$limit', () => {
    expect(buildUrl({ controls: { $limit: 20 } })).toBe('$limit=20')
  })

  it('$skip', () => {
    expect(buildUrl({ controls: { $skip: 40 } })).toBe('$skip=40')
  })

  it('$count', () => {
    expect(buildUrl({ controls: { $count: true } })).toBe('$count')
  })

  it('$groupBy', () => {
    expect(buildUrl({ controls: { $groupBy: ['currency', 'region'] } })).toBe('$groupBy=currency,region')
  })

  it('aggregate in $select with alias', () => {
    const url = buildUrl({
      controls: { $select: ['currency', { $fn: 'sum', $field: 'amount', $as: 'total' }] },
    })
    expect(url).toBe('$select=currency,sum(amount):total')
  })

  it('aggregate without alias', () => {
    const url = buildUrl({
      controls: { $select: [{ $fn: 'count', $field: '*' }] },
    })
    expect(url).toBe('$select=count(*)')
  })

  it('$with string shorthand', () => {
    expect(buildUrl({ controls: { $with: ['posts', 'profile'] } })).toBe('$with=posts,profile')
  })

  it('$with with sub-query', () => {
    const url = buildUrl({
      controls: {
        $with: [{
          name: 'posts',
          filter: { status: 'published' },
          controls: { $sort: { createdAt: -1 }, $limit: 5 },
        }],
      },
    })
    expect(url).toBe('$with=posts(status=published&$sort=-createdAt&$limit=5)')
  })

  it('$with empty sub-query omits parens', () => {
    const url = buildUrl({ controls: { $with: [{ name: 'profile', filter: {}, controls: {} }] } })
    expect(url).toBe('$with=profile')
  })

  it('pass-through custom control', () => {
    const url = buildUrl({ controls: { $search: 'term' } as Uniquery['controls'] })
    expect(url).toBe('$search=term')
  })

  it('all controls combined', () => {
    const url = buildUrl({
      controls: {
        $select: ['name', 'email'],
        $sort: { createdAt: -1 },
        $limit: 50,
        $skip: 10,
        $count: true,
      },
    })
    expect(url).toBe('$select=name,email&$sort=-createdAt&$limit=50&$skip=10&$count')
  })
})

describe('buildUrl – aggregation', () => {
  it('full aggregation query', () => {
    const url = buildUrl({
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
    })
    expect(url).toBe(
      '$select=currency,sum(amount):total,count(*):count&$groupBy=currency&$sort=-total&$limit=10',
    )
  })

  it('$having single condition', () => {
    const url = buildUrl({
      controls: { $having: { total: { $gt: 1000 } } },
    })
    expect(url).toBe('$having=total>1000')
  })

  it('$having AND wraps in parens', () => {
    const url = buildUrl({
      controls: {
        $having: {
          $and: [
            { total: { $gt: 1000 } },
            { count_star: { $gte: 5 } },
          ],
        },
      },
    })
    expect(url).toBe('$having=(total>1000&count_star>=5)')
  })

  it('$having implicit-AND comparison node wraps in parens and round-trips', () => {
    const query: Uniquery = {
      controls: { $having: { total: { $gt: 1000 }, count_star: { $gte: 5 } } },
    }
    const url = buildUrl(query)
    expect(url).toBe('$having=(total>1000&count_star>=5)')
    const parsed = parseUrl(url)
    expect(parsed.controls?.$having).toEqual(query.controls?.$having)
    // Nothing leaks from the $having value into the filter
    expect(parsed.filter).toEqual({})
  })

  it('$having value containing & is percent-encoded and round-trips', () => {
    // The parser splits the query on `&` outside parentheses without regard
    // to quotes; the value's `&` is percent-encoded, so no wrap is needed.
    const query: Uniquery = { controls: { $having: { name: 'a&b' }, $limit: 5 } }
    const url = buildUrl(query)
    expect(url).toBe("$having=name='a%26b'&$limit=5")
    const parsed = parseUrl(url)
    expect(parsed.controls?.$having).toEqual(query.controls?.$having)
    // Nothing leaks from the $having value into the filter
    expect(parsed.filter).toEqual({})
  })

  it('$having OR does not wrap', () => {
    const url = buildUrl({
      controls: {
        $having: {
          $or: [
            { total: { $gt: 1000 } },
            { avg_price: { $lt: 50 } },
          ],
        },
      },
    })
    expect(url).toBe('$having=total>1000^avg_price<50')
  })

  it('$having with full aggregation controls', () => {
    const url = buildUrl({
      controls: {
        $select: ['currency', { $fn: 'sum', $field: 'amount', $as: 'total' }],
        $groupBy: ['currency'],
        $having: { total: { $gt: 1000 } },
        $sort: { total: -1 },
      },
    })
    expect(url).toBe(
      '$select=currency,sum(amount):total&$groupBy=currency&$having=total>1000&$sort=-total',
    )
  })
})

describe('buildUrl – round-trip with parseUrl', () => {
  it('simple filter round-trips', () => {
    const query: Uniquery = { filter: { status: 'active', age: { $gte: 18 } } }
    expect(roundTrip(query).filter).toEqual(query.filter)
  })

  it('controls round-trip', () => {
    const query: Uniquery = {
      controls: {
        $select: ['name', 'email'],
        $sort: { createdAt: -1 },
        $limit: 20,
        $skip: 10,
      },
    }
    const r = roundTrip(query)
    expect(r.controls.$select).toEqual(['name', 'email'])
    expect(r.controls.$sort).toEqual({ createdAt: -1 })
    expect(r.controls.$limit).toBe(20)
    expect(r.controls.$skip).toBe(10)
  })

  it('$or filter round-trips', () => {
    const query: Uniquery = { filter: { $or: [{ age: { $gt: 25 } }, { role: 'admin' }] } }
    expect(roundTrip(query).filter).toEqual(query.filter)
  })

  it('$or with regex round-trips', () => {
    const query: Uniquery = {
      filter: {
        $or: [
          { firstName: { $regex: '/^Ali/i' } },
          { email: { $regex: '/^Ali/i' } },
          { id: 1 },
        ],
      },
    }
    expect(roundTrip(query).filter).toEqual(query.filter)
  })

  it('$and with nested $or round-trips (BUG.md reproduction)', () => {
    const query: Uniquery = {
      filter: {
        $and: [
          { $or: [{ category: 'electronics' }, { category: 'clothing' }] },
          { createdAt: 0 },
        ],
      },
    }
    expect(roundTrip(query).filter).toEqual(query.filter)
  })

  it('$or with multi-field comparison child round-trips', () => {
    const query: Uniquery = {
      filter: { $or: [{ status: 'A' }, { status: 'B', tier: 'gold' }] },
    }
    expect(roundTrip(query).filter).toEqual(query.filter)
  })

  it('$or with single-field multi-operator child round-trips', () => {
    const query: Uniquery = {
      filter: { $or: [{ age: { $gte: 18, $lte: 30 } }, { role: 'admin' }] },
    }
    expect(roundTrip(query).filter).toEqual(query.filter)
  })

  it('deeply nested $and/$or/$and round-trips (parser flattens inner $and)', () => {
    const query: Uniquery = {
      filter: {
        $and: [
          {
            $or: [
              { $and: [{ a: 1 }, { b: 2 }] },
              { c: 3 },
            ],
          },
          { d: 4 },
        ],
      },
    }
    // Parser collapses the inner $and of bare comparisons into an implicit-AND node.
    expect(roundTrip(query).filter).toEqual({
      $and: [
        { $or: [{ a: 1, b: 2 }, { c: 3 }] },
        { d: 4 },
      ],
    })
  })

  it('$or with regex and controls round-trips (BUG.md reproduction)', () => {
    const query: Uniquery = {
      filter: {
        $or: [
          { firstName: { $regex: '/^Ali/i' } },
          { email: { $regex: '/^Ali/i' } },
          { id: 'Ali' },
        ],
      },
      controls: { $select: ['id', 'firstName', 'email'], $limit: 20 },
    }
    const r = roundTrip(query)
    expect(r.filter).toEqual(query.filter)
    expect(r.controls.$select).toEqual(['id', 'firstName', 'email'])
    expect(r.controls.$limit).toBe(20)
  })

  // The parser's `mergeConjunction` keeps logical nodes as separate $and members
  // and appends the merged comparison fields last, so the canonical form of a
  // mixed node is an $and with the logical branch first.
  it('mixed comparison + $or node round-trips to the canonical $and form', () => {
    const query: Uniquery = {
      filter: {
        id: 101,
        nextRefreshAt: { $lte: 1000 },
        $or: [{ status: 'a' }, { status: 'b' }],
      },
    }
    expect(roundTrip(query).filter).toEqual({
      $and: [
        { $or: [{ status: 'a' }, { status: 'b' }] },
        { id: 101, nextRefreshAt: { $lte: 1000 } },
      ],
    })
  })

  it('mixed comparison + $not node round-trips to the canonical $and form', () => {
    const query: Uniquery = { filter: { a: 1, $not: { b: 2 } } }
    expect(roundTrip(query).filter).toEqual({
      $and: [{ $not: { b: 2 } }, { a: 1 }],
    })
  })

  it('mixed node nested inside an $or round-trips', () => {
    const query: Uniquery = {
      filter: { $or: [{ x: 9 }, { a: 1, $or: [{ b: 2 }, { c: 3 }] }] },
    }
    expect(roundTrip(query).filter).toEqual({
      $or: [
        { x: 9 },
        { $and: [{ $or: [{ b: 2 }, { c: 3 }] }, { a: 1 }] },
      ],
    })
  })

  it('$not filter round-trips', () => {
    const query: Uniquery = { filter: { $not: { status: 'DELETED' } } }
    expect(roundTrip(query).filter).toEqual(query.filter)
  })

  it('$in/$nin round-trip', () => {
    const query: Uniquery = {
      filter: {
        role: { $in: ['Admin', 'Editor'] },
        status: { $nin: ['Draft', 'Deleted'] },
      },
    }
    expect(roundTrip(query).filter).toEqual(query.filter)
  })

  // Regression: a quoted list item containing whitespace used to be swallowed
  // whole by the lexer's greedy unquoted-string rule, which ate the surrounding
  // `{…}` braces and blew up the parse.
  it('$in/$nin with whitespace-containing items round-trips', () => {
    const query: Uniquery = {
      filter: {
        city: { $in: ['New York', 'Los Angeles', 'San Diego'] },
        note: { $nin: ['to do', 'in progress'] },
      },
    }
    expect(roundTrip(query).filter).toEqual(query.filter)
  })

  it('$with round-trips', () => {
    const query: Uniquery = {
      controls: {
        $with: [{
          name: 'posts',
          filter: { published: true },
          controls: { $sort: { createdAt: -1 }, $limit: 5 },
        }],
      },
    }
    const r = roundTrip(query)
    const posts = r.controls.$with![0] as { name: string; filter: Record<string, unknown>; controls: Record<string, unknown> }
    expect(posts.name).toBe('posts')
    expect(posts.filter).toEqual({ published: true })
    expect(posts.controls.$sort).toEqual({ createdAt: -1 })
    expect(posts.controls.$limit).toBe(5)
  })

  it('aggregation round-trips', () => {
    const query: Uniquery = {
      controls: {
        $select: [
          'currency',
          { $fn: 'sum', $field: 'amount', $as: 'total' },
        ],
        $groupBy: ['currency'],
        $sort: { total: -1 },
      },
    }
    const r = roundTrip(query)
    expect(r.controls.$select).toEqual([
      'currency',
      { $fn: 'sum', $field: 'amount', $as: 'total' },
    ])
    expect(r.controls.$groupBy).toEqual(['currency'])
    expect(r.controls.$sort).toEqual({ total: -1 })
  })

  it('countDistinct round-trips, with and without alias', () => {
    const query: Uniquery = {
      controls: {
        $select: [
          'region',
          { $fn: 'countDistinct', $field: 'customerId' },
          { $fn: 'countDistinct', $field: 'customerId', $as: 'n' },
        ],
        $groupBy: ['region'],
        $sort: { n: -1 },
      },
    }
    expect(buildUrl(query)).toBe('$select=region,countDistinct(customerId),countDistinct(customerId):n&$groupBy=region&$sort=-n')
    const r = roundTrip(query)
    expect(r.controls.$select).toEqual([
      'region',
      { $fn: 'countDistinct', $field: 'customerId', $as: 'countDistinct_customerId' },
      { $fn: 'countDistinct', $field: 'customerId', $as: 'n' },
    ])
    expect(roundTrip({ controls: r.controls }).controls.$select).toEqual(r.controls.$select)
  })

  it('filter + controls combined round-trip', () => {
    const query: Uniquery = {
      filter: { age: { $gte: 18 }, status: { $ne: 'DELETED' } },
      controls: {
        $select: ['name', 'email'],
        $sort: { name: 1 },
        $limit: 50,
      },
    }
    const r = roundTrip(query)
    expect(r.filter).toEqual(query.filter)
    expect(r.controls.$select).toEqual(['name', 'email'])
    expect(r.controls.$sort).toEqual({ name: 1 })
    expect(r.controls.$limit).toBe(50)
  })

  it('quoted string values round-trip', () => {
    const query: Uniquery = { filter: { code: '25', flag: 'true', note: 'null' } }
    const r = roundTrip(query)
    expect((r.filter as Record<string, unknown>).code).toBe('25')
    expect((r.filter as Record<string, unknown>).flag).toBe('true')
    expect((r.filter as Record<string, unknown>).note).toBe('null')
  })

  it('$exists round-trips', () => {
    const query: Uniquery = {
      filter: {
        $and: [
          { email: { $exists: true } },
          { deletedAt: { $exists: false } },
        ],
      },
    }
    const r = roundTrip(query)
    expect(r.filter).toEqual({
      email: { $exists: true },
      deletedAt: { $exists: false },
    })
  })

  it('string with spaces round-trips', () => {
    const query: Uniquery = { filter: { name: 'John Doe' } }
    expect((roundTrip(query).filter as Record<string, unknown>).name).toBe('John Doe')
  })

  it('string with single quote round-trips', () => {
    const query: Uniquery = { filter: { name: "John's" } }
    expect((roundTrip(query).filter as Record<string, unknown>).name).toBe("John's")
  })

  it('string with backslash round-trips', () => {
    const query: Uniquery = { filter: { path: 'a\\b' } }
    expect((roundTrip(query).filter as Record<string, unknown>).path).toBe('a\\b')
  })

  it('string with special URL chars round-trips', () => {
    for (const ch of ['&', '^', '=', '!', '<', '>', '~', '(', ')', '{', '}', ',']) {
      const query: Uniquery = { filter: { val: `x${ch}y` } }
      const r = roundTrip(query)
      expect((r.filter as Record<string, unknown>).val).toBe(`x${ch}y`)
    }
  })

  // Regression for the "encoder denylist drift" bug: any char that the
  // tokenizer's `word` rule (`[A-Za-z0-9_.]+`) doesn't accept must trigger
  // quoting, otherwise the value chops at the first such char on parse.
  it('string with non-word chars (slugs, paths, ids) round-trips', () => {
    for (const ch of [
      '-', ':', ';', '?', '*', '/', '[', ']', '+',
      '@', '#', '%', '"', '`', '|', '\\', "'",
      ' ', '\t', '\n',
    ]) {
      const query: Uniquery = { filter: { val: `x${ch}y` } }
      const r = roundTrip(query)
      expect((r.filter as Record<string, unknown>).val).toBe(`x${ch}y`)
    }
  })

  it('hyphenated slug round-trips (atscript-ui repro)', () => {
    const query: Uniquery = { filter: { tableKey: 'orders-cancelled' } }
    expect(buildUrl(query)).toBe("tableKey='orders-cancelled'")
    expect((roundTrip(query).filter as Record<string, unknown>).tableKey).toBe('orders-cancelled')
  })

  it('fuzz: bare-word-like strings (hyphens, dots, literal prefixes, digits) round-trip', () => {
    const atoms = ['a', 'Z', '0', '1', '7', '-', '-', '.', '_', 'e', 'true', 'false', 'null', ' ', "'", '+', ':', 'T', '2026-03-29T14:00']
    let seed = 7
    const next = () => (seed = (seed * 48271) % 2147483647)
    for (let n = 0; n < 5000; n++) {
      let v = ''
      for (let k = 1 + (next() % 6); k > 0; k--) v += atoms[next() % atoms.length]
      for (const query of [
        { filter: { v } },
        { filter: { v: { $ne: v }, w: { $in: [v, 'x'] } } },
        { filter: { rel: { $some: { v } } } },
      ] as Uniquery[]) {
        const qs = buildUrl(query)
        expect(parseUrl(qs).filter, `${JSON.stringify(v)} -> ${qs}`).toEqual(query.filter)
        expect(roundTripViaUrl(query).filter, `${JSON.stringify(v)} -> ${qs}`).toEqual(query.filter)
      }
    }
  })

  it('hour labels round-trip and match the hand-written bare form', () => {
    for (const v of ['2026-03-29T14:00', '2026-03-29T14:00:30', '2026-03-29T14:00:00.000Z']) {
      const query: Uniquery = { filter: { h: v, r: { $some: { h: { $gte: v } } } } }
      expect(roundTrip(query).filter).toEqual(query.filter)
      expect(roundTripViaUrl(query).filter).toEqual(query.filter)
    }
    expect(parseUrl('h=2026-03-29T14:00').filter).toEqual(roundTrip({ filter: { h: '2026-03-29T14:00' } }).filter)
  })

  it('file-path-like values round-trip', () => {
    for (const v of ['/api/foo', 'a:b', 'a;b', 'q?r', 'x*y', 'a/b/c', 'arn:aws:s3:::bucket']) {
      const query: Uniquery = { filter: { v } }
      expect((roundTrip(query).filter as Record<string, unknown>).v).toBe(v)
    }
  })

  it('empty-string value round-trips', () => {
    const query: Uniquery = { filter: { x: '' } }
    expect(buildUrl(query)).toBe("x=''")
    expect((roundTrip(query).filter as Record<string, unknown>).x).toBe('')
  })

  it('negative-number-shaped string round-trips as string (not number)', () => {
    const query: Uniquery = { filter: { code: '-42' } }
    expect(buildUrl(query)).toBe("code='-42'")
    expect((roundTrip(query).filter as Record<string, unknown>).code).toBe('-42')
  })

  it('bare-zero string round-trips as string (not number)', () => {
    const query: Uniquery = { filter: { code: '0' } }
    expect(buildUrl(query)).toBe("code='0'")
    expect((roundTrip(query).filter as Record<string, unknown>).code).toBe('0')
  })

  it('decimal-number-shaped string round-trips as string', () => {
    const query: Uniquery = { filter: { v: '3.14' } }
    expect(buildUrl(query)).toBe("v='3.14'")
    expect((roundTrip(query).filter as Record<string, unknown>).v).toBe('3.14')
  })

  it('non-ASCII string round-trips', () => {
    for (const v of ['café', 'naïve', 'Ω', '日本語', 'emoji-rocket-🚀']) {
      const query: Uniquery = { filter: { v } }
      expect((roundTrip(query).filter as Record<string, unknown>).v).toBe(v)
    }
  })

  // Fuzz: every printable ASCII char (0x21..0x7E) embedded mid-string must
  // round-trip. Catches future tokenizer additions that drift from the
  // builder's allowlist.
  it('fuzz: every printable ASCII char embedded in a value round-trips', () => {
    for (let code = 0x21; code <= 0x7e; code++) {
      const ch = String.fromCharCode(code)
      const v = `a${ch}b`
      const query: Uniquery = { filter: { v } }
      const r = roundTrip(query)
      expect((r.filter as Record<string, unknown>).v, `char ${JSON.stringify(ch)} (0x${code.toString(16)})`).toBe(v)
    }
  })

  // Fuzz: same but as a leading char — tickles the lexer's "number/regex/etc.
  // pre-empts word" branch.
  it('fuzz: every printable ASCII char as leading char round-trips', () => {
    for (let code = 0x21; code <= 0x7e; code++) {
      const ch = String.fromCharCode(code)
      const v = `${ch}rest`
      const query: Uniquery = { filter: { v } }
      const r = roundTrip(query)
      expect((r.filter as Record<string, unknown>).v, `char ${JSON.stringify(ch)} (0x${code.toString(16)})`).toBe(v)
    }
  })

  it('$having single condition round-trips', () => {
    const query: Uniquery = {
      controls: { $having: { total: { $gt: 1000 } } },
    }
    const r = roundTrip(query)
    expect(r.controls.$having).toEqual({ total: { $gt: 1000 } })
  })

  it('$having AND (multi-condition) round-trips', () => {
    const query: Uniquery = {
      controls: {
        $having: {
          $and: [
            { total: { $gt: 1000 } },
            { count_star: { $gte: 5 } },
          ],
        },
      },
    }
    const r = roundTrip(query)
    expect(r.controls.$having).toEqual({
      total: { $gt: 1000 },
      count_star: { $gte: 5 },
    })
  })

  it('$having OR round-trips', () => {
    const query: Uniquery = {
      controls: {
        $having: {
          $or: [
            { total: { $gt: 1000 } },
            { avg_price: { $lt: 50 } },
          ],
        },
      },
    }
    const r = roundTrip(query)
    expect(r.controls.$having).toEqual({
      $or: [
        { total: { $gt: 1000 } },
        { avg_price: { $lt: 50 } },
      ],
    })
  })

  it('full aggregation query with $having round-trips', () => {
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
        $limit: 10,
      },
    }
    const r = roundTrip(query)
    expect(r.controls.$having).toEqual({ total: { $gt: 1000 } })
    expect(r.controls.$groupBy).toEqual(['currency'])
    expect(r.controls.$sort).toEqual({ total: -1 })
  })
})

// The direct `parseUrl(buildUrl(...))` round-trip above cannot catch chars that
// a real URL parser mangles *in transit* (fragment truncation on `#`, stripping
// of tab/newline). These tests push the query string through a genuine WHATWG
// `URL` — the same normalization `fetch`, the address bar, and the server's
// `req.url` apply — before handing the search string to parseUrl.
describe('buildUrl – round-trip through a real URL parser', () => {
  it('value containing `#` survives (BUG.md: jobName#runId ids)', () => {
    const query: Uniquery = {
      filter: { jobId: { $in: ['inventory-images:store#0-1000', 'inventory-images:plan#ALL:0:1'] } },
    }
    const r = roundTripViaUrl(query)
    expect((r.filter as Record<string, unknown>).jobId).toEqual({
      $in: ['inventory-images:store#0-1000', 'inventory-images:plan#ALL:0:1'],
    })
  })

  it('single `#` value survives (BUG.md one-liner repro)', () => {
    const query: Uniquery = { filter: { jobId: { $in: ['a#b'] } } }
    const r = roundTripViaUrl(query)
    expect((r.filter as Record<string, unknown>).jobId).toEqual({ $in: ['a#b'] })
  })

  // The builder percent-encodes only `% & ( ) # \t \n \r` (plus `'` in bare control
  // values). Deliberately not encoded: `+` (parseUrl's `decodeURIComponent` keeps it
  // literal), `=` (a control splits at its first `=`; filter values are quoted),
  // `? / ^ ,` (not significant at the top-level split), and chars the URL layer
  // percent-encodes in transit (space, `"`, `<`, `>`, non-ASCII), which parseUrl decodes.
  // Locks the full contract for the whole class of transit-hostile chars:
  // `#` (fragment), `\t \n \r` (stripped), plus `& ? % + ' \ space " < >` which
  // the URL layer either passes through or percent-encodes and parseUrl decodes.
  it('every transit-hostile char round-trips through a real URL', () => {
    for (const ch of ['#', '&', '?', '%', '+', "'", '\\', ' ', '"', '<', '>', '\t', '\n', '\r', '=', '^']) {
      const query: Uniquery = { filter: { val: `a${ch}b` } }
      const r = roundTripViaUrl(query)
      expect((r.filter as Record<string, unknown>).val, `char ${JSON.stringify(ch)}`).toBe(`a${ch}b`)
    }
  })

  it('$in list with mixed transit-hostile chars round-trips through a real URL', () => {
    const query: Uniquery = {
      filter: { path: { $in: ['a#b', 'c d', 'e%f', 'g&h', "i'j", 'k\tl'] } },
    }
    const r = roundTripViaUrl(query)
    expect((r.filter as Record<string, unknown>).path).toEqual({
      $in: ['a#b', 'c d', 'e%f', 'g&h', "i'j", 'k\tl'],
    })
  })

  it('fuzz: every printable ASCII char survives a real URL round-trip', () => {
    for (let code = 0x21; code <= 0x7e; code++) {
      const ch = String.fromCharCode(code)
      const v = `a${ch}b`
      const query: Uniquery = { filter: { v } }
      const r = roundTripViaUrl(query)
      expect((r.filter as Record<string, unknown>).v, `char ${JSON.stringify(ch)} (0x${code.toString(16)})`).toBe(v)
    }
  })
})

// Control values (`$search`, `$search:<index>`, any pass-through `$`-control)
// are written bare, not inside a quoted literal. They must be percent-encoded
// symmetrically with parseUrl's per-segment `decodeURIComponent`, and must not
// leave a raw `&`, `'` or `#` for downstream (quote-aware) query splitters.
function stripInsights(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripInsights)
  if (v && typeof v === 'object' && !(v instanceof RegExp)) {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== 'insights')
        .map(([k, x]) => [k, stripInsights(x)]),
    )
  }
  return v
}

describe('buildUrl – control value encoding', () => {
  function searchOf(query: Uniquery, key = '$search') {
    return (roundTrip(query).controls as Record<string, unknown>)[key]
  }

  it('term with `&`, `\'` and `#` round-trips and emits no raw structural chars', () => {
    const term = "Maison & O'Brien #1"
    const query: Uniquery = { controls: { $search: term } }
    expect(buildUrl(query)).toBe('$search=Maison %26 O%27Brien %231')
    expect(searchOf(query)).toBe(term)
  })

  it('term with a stray `%` round-trips', () => {
    const query: Uniquery = { controls: { $search: '100% done' } }
    expect(buildUrl(query)).toBe('$search=100%25 done')
    expect(searchOf(query)).toBe('100% done')
  })

  it('pre-encoded-looking term round-trips literally (no double decode)', () => {
    for (const term of ['50%25 off', '%41', '%2525', 'a%26b', '%']) {
      expect(searchOf({ controls: { $search: term } }), term).toBe(term)
    }
  })

  it('fuzz: every printable ASCII char embedded, leading and trailing in $search round-trips', () => {
    for (let code = 0x20; code <= 0x7e; code++) {
      const ch = String.fromCharCode(code)
      for (const term of [`a${ch}b`, `${ch}rest`, `rest${ch}`]) {
        const query: Uniquery = { controls: { $search: term, $limit: 5 } }
        const r = roundTrip(query)
        const label = `char ${JSON.stringify(ch)} (0x${code.toString(16)}) in ${JSON.stringify(term)}`
        expect((r.controls as Record<string, unknown>).$search, label).toBe(term)
        expect(r.controls.$limit, label).toBe(5)
        expect(r.filter, label).toEqual({})
      }
    }
  })

  it('fuzz: emitted $search segment carries no raw `&`, `\'`, `#`, `(`, `)`', () => {
    for (let code = 0x20; code <= 0x7e; code++) {
      const term = `a${String.fromCharCode(code)}b`
      const url = buildUrl({ controls: { $search: term } })
      expect(url, JSON.stringify(term)).not.toMatch(/[&'#()]/u)
    }
  })

  it('tab, CR and LF round-trip (directly and through a real URL)', () => {
    for (const term of ['a\tb', 'a\rb', 'a\nb', '\r\n', 'x\t']) {
      const query: Uniquery = { controls: { $search: term } }
      expect(searchOf(query), JSON.stringify(term)).toBe(term)
      expect((roundTripViaUrl(query).controls as Record<string, unknown>).$search, JSON.stringify(term)).toBe(term)
    }
  })

  it('non-ASCII terms round-trip (directly and through a real URL)', () => {
    for (const term of ['Crème brûlée', '日本語', 'emoji 🚀 rocket', 'Ω & ß']) {
      const query: Uniquery = { controls: { $search: term } }
      expect(searchOf(query), term).toBe(term)
      expect((roundTripViaUrl(query).controls as Record<string, unknown>).$search, term).toBe(term)
    }
  })

  it('fuzz: every printable ASCII char in $search survives a real URL round-trip', () => {
    for (let code = 0x20; code <= 0x7e; code++) {
      const term = `a${String.fromCharCode(code)}b`
      const r = roundTripViaUrl({ controls: { $search: term, $skip: 10 } })
      expect((r.controls as Record<string, unknown>).$search, JSON.stringify(term)).toBe(term)
      expect(r.controls.$skip, JSON.stringify(term)).toBe(10)
    }
  })

  it('$search:<indexName> keeps its key structure and round-trips a special-char term', () => {
    const term = "Maison & O'Brien #1 (100%)"
    const query: Uniquery = { controls: { '$search:products_idx': term } }
    expect(buildUrl(query)).toBe('$search:products_idx=Maison %26 O%27Brien %231 %28100%25%29')
    expect(searchOf(query, '$search:products_idx')).toBe(term)
  })

  it('$search:<indexName> with special chars in the index name round-trips', () => {
    const key = "$search:my idx&(v2)'%"
    expect(searchOf({ controls: { [key]: 'a&b' } }, key)).toBe('a&b')
  })

  it('other pass-through controls are encoded too', () => {
    const query: Uniquery = { controls: { $relevance: "x&y'#", $custom: 'a(b' } }
    const r = roundTrip(query).controls as Record<string, unknown>
    expect(r.$relevance).toBe("x&y'#")
    expect(r.$custom).toBe('a(b')
  })

  it('combined query loses nothing after a special-char $search term', () => {
    const query: Uniquery = {
      filter: { status: 'active', name: "O'Neil & Sons (UK)" },
      controls: {
        $sort: { createdAt: -1 },
        $search: "Maison & O'Brien #1 100%",
        $skip: 20,
        $limit: 10,
        '$search:alt': "it's (50%25) off",
      },
    }
    const r = roundTrip(query)
    expect(r.filter).toEqual(query.filter)
    expect(r.controls).toEqual(query.controls)
    const rv = roundTripViaUrl(query)
    expect(rv.filter).toEqual(query.filter)
    expect(rv.controls).toEqual(query.controls)
  })

  it('filter values with unbalanced parens or `&$…` do not swallow following controls', () => {
    for (const v of ['a(b', 'a)b', '((', 'a&$limit=9', 'x&y']) {
      const query: Uniquery = { filter: { name: v }, controls: { $sort: { x: 1 }, $limit: 5 } }
      const r = roundTrip(query)
      expect(r.filter, v).toEqual({ name: v })
      expect(r.controls, v).toEqual({ $sort: { x: 1 }, $limit: 5 })
    }
  })

  it('$having value with an unbalanced paren does not swallow following controls', () => {
    const query: Uniquery = { controls: { $having: { n: 'a(b' }, $limit: 5 } }
    const r = roundTrip(query)
    expect(r.controls).toEqual({ $having: { n: 'a(b' }, $limit: 5 })
  })

  // A `$with` body is a query string embedded in the outer one: parseUrl
  // decodes it once per nesting level, so the builder escapes the body's `%`.
  it('$with relation body round-trips `%`, parens and a special-char $search', () => {
    const rel = {
      name: 'posts',
      filter: { title: '50% (off)', code: '%41' },
      controls: { $search: "Maison & O'Brien #1 %25", $limit: 3 },
    }
    const query: Uniquery = { controls: { $with: [rel, 'author'], $skip: 1, $search: 'top & level' } }
    const r = roundTrip(query)
    const w = r.controls.$with as Array<Record<string, unknown>>
    expect(w[0].filter).toEqual(rel.filter)
    expect(w[0].controls).toEqual(rel.controls)
    expect(w[1]).toMatchObject({ name: 'author' })
    expect(r.controls.$skip).toBe(1)
    expect((r.controls as Record<string, unknown>).$search).toBe('top & level')
  })

  const NESTED_VALUES = [
    'a&x=1',
    '&$limit=9',
    '50%',
    '%41',
    '%2541',
    "O'Brien (x), y",
    'a(b',
    'x)y',
    'a,b',
    'a#b',
    'a=b+c',
    'tab\there',
    'Crème 🚀',
  ]

  it('fuzz: special chars in nested filter, $having and pass-through values round-trip at 1 and 2 levels', () => {
    for (const v of NESTED_VALUES) {
      const body = {
        filter: { t: v, n: 1 },
        controls: { $having: { h: v }, $search: v, '$search:idx': v, $limit: 2 },
      }
      const level1: Uniquery = {
        filter: { top: v },
        controls: {
          $with: [{ name: 'posts', ...body }, { name: 'author', filter: {}, controls: {} }],
          $search: v,
          $skip: 3,
        },
      }
      const level2: Uniquery = {
        filter: {},
        controls: {
          $with: [{ name: 'posts', filter: { p: v }, controls: { $with: [{ name: 'c', ...body }], $search: v } }],
          $limit: 1,
        },
      }
      for (const query of [level1, level2]) {
        const qs = buildUrl(query)
        const viaUrl = viaRealUrl(qs)
        for (const parsed of [parseUrl(qs), parseUrl(viaUrl)]) {
          const { insights: _i, ...rest } = parsed
          expect(stripInsights(rest), `${JSON.stringify(v)} -> ${qs}`).toEqual(stripInsights(query))
        }
      }
    }
  })

  it('two-level nested $with round-trips special chars', () => {
    const query: Uniquery = {
      controls: {
        $with: [
          {
            name: 'posts',
            filter: {},
            controls: {
              $with: [{ name: 'comments', filter: { body: "100% & 'more'" }, controls: { $search: 'a%25(b' } }],
            },
          },
        ],
      },
    }
    const posts = (roundTrip(query).controls.$with as Array<Record<string, any>>)[0]
    const comments = posts.controls.$with[0]
    expect(comments.filter).toEqual({ body: "100% & 'more'" })
    expect(comments.controls.$search).toBe('a%25(b')
  })
})

describe('buildUrl – calendar buckets', () => {
  /** `q` with every computed `$select` entry's `$as` filled (the parser's canonical form), recursively. */
  function canonical(q: Uniquery): Uniquery {
    const controls = { ...q.controls }
    if (Array.isArray(controls.$select)) {
      controls.$select = controls.$select.map((e) =>
        typeof e === 'string' ? e : { ...e, $as: resolveAlias(e) },
      ) as typeof controls.$select
    }
    if (controls.$with) {
      controls.$with = controls.$with.map((r) =>
        typeof r === 'string' ? r : { name: r.name, ...canonical(r) },
      ) as typeof controls.$with
    }
    return { filter: q.filter ?? {}, controls }
  }
  function expectRoundTrip(q: Uniquery) {
    const qs = buildUrl(q)
    const viaUrl = viaRealUrl(qs)
    for (const parsed of [parseUrl(qs), parseUrl(viaUrl)]) {
      const { insights: _i, ...rest } = parsed
      expect(stripInsights(rest), qs).toEqual(canonical(q))
    }
  }

  it('emits bucket(field,unit[,tz][,weekStart]):alias', () => {
    const sel = (b: BucketExpr) => buildUrl({ controls: { $select: [b] } })
    expect(sel({ $bucket: 'day', $field: 'openedAt' })).toBe('$select=bucket(openedAt,day):day_openedAt')
    expect(sel({ $bucket: 'day', $field: 'openedAt', $tz: 'UTC' })).toBe(
      '$select=bucket(openedAt,day,UTC):day_openedAt',
    )
    expect(sel({ $bucket: 'day', $field: 'openedAt', $tz: 'Europe/Berlin', $as: 'day' })).toBe(
      "$select=bucket(openedAt,day,'Europe/Berlin'):day",
    )
    expect(
      sel({ $bucket: 'week', $field: 'openedAt', $tz: 'America/New_York', $weekStart: 'sun', $as: 'wk' }),
    ).toBe("$select=bucket(openedAt,week,'America/New_York',sun):wk")
    expect(sel({ $bucket: 'week', $field: 'openedAt', $weekStart: 'sun' })).toBe(
      '$select=bucket(openedAt,week,,sun):week_openedAt',
    )
  })

  const DESIGN_QUERY: Uniquery = {
    filter: { openedAt: { $gte: 1772323200000, $lt: 1775001600000 } },
    controls: {
      $select: [
        { $bucket: 'week', $field: 'openedAt', $tz: 'Europe/Berlin', $weekStart: 'sun', $as: 'week' },
        'status',
        { $fn: 'count', $field: '*', $as: 'n' },
      ],
      $groupBy: ['week', 'status'],
      $having: { week: { $gte: '2026-03-01' }, n: { $gt: 0 } },
      $sort: { week: 1, status: 1 },
      $limit: 50,
    },
  }

  it('emits the design §0 URL for the §0 query', () => {
    expect(buildUrl(DESIGN_QUERY)).toBe(
      'openedAt>=1772323200000&openedAt<1775001600000' +
        "&$select=bucket(openedAt,week,'Europe/Berlin',sun):week,status,count(*):n" +
        "&$groupBy=week,status&$having=(week>='2026-03-01'&n>0)&$sort=week,status&$limit=50",
    )
    expectRoundTrip(DESIGN_QUERY)
  })

  it('round-trips units × zone × week start × alias', () => {
    for (const $bucket of ['hour', 'day', 'week', 'month', 'quarter', 'year'] as const) {
      for (const $tz of [undefined, 'UTC', 'Europe/Berlin', 'America/New_York', 'Etc/GMT+5']) {
        for (const $weekStart of [undefined, 'sun', 'mon'] as const) {
          for (const $as of [undefined, 'b']) {
            const b: BucketExpr = { $bucket, $field: 'openedAt' }
            if ($tz !== undefined) b.$tz = $tz
            if ($weekStart !== undefined) b.$weekStart = $weekStart
            if ($as !== undefined) b.$as = $as
            expectRoundTrip({ controls: { $select: [b, 'status'], $groupBy: [resolveAlias(b), 'status'] } })
          }
        }
      }
    }
  })

  it('round-trips the §9.1 examples, a dotted source and syntactically odd zones', () => {
    for (const b of [
      { $bucket: 'day', $field: 'openedAt' },
      { $bucket: 'day', $field: 'openedAt', $tz: 'Europe/Berlin', $as: 'day' },
      { $bucket: 'week', $field: 'openedAt', $tz: 'America/New_York', $weekStart: 'sun', $as: 'wk' },
      { $bucket: 'week', $field: 'openedAt', $weekStart: 'sun' },
      { $bucket: 'day', $field: 'stats.firstSeenAt', $as: 'first' },
      // zones the core rejects still survive the URL untouched
      { $bucket: 'day', $field: 't', $tz: "a,b)'c(&#%" },
      { $bucket: 'day', $field: 't', $tz: '' },
      { $bucket: 'day', $field: 't', $tz: 'null' },
      { $bucket: 'day', $field: 't', $tz: '123' },
    ] as BucketExpr[]) {
      expectRoundTrip({ controls: { $select: [b, { $fn: 'count', $field: '*' }], $groupBy: [resolveAlias(b)] } })
    }
  })

  it('round-trips $having and $sort on the bucket alias with filters, $search and $skip', () => {
    expectRoundTrip({
      filter: { status: 'open', name: "O'Brien & Co (UK)" },
      controls: {
        $select: [
          { $bucket: 'month', $field: 'openedAt', $tz: 'Europe/Berlin', $as: 'month' },
          { $fn: 'sum', $field: 'amount', $as: 'total' },
        ],
        $groupBy: ['month'],
        $having: { $or: [{ month: { $gte: '2026-03-01' } }, { total: { $gt: 100 } }] },
        $sort: { month: -1 },
        $skip: 10,
        $search: "Maison & O'Brien #1 100%",
      },
    })
  })

  it('round-trips buckets inside $with at 1 and 2 levels', () => {
    const body = (tz: string): Omit<WithRelation, 'name'> => ({
      filter: { kind: 'a&b' },
      controls: {
        $select: [{ $bucket: 'week', $field: 'createdAt', $tz: tz, $weekStart: 'sun' }, { $fn: 'count', $field: '*' }],
        $groupBy: ['week_createdAt'],
        $having: { week_createdAt: { $gte: '2026-01-01' }, count_star: { $gt: 1 } },
        $search: 'x & y',
      },
    })
    expectRoundTrip({
      controls: {
        $with: [{ name: 'orders', ...body('Europe/Berlin') }],
        $limit: 5,
      },
    })
    expectRoundTrip({
      filter: {},
      controls: {
        $with: [
          {
            name: 'customers',
            filter: {},
            controls: { $with: [{ name: 'orders', ...body('America/New_York') }], $sort: { name: 1 } },
          },
        ],
      },
    })
  })
})

describe('buildUrl – relational predicates', () => {
  it('serializes field=$some(<operand>) / $none', () => {
    expect(buildUrl({ filter: { ticket: { $some: { status: 'open' } } } })).toBe('ticket=$some(status=open)')
    expect(buildUrl({ filter: { ticket: { $none: {} } } })).toBe('ticket=$none()')
    expect(buildUrl({ filter: { ticket: { $some: { teamId: { $in: ['t1', 't2'] }, status: 'open' } } } })).toBe(
      'ticket=$some(teamId{t1,t2}&status=open)',
    )
  })

  const cases: Array<[string, Uniquery]> = [
    ['to-one with $in + eq', { filter: { ticket: { $some: { teamId: { $in: ['t1', 't2'] }, status: 'open' } } } }],
    ['nested 2 levels', { filter: { ticket: { $some: { team: { $none: { name: 'x y' } }, status: 'open' } } } }],
    ['empty body', { filter: { ticket: { $some: {} }, title: 'a' } }],
    ['OR inside body', { filter: { ticket: { $some: { $or: [{ status: 'open' }, { status: 'new' }] } } } }],
    ['predicate under OR / NOT', { filter: { $or: [{ a: 1 }, { $not: { ticket: { $none: { b: 2 } } } }] } }],
    ['quoted value containing )', { filter: { ticket: { $some: { title: 'a)b(c&d%e' } } } }],
    ['$some and $none on one key', { filter: { ticket: { $some: { a: 1 }, $none: { b: 2 } } } }],
    [
      'inside $with',
      { filter: {}, controls: { $with: [{ name: 'a', filter: { b: { $some: { c: 1, d: 'x)y' } } }, controls: {} }] } },
    ],
  ]

  for (const [name, query] of cases) {
    it(`round-trips: ${name}`, () => {
      for (const parsed of [roundTrip(query), roundTripViaUrl(query)]) {
        expect(parsed.filter).toEqual(query.filter)
        if (query.controls) expect(stripInsights(parsed.controls)).toEqual(query.controls)
      }
    })
  }

  it('refuses an operand that matches nothing instead of widening it to "any related row"', () => {
    for (const operand of [{ $or: [] }, { $not: {} }, { $and: [{ $or: [] }] }]) {
      const f = { ticket: { $some: operand } } as Uniquery['filter']
      expect(() => buildUrl({ filter: f })).toThrow(/matches no row/)
    }
    // A never-member makes the whole AND match no row — it is not dropped to widen the operand.
    const f = { ticket: { $some: { a: 1, $or: [] } } } as Uniquery['filter']
    expect(() => buildUrl({ filter: f })).toThrow(/matches no row/)
  })

  it('never widens or narrows a filter by dropping an absorbing empty member', () => {
    // AND with a never-member matches no row — at the root too (an empty query = every row)
    for (const filter of [{ $or: [] }, { a: 1, $or: [] }, { $and: [{ a: 1 }, { $not: {} }] }]) {
      expect(() => buildUrl({ filter } as Uniquery)).toThrow(/matches no row/)
    }
    // OR with an every-row member matches every row
    expect(buildUrl({ filter: { $or: [{}, { a: 1 }] } } as Uniquery)).toBe('')
    expect(buildUrl({ filter: { b: 2, $or: [{ $and: [] }, { a: 1 }] } } as Uniquery)).toBe('b=2')
    // NOT of a never-AND matches every row; NOT of an every-OR matches none
    expect(buildUrl({ filter: { b: 2, $not: { a: 1, $or: [] } } } as Uniquery)).toBe('b=2')
    expect(() => buildUrl({ filter: { $not: { $or: [{}, { a: 1 }] } } } as Uniquery)).toThrow(
      /matches no row/,
    )
    // OR drops never-members; AND drops every-row members
    expect(buildUrl({ filter: { $or: [{ $or: [] }, { a: 1 }, { b: 2 }] } } as Uniquery)).toBe('a=1^b=2')
    expect(buildUrl({ filter: { $and: [{}, { a: 1 }] } } as Uniquery)).toBe('a=1')
  })

  it('keeps tautological empty operands as the empty body', () => {
    for (const operand of [{}, { $and: [] }, { $or: [{}] }, { $or: [{ $and: [] }, { $or: [] }] }]) {
      expect(buildUrl({ filter: { ticket: { $none: operand } } as Uniquery['filter'] })).toBe('ticket=$none()')
    }
  })

  it('refuses non-object operands', () => {
    for (const operand of [null, undefined, [], [{ a: 1 }], 'x', 5, new Date(0)]) {
      expect(() => buildUrl({ filter: { ticket: { $some: operand } } as unknown as Uniquery['filter'] })).toThrow(
        /needs a filter object operand/,
      )
    }
  })
})

describe('buildUrl – empty IN / NOT IN lists', () => {
  const cases: Record<string, Uniquery> = {
    'code{}': { filter: { code: { $in: [] } } },
    'code!{}': { filter: { code: { $nin: [] } } },
    'code{}^x=1': { filter: { $or: [{ code: { $in: [] } }, { x: 1 }] } },
    'code{}&x=1': { filter: { code: { $in: [] }, x: 1 } },
    '!(code{})': { filter: { $not: { code: { $in: [] } } } },
    'rel=$some(code{})': { filter: { rel: { $some: { code: { $in: [] } } } } },
    'code{}&code{a}': { filter: { $and: [{ code: { $in: [] } }, { code: { $in: ['a'] } }] } },
    'code!{}&$having=n>1': { filter: { code: { $nin: [] } }, controls: { $having: { n: { $gt: 1 } } } },
  }
  for (const [url, query] of Object.entries(cases)) {
    it(`${url} round-trips`, () => {
      expect(buildUrl(query)).toBe(url.replace('&$having=n>1', '&$having=n>1'))
      expect(roundTrip(query).filter).toEqual(query.filter)
      expect(roundTripViaUrl(query).filter).toEqual(query.filter)
    })
  }
})

describe('buildUrl – non-finite numbers', () => {
  it('throws for NaN and ±Infinity, naming the field', () => {
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      expect(() => buildUrl({ filter: { price: value } })).toThrow(TypeError)
      expect(() => buildUrl({ filter: { price: value } })).toThrow(
        `Filter value for "price" is not a finite number (${value}); it cannot be expressed in a URL`,
      )
      expect(() => buildUrl({ filter: { price: { $gt: value } } })).toThrow(/"price"/)
      expect(() => buildUrl({ filter: { code: { $in: [1, value] } } })).toThrow(/"code"/)
      expect(() => buildUrl({ filter: { code: { $nin: [value] } } })).toThrow(/not a finite number/)
      expect(() => buildUrl({ filter: { $or: [{ a: 1 }, { b: value }] } })).toThrow(/"b"/)
      expect(() => buildUrl({ filter: { r: { $some: { x: value } } } })).toThrow(/"x"/)
      expect(() => buildUrl({ controls: { $having: { n: { $gt: value } } } })).toThrow(/"n"/)
    }
  })

  it('still accepts finite numbers and numeric-looking strings', () => {
    expect(buildUrl({ filter: { a: 0, b: -0.5 } })).toBe('a=0&b=-0.5')
    expect(buildUrl({ filter: { a: 'Infinity' } })).toBe('a=Infinity')
  })
})

describe('buildUrl – exponent-form numbers', () => {
  const cases: [number, string][] = [
    [1e21, '1000000000000000000000'],
    [-1e21, '-1000000000000000000000'],
    [1.5e21, '1500000000000000000000'],
    [1.2345e25, '12345000000000000000000000'],
    [1e-7, '0.0000001'],
    [-1.5e-7, '-0.00000015'],
    [1.2345e-10, '0.00000000012345'],
    [Number.MIN_VALUE, '0.' + '0'.repeat(323) + '5'],
    [1.2345678901234568e20, '123456789012345680000'],
  ]
  for (const [n, plain] of cases) {
    it(`${n} is written as plain decimal`, () => {
      expect(buildUrl({ filter: { x: n } })).toBe(`x=${plain}`)
      expect(roundTrip({ filter: { x: n } }).filter).toEqual({ x: n })
      expect(roundTripViaUrl({ filter: { x: n } }).filter).toEqual({ x: n })
    })
  }

  it('round-trips Number.MAX_VALUE, -Number.MAX_VALUE and Number.MIN_VALUE', () => {
    for (const n of [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, Number.EPSILON]) {
      const url = buildUrl({ filter: { x: n } })
      expect(url).not.toMatch(/e/i)
      expect(url).not.toContain('+')
      expect(parseUrl(url).filter).toEqual({ x: n })
    }
    expect(buildUrl({ filter: { x: Number.MAX_VALUE } })).toBe(`x=17976931348623157${'0'.repeat(292)}`)
  })

  it('applies inside lists, comparisons and $having', () => {
    expect(buildUrl({ filter: { x: { $in: [1e21, 2] } } })).toBe('x{1000000000000000000000,2}')
    expect(buildUrl({ filter: { x: { $lt: 1e-7 } } })).toBe('x<0.0000001')
    expect(roundTrip({ controls: { $having: { n: { $gt: 1e21 } } } }).controls.$having).toEqual({ n: { $gt: 1e21 } })
  })

  it('leaves ordinary numbers alone', () => {
    expect(buildUrl({ filter: { a: 123, b: 1.5, c: -2, d: 0.000001, e: 1e20 } })).toBe(
      'a=123&b=1.5&c=-2&d=0.000001&e=100000000000000000000',
    )
  })
})

describe('buildUrl – arithmetic $select items and $rowOrder', () => {
  const trip = (controls: Uniquery['controls']) => roundTrip({ controls }).controls
  const tripUrl = (controls: Uniquery['controls']) => roundTripViaUrl({ controls }).controls

  it('writes sum(<arith>):alias and expr(<arith>):alias with %2B for plus', () => {
    expect(
      buildUrl({
        controls: {
          $groupBy: ['ticketId'],
          $select: [
            'ticketId',
            { $fn: 'count', $field: '*', $as: 'open' },
            { $fn: 'sum', $field: 'estimate', $as: 'est' },
            { $fn: 'sum', $expr: { $op: '*', $args: ['price', 'qty'] }, $as: 'revenue' },
            { $expr: { $op: '/', $args: ['est', 'open'] }, $as: 'avgEst' },
            { $expr: { $op: '+', $args: [{ $op: '*', $args: ['open', 10] }, 'sevMax'] }, $as: 'rank' },
            { $fn: 'max', $field: 'severity', $as: 'sevMax' },
            { $fn: 'first', $field: 'raisedAt', $as: 'oldestAt' },
            { $fn: 'last', $field: 'raisedAt', $as: 'newestAt' },
          ],
          $rowOrder: { raisedAt: 1, id: -1 },
          $sort: { rank: -1 },
        },
      }),
    ).toBe(
      '$select=ticketId,count(*):open,sum(estimate):est,sum(price*qty):revenue,expr(est/open):avgEst,' +
        'expr(open*10%2BsevMax):rank,max(severity):sevMax,first(raisedAt):oldestAt,last(raisedAt):newestAt' +
        '&$groupBy=ticketId&$sort=-rank&$rowOrder=raisedAt,-id',
    )
  })

  const controlsCases: Record<string, Uniquery['controls']> = {
    'row-level sum': { $groupBy: ['g'], $select: ['g', { $fn: 'sum', $expr: { $op: '*', $args: ['price', 'qty'] }, $as: 'rev' }] },
    'row-level avg / min / max': {
      $groupBy: ['g'],
      $select: ['g', ...(['avg', 'min', 'max'] as const).map((fn) => ({ $fn: fn, $expr: { $op: '-' as const, $args: ['a', 'b'] as [string, string] }, $as: `${fn}X` }))],
    },
    'group-level with plus': {
      $groupBy: ['g'],
      $select: ['g', { $expr: { $op: '+', $args: ['a', { $op: '+', $args: ['b', 1] }] }, $as: 'x' }],
    },
    'left-associative minus and division': {
      $groupBy: ['g'],
      $select: [
        { $expr: { $op: '-', $args: ['a', { $op: '-', $args: ['b', 'c'] }] }, $as: 'x' },
        { $expr: { $op: '/', $args: [{ $op: '/', $args: ['a', 'b'] }, 'c'] }, $as: 'y' },
      ],
    },
    'unary minus and negative literals': {
      $groupBy: ['g'],
      $select: [
        { $expr: { $op: '-', $args: ['a'] }, $as: 'n1' },
        { $expr: { $op: '-', $args: [5] }, $as: 'n2' },
        { $expr: { $op: '*', $args: ['a', -5] }, $as: 'n3' },
        { $expr: { $op: '-', $args: [{ $op: '+', $args: ['a', 'b'] }] }, $as: 'n4' },
      ],
    },
    coalesce: {
      $groupBy: ['g'],
      $select: [{ $fn: 'sum', $expr: { $op: 'coalesce', $args: ['a', 0] }, $as: 'x' }],
    },
    'exponent literal': {
      $groupBy: ['g'],
      $select: [{ $fn: 'sum', $expr: { $op: '*', $args: ['a', 1e21] }, $as: 'x' }, { $fn: 'sum', $expr: { $op: '*', $args: ['a', 1.5e-7] }, $as: 'y' }],
    },
    'first / last': {
      $groupBy: ['g'],
      $select: [{ $fn: 'first', $field: 'title', $as: 'f' }, { $fn: 'last', $field: 'title', $as: 'l' }, { $fn: 'first', $field: 'at', $as: 'first_at' }],
      $rowOrder: { at: -1, id: 1 },
    },
    'mixed with bucket': {
      $groupBy: ['w'],
      $select: [
        { $bucket: 'week', $field: 'at', $as: 'w' },
        { $fn: 'sum', $expr: { $op: '*', $args: ['a', 2] }, $as: 's' },
        { $expr: { $op: '*', $args: ['s', 2] }, $as: 'd' },
      ],
    },
  }
  for (const [name, controls] of Object.entries(controlsCases)) {
    it(`round-trips: ${name}`, () => {
      expect(trip(controls)).toEqual(controls)
      expect(tripUrl(controls)).toEqual(controls)
    })
  }

  it('the URL has no raw + and survives a real URL parse', () => {
    const url = buildUrl({
      controls: { $groupBy: ['g'], $select: [{ $expr: { $op: '+', $args: ['a', 'b'] }, $as: 'x' }] },
    })
    expect(url).not.toContain('+')
    expect(url).toContain('expr(a%2Bb):x')
    // `URLSearchParams` would turn a raw + into a space; %2B stays a plus
    expect(new URLSearchParams(url).get('$select')).toBe('expr(a+b):x')
  })

  it('a bare-name expression aggregate reads back as the equivalent field aggregate', () => {
    expect(buildUrl({ controls: { $select: [{ $fn: 'sum', $expr: 'a', $as: 's' }] } })).toBe('$select=sum(a):s')
    expect(trip({ $select: [{ $fn: 'sum', $expr: 'a', $as: 's' }] })).toEqual({
      $select: [{ $fn: 'sum', $field: 'a', $as: 's' }],
    })
    // a bare name in a group-level expression keeps its form (expr is reserved)
    expect(trip({ $select: [{ $expr: 'a', $as: 'x' }] })).toEqual({ $select: [{ $expr: 'a', $as: 'x' }] })
  })

  it('adds a default alias to a first/last item that has none, like other aggregates', () => {
    expect(buildUrl({ controls: { $select: [{ $fn: 'first', $field: 'at' }] } })).toBe('$select=first(at)')
  })

  it('refuses an expression without $as and a malformed expression', () => {
    expect(() => buildUrl({ controls: { $select: [{ $expr: 'a' } as never] } })).toThrow(/needs a \$as alias/)
    expect(() => buildUrl({ controls: { $select: [{ $fn: 'sum', $expr: 'a', $as: '' }] } })).toThrow(/needs a \$as alias/)
    expect(() => buildUrl({ controls: { $select: [{ $expr: { $op: '%', $args: ['a', 'b'] }, $as: 'x' } as never] } })).toThrow(
      /Unknown operator/,
    )
    expect(() => buildUrl({ controls: { $select: [{ $expr: Number.NaN, $as: 'x' }] } })).toThrow(/not finite/)
  })

  it('writes $rowOrder like $sort and keeps it out of the pass-through', () => {
    expect(buildUrl({ controls: { $rowOrder: { a: 1, b: -1 } } })).toBe('$rowOrder=a,-b')
    expect(buildUrl({ controls: { $rowOrder: {} } })).toBe('')
    expect(trip({ $rowOrder: { a: 1, b: -1 } })).toEqual({ $rowOrder: { a: 1, b: -1 } })
  })
})
