import { describe, it, expect } from 'vitest'
import { buildUrl } from './builder'
import { parseUrl } from './parse-url'
import type { Uniquery } from '@uniqu/core'

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
    expect(buildUrl({ filter: { name: { $regex: '/^Jo/i' } } })).toBe('name~=/^Jo/i')
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

  it('quotes string with ampersand', () => {
    expect(buildUrl({ filter: { name: 'A&B' } })).toBe("name='A&B'")
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

  it('quotes string with parentheses', () => {
    expect(buildUrl({ filter: { name: 'a(b)' } })).toBe("name='a(b)'")
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
    expect(buildUrl({ filter: { name: { $regex: '/^test/gi' } } })).toBe('name~=/^test/gi')
  })

  it('RegExp object in $regex', () => {
    expect(buildUrl({ filter: { name: { $regex: /^Ali/i } } })).toBe('name~=/^Ali/i')
  })

  it('RegExp as direct field value', () => {
    expect(buildUrl({ filter: { name: /^Ali/i } as any })).toBe('name~=/^Ali/i')
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
    expect(url).toBe('firstName~=/^Ali/i^email~=/^Ali/i^id=1')
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
  function roundTrip(query: Uniquery) {
    const url = buildUrl(query)
    return parseUrl(url)
  }

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
