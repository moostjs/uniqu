import { describe, it, expect } from 'vitest'
import { computeInsights } from '@uniqu/core'
import { parseUrl, splitUrlSegments } from './parse-url'

describe('parseUrl – happy-path filters', () => {
  it('simple equality / numeric inference', () => {
    const r = parseUrl('age=25&status=ACTIVE')
    expect(r.filter).toEqual({ age: 25, status: 'ACTIVE' })
  })

  it('only controls', () => {
    const r = parseUrl('$select=name')
    expect(r).toMatchInlineSnapshot(`
      {
        "controls": {
          "$select": [
            "name",
          ],
        },
        "filter": {},
        "insights": Map {
          "name" => Set {
            "$select",
          },
        },
      }
    `)
  })

  it('hex strings (e.g. MongoDB ObjectId) as filter values', () => {
    const r = parseUrl('taskId=69aca32e434504011457636c&tagId=69aca32e434504011457636d')
    expect(r.filter).toEqual({
      taskId: '69aca32e434504011457636c',
      tagId: '69aca32e434504011457636d',
    })
  })

  it('simple equality for props with dots', () => {
    const r = parseUrl('client.age=25&items.0.status=ACTIVE')
    expect(r.filter).toEqual({
      'client.age': 25,
      'items.0.status': 'ACTIVE',
    })
  })

  it('greater / less comparisons', () => {
    const r = parseUrl('age>=18&price<99.99')
    expect(r.filter).toEqual({
      age: { $gte: 18 },
      price: { $lt: 99.99 },
    })
  })

  it('regex operator', () => {
    const r = parseUrl('name~=/^Jo/i')
    expect(r.filter).toEqual({ name: { $regex: '/^Jo/i' } })
  })

  it('strings with space', () => {
    const r = parseUrl('name=John%20Doe')
    expect(r.filter).toEqual({ name: 'John Doe' })
  })

  it('in / nin lists', () => {
    const r = parseUrl('role{Admin,Editor}&status!{Draft,Deleted}')
    expect(r.filter).toEqual({
      role: { $in: ['Admin', 'Editor'] },
      status: { $nin: ['Draft', 'Deleted'] },
    })
  })

  it('between (exclusive)', () => {
    const r = parseUrl('25<age<35')
    expect(r.filter).toEqual({ age: { $gt: 25, $lt: 35 } })
  })

  it('AND via & and OR via ^ (precedence)', () => {
    const q = 'age>25^score>550&status=VIP'
    const r = parseUrl(q)
    expect(r.filter).toEqual({
      $or: [
        { age: { $gt: 25 } },
        { score: { $gt: 550 }, status: 'VIP' },
      ],
    })
  })

  it('grouped parentheses overriding precedence', () => {
    const q = '(age>25&score>550)^status=VIP'
    const r = parseUrl(q)
    expect(r.filter).toEqual({
      $or: [
        { age: { $gt: 25 }, score: { $gt: 550 } },
        { status: 'VIP' },
      ],
    })
  })
})

describe('parseUrl – repeated operator on one field', () => {
  it('keeps every clause of a same-field equality clash', () => {
    expect(parseUrl('status=A&status=B').filter).toEqual({
      $and: [{ status: 'A' }, { status: 'B' }],
    })
  })

  it('keeps every clause of a same-operator comparison clash', () => {
    expect(parseUrl('a>1&a>2').filter).toEqual({ $and: [{ a: { $gt: 1 } }, { a: { $gt: 2 } }] })
  })

  it('keeps the other fields merged around the clash', () => {
    expect(parseUrl('status=A&x=1&status=B&y=2').filter).toEqual({
      $and: [{ status: 'A', x: 1 }, { status: 'B', y: 2 }],
    })
  })

  it('still merges different operators on one field', () => {
    expect(parseUrl('a>1&a<5').filter).toEqual({ a: { $gt: 1, $lt: 5 } })
  })
})

describe('splitUrlSegments', () => {
  it('splits on top-level & only, keeping groups whole', () => {
    expect(splitUrlSegments('a=1&(b=2&c=3)^(d=4&e=5)&$limit=5')).toEqual([
      'a=1',
      '(b=2&c=3)^(d=4&e=5)',
      '$limit=5',
    ])
  })

  it('keeps empty segments and does not decode', () => {
    expect(splitUrlSegments('&a=%20&')).toEqual(['', 'a=%20', ''])
  })
})

describe('parseUrl – projection / options keywords', () => {
  it('$select include produces array', () => {
    const r = parseUrl('$select=firstName,lastName&age>=18')
    expect(r.controls.$select).toEqual(['firstName', 'lastName'])
    expect((r.filter as Record<string, unknown>).age).toEqual({ $gte: 18 })
  })

  it('$select exclude produces object', () => {
    const r = parseUrl('$select=-password,-client.ssn&status=ACTIVE')
    expect(r.controls.$select).toEqual({ password: 0, 'client.ssn': 0 })
  })

  it('$select mixed (include + exclude) produces object', () => {
    const r = parseUrl('$select=name,email,-password&status=ACTIVE')
    expect(r.controls.$select).toEqual({ name: 1, email: 1, password: 0 })
  })

  it('order, limit, skip', () => {
    const r = parseUrl('$order=-createdAt,score&$limit=20&$skip=40')
    expect(r.controls).toEqual({
      $sort: { createdAt: -1, score: 1 },
      $limit: 20,
      $skip: 40,
    })
  })

  it('$count flag', () => {
    const r = parseUrl('$count&status=ACTIVE')
    expect(r.controls.$count).toBe(true)
  })
})

describe('parseUrl – exists helpers', () => {
  it('$exists positive list', () => {
    const r = parseUrl('$exists=client.phone,client.address')
    expect(r.filter).toEqual({
      'client.phone': { $exists: true },
      'client.address': { $exists: true },
    })
  })

  it('$!exists negative list', () => {
    const r = parseUrl('$!exists=meta.deletedAt')
    expect(r.filter).toEqual({ 'meta.deletedAt': { $exists: false } })
  })
})

describe('parseUrl – literal typing edge-cases', () => {
  it('numeric vs string with quotes', () => {
    const r = parseUrl("code='25'&limit=25")
    expect((r.filter as Record<string, unknown>).code).toBe('25')
    expect((r.filter as Record<string, unknown>).limit).toBe(25)
  })

  it('boolean vs string', () => {
    const r = parseUrl("flag=true&label='true'")
    expect((r.filter as Record<string, unknown>).flag).toBe(true)
    expect((r.filter as Record<string, unknown>).label).toBe('true')
  })

  it('null vs string', () => {
    const r = parseUrl("deleted=null&note='null'")
    expect((r.filter as Record<string, unknown>).deleted).toBeNull()
    expect((r.filter as Record<string, unknown>).note).toBe('null')
  })

  it('escaped quote inside quoted string', () => {
    const r = parseUrl("name='John\\'s'")
    expect((r.filter as Record<string, unknown>).name).toBe("John's")
  })

  it('escaped backslash inside quoted string', () => {
    const r = parseUrl("path='a\\\\b'")
    expect((r.filter as Record<string, unknown>).path).toBe('a\\b')
  })

  it('leading-zero number treated as string', () => {
    const r = parseUrl('code=007')
    expect((r.filter as Record<string, unknown>).code).toBe('007')
  })

  it('bare word with interior hyphens is a string', () => {
    expect(parseUrl('status=in-progress').filter).toEqual({ status: 'in-progress' })
    expect(parseUrl('status!=in-progress&id=a1b2-c3d4-e5').filter).toEqual({
      status: { $ne: 'in-progress' },
      id: 'a1b2-c3d4-e5',
    })
    expect(parseUrl('status{in-progress,on-hold}^x=a--b').filter).toEqual({
      $or: [{ status: { $in: ['in-progress', 'on-hold'] } }, { x: 'a--b' }],
    })
    expect(parseUrl('ticket=$some(status=in-progress)').filter).toEqual({
      ticket: { $some: { status: 'in-progress' } },
    })
  })

  it('bare dates and digit-led hyphenated words are strings, numbers stay numbers', () => {
    expect(parseUrl('d>=2026-01-01&d<2026-02-01').filter).toEqual({
      d: { $gte: '2026-01-01', $lt: '2026-02-01' },
    })
    expect(parseUrl('2026-01-01<=d<2026-02-01').filter).toEqual({
      d: { $gte: '2026-01-01', $lt: '2026-02-01' },
    })
    expect(parseUrl('a=5-3&b=1e-5').filter).toEqual({ a: '5-3', b: '1e-5' })
    expect(parseUrl('a=-5&b>=-3.5&c=0').filter).toEqual({ a: -5, b: { $gte: -3.5 }, c: 0 })
    expect(parseUrl('-5<a<-1').filter).toEqual({ a: { $gt: -5, $lt: -1 } })
  })

  it('bare local date-times (hour labels) are strings', () => {
    expect(parseUrl('h=2026-03-29T14:00').filter).toEqual({ h: '2026-03-29T14:00' })
    expect(parseUrl('h>=2026-03-29T14:00:30&h<2026-03-29T16:00').filter).toEqual({
      h: { $gte: '2026-03-29T14:00:30', $lt: '2026-03-29T16:00' },
    })
    expect(parseUrl('2026-03-29T14:00<=h<2026-03-29T16:00').filter).toEqual({
      h: { $gte: '2026-03-29T14:00', $lt: '2026-03-29T16:00' },
    })
    expect(parseUrl('h{2026-03-29T14:00,2026-03-29T15:00}&t=$some(h=2026-03-29T14:00)').filter).toEqual({
      h: { $in: ['2026-03-29T14:00', '2026-03-29T15:00'] },
      t: { $some: { h: '2026-03-29T14:00' } },
    })
    expect(parseUrl('$having=h>2026-03-29T14:00').controls.$having).toEqual({ h: { $gt: '2026-03-29T14:00' } })
    // Any other shape with `:` must be quoted.
    for (const q of ['h=2026-03-29T14:00:00.000Z', 'h=2026-03-29T14:00Z', 'h=2026-03-29T4:00', 'h=a:b']) {
      expect(() => parseUrl(q), q).toThrow(SyntaxError)
    }
    expect(parseUrl("h='2026-03-29T14:00:00.000Z'").filter).toEqual({ h: '2026-03-29T14:00:00.000Z' })
  })

  it('hyphenated words next to spaces stay multi-word strings', () => {
    expect(parseUrl('a=in-progress now').filter).toEqual({ a: 'in-progress now' })
    expect(parseUrl('a=say in-progress').filter).toEqual({ a: 'say in-progress' })
  })

  it('words that start with a literal keyword or number are strings', () => {
    expect(parseUrl('a=nullable&b=trueish&c=falsehood&d=1.5.3').filter).toEqual({
      a: 'nullable',
      b: 'trueish',
      c: 'falsehood',
      d: '1.5.3',
    })
    expect(parseUrl('a=null&b=true&c=1.5').filter).toEqual({ a: null, b: true, c: 1.5 })
  })

  it('leading / trailing hyphens and hyphenated field names are still rejected', () => {
    expect(() => parseUrl('a=-x')).toThrow(SyntaxError)
    expect(() => parseUrl('a=x-')).toThrow(SyntaxError)
    expect(() => parseUrl('my-field=1')).toThrow(SyntaxError)
    expect(() => parseUrl('$exists=my-field')).toThrow(SyntaxError)
  })

  it('regex flags preserved', () => {
    const r = parseUrl('name~=/^a.+z/im')
    expect((r.filter as Record<string, unknown>).name).toEqual({
      $regex: '/^a.+z/im',
    })
  })
})

describe('parseUrl – error cases', () => {
  it('double equals should throw', () => {
    expect(() => parseUrl('name==John')).toThrow()
  })

  it('unbalanced parentheses should throw', () => {
    expect(() => parseUrl('(age>25&score>550')).toThrow()
  })

  it('unknown $keyword should pass through', () => {
    expect(() => parseUrl('$foo=bar')).not.toThrow()
    expect(parseUrl('$foo=bar')).toEqual({
      filter: {},
      controls: { $foo: 'bar' },
      insights: new Map(),
    })
  })
})

describe('parseUrl – kitchen-sink query', () => {
  it('parses full-feature query correctly', () => {
    const big =
      `$select=firstName,-client.ssn` +
      `&$order=-createdAt,score` +
      `&$limit=50&$skip=10` +
      `&$count` +
      `&$exists=client.phone` +
      `&$!exists=deletedAt` +
      `&` +
      `client.age>=18&client.age<=30&` +
      `status!=DELETED&` +
      `name~=/^Jo/i&` +
      `role{Admin,Editor}&` +
      `category!{obsolete,temp}&` +
      `25<height<35` +
      `^` +
      `score>550&` +
      `price>50&price<100` +
      `&$!exists=deletedFrom`

    const expected = {
      $or: [
        {
          deletedAt: { $exists: false },
          'client.phone': { $exists: true },
          'client.age': { $gte: 18, $lte: 30 },
          status: { $ne: 'DELETED' },
          name: { $regex: '/^Jo/i' },
          role: { $in: ['Admin', 'Editor'] },
          category: { $nin: ['obsolete', 'temp'] },
          height: { $gt: 25, $lt: 35 },
        },
        {
          score: { $gt: 550 },
          price: { $gt: 50, $lt: 100 },
          deletedFrom: { $exists: false },
        },
      ],
    }

    const r = parseUrl(big)

    expect(r.controls).toEqual({
      $select: { firstName: 1, 'client.ssn': 0 },
      $sort: { createdAt: -1, score: 1 },
      $limit: 50,
      $skip: 10,
      $count: true,
    })

    expect(r.filter).toEqual(expected)
  })

  it('parses full-feature query correctly v2', () => {
    const big =
      `$select=firstName,-client.ssn` +
      `&$order=-createdAt,score` +
      `&$limit=50&$skip=10` +
      `&$count` +
      `&$exists=client.phone` +
      `&$!exists=deletedAt` +
      `&` +
      `age>=18&age<=30` +
      `&(` +
      `status!=DELETED^` +
      `name~=/^Jo/i^` +
      `role{Admin,Editor}` +
      `)&` +
      `category!{obsolete,temp}&` +
      `25<height<35` +
      `^` +
      `score>550&` +
      `price>50&price<100` +
      `&$!exists=deletedFrom`

    const expected = {
      $or: [
        {
          $and: [
            {
              $or: [
                { status: { $ne: 'DELETED' } },
                { name: { $regex: '/^Jo/i' } },
                { role: { $in: ['Admin', 'Editor'] } },
              ],
            },
            {
              'client.phone': { $exists: true },
              deletedAt: { $exists: false },
              age: { $gte: 18, $lte: 30 },
              category: { $nin: ['obsolete', 'temp'] },
              height: { $gt: 25, $lt: 35 },
            },
          ],
        },
        {
          score: { $gt: 550 },
          price: { $gt: 50, $lt: 100 },
          deletedFrom: { $exists: false },
        },
      ],
    }

    const r = parseUrl(big)

    expect(r.controls).toEqual({
      $select: { firstName: 1, 'client.ssn': 0 },
      $sort: { createdAt: -1, score: 1 },
      $limit: 50,
      $skip: 10,
      $count: true,
    })

    expect(r.filter).toEqual(expected)

    expect(r.insights).toMatchInlineSnapshot(`
      Map {
        "status" => Set {
          "$ne",
        },
        "name" => Set {
          "$regex",
        },
        "role" => Set {
          "$in",
        },
        "client.phone" => Set {
          "$exists",
        },
        "deletedAt" => Set {
          "$exists",
        },
        "age" => Set {
          "$gte",
          "$lte",
        },
        "category" => Set {
          "$nin",
        },
        "height" => Set {
          "$gt",
          "$lt",
        },
        "score" => Set {
          "$gt",
          "$order",
        },
        "price" => Set {
          "$gt",
          "$lt",
        },
        "deletedFrom" => Set {
          "$exists",
        },
        "firstName" => Set {
          "$select",
        },
        "client.ssn" => Set {
          "$select",
        },
        "createdAt" => Set {
          "$order",
        },
      }
    `)
  })
})

describe('parseUrl – $not operator', () => {
  it('simple !(expr)', () => {
    const r = parseUrl('!(age>18&status=active)')
    expect(r.filter).toEqual({
      $not: { age: { $gt: 18 }, status: 'active' },
    })
  })

  it('$not combined with AND', () => {
    const r = parseUrl('!(role{Guest,Anonymous})&age>=18')
    expect(r.filter).toEqual({
      $and: [
        { $not: { role: { $in: ['Guest', 'Anonymous'] } } },
        { age: { $gte: 18 } },
      ],
    })
  })

  it('$not wrapping OR', () => {
    const r = parseUrl('!(status=DELETED^status=ARCHIVED)')
    expect(r.filter).toEqual({
      $not: {
        $or: [{ status: 'DELETED' }, { status: 'ARCHIVED' }],
      },
    })
  })

  it('$not in OR branch', () => {
    const r = parseUrl('age>25^!(status=DELETED)')
    expect(r.filter).toEqual({
      $or: [
        { age: { $gt: 25 } },
        { $not: { status: 'DELETED' } },
      ],
    })
  })

  it('nested $not', () => {
    const r = parseUrl('!(!(age>18))')
    expect(r.filter).toEqual({
      $not: { $not: { age: { $gt: 18 } } },
    })
  })

  it('$not captures insights for inner fields', () => {
    const r = parseUrl('!(age>18&name~=/^Jo/i)')
    expect(r.insights.get('age')).toEqual(new Set(['$gt']))
    expect(r.insights.get('name')).toEqual(new Set(['$regex']))
  })
})

describe('parseUrl – percent-encoded literals', () => {
  it('decodes quoted strings with spaces / %xx', () => {
    const q = "name=%27John%20Doe%27&note=%27text%20with%20spaces%27"
    const r = parseUrl(q)
    expect(r.filter).toEqual({
      name: 'John Doe',
      note: 'text with spaces',
    })
  })

  it('decodes an encoded regex literal', () => {
    const r = parseUrl('name~=%2F%5EJo%2Fi')
    expect(r.filter).toEqual({ name: { $regex: '/^Jo/i' } })
  })
})

describe('parseUrl – $with relation loading', () => {
  it('single relation', () => {
    const r = parseUrl('$with=posts')
    expect(r.controls.$with).toEqual([{ name: 'posts', filter: {}, controls: {} }])
    expect(r.insights.get('posts')).toEqual(new Set(['$with']))
  })

  it('multiple relations', () => {
    const r = parseUrl('$with=posts,comments')
    expect(r.controls.$with).toEqual([
      { name: 'posts', filter: {}, controls: {} },
      { name: 'comments', filter: {}, controls: {} },
    ])
    expect(r.insights.get('posts')).toEqual(new Set(['$with']))
    expect(r.insights.get('comments')).toEqual(new Set(['$with']))
  })

  it('deduplicates relation names', () => {
    const r = parseUrl('$with=posts,posts')
    expect(r.controls.$with).toEqual([{ name: 'posts', filter: {}, controls: {} }])
  })

  it('empty $with value is omitted', () => {
    const r = parseUrl('$with=')
    expect(r.controls.$with).toBeUndefined()
  })

  it('per-relation filter via parens', () => {
    const r = parseUrl('status=active&$with=posts(status=published)')
    expect(r.filter).toEqual({ status: 'active' })
    expect(r.controls.$with).toMatchObject([
      { name: 'posts', filter: { status: 'published' }, controls: {} },
    ])
    expect(r.insights.get('posts')).toEqual(new Set(['$with']))
  })

  it('per-relation sort via parens', () => {
    const r = parseUrl('$with=posts($sort=-createdAt,title)')
    expect(r.controls.$with).toMatchObject([
      { name: 'posts', filter: {}, controls: { $sort: { createdAt: -1, title: 1 } } },
    ])
  })

  it('per-relation limit and skip via parens', () => {
    const r = parseUrl('$with=posts($limit=5&$skip=10)')
    expect(r.controls.$with).toMatchObject([
      { name: 'posts', filter: {}, controls: { $limit: 5, $skip: 10 } },
    ])
  })

  it('per-relation select (include) via parens', () => {
    const r = parseUrl('$with=posts($select=title,createdAt)')
    expect(r.controls.$with).toMatchObject([
      { name: 'posts', filter: {}, controls: { $select: ['title', 'createdAt'] } },
    ])
  })

  it('per-relation select (exclude) via parens', () => {
    const r = parseUrl('$with=posts($select=title,-body)')
    expect(r.controls.$with).toMatchObject([
      { name: 'posts', filter: {}, controls: { $select: { title: 1, body: 0 } } },
    ])
  })

  it('per-relation filter + controls combined', () => {
    const r = parseUrl('$with=posts($sort=-createdAt&$limit=5&status=published)')
    expect(r.controls.$with).toMatchObject([
      {
        name: 'posts',
        filter: { status: 'published' },
        controls: { $sort: { createdAt: -1 }, $limit: 5 },
      },
    ])
  })

  it('nested $with (recursive)', () => {
    const r = parseUrl('$with=posts($with=comments($limit=10))')
    expect(r.controls.$with).toMatchObject([
      {
        name: 'posts',
        filter: {},
        controls: {
          $with: [
            { name: 'comments', filter: {}, controls: { $limit: 10 } },
          ],
        },
      },
    ])
  })

  it('deep nesting with filters', () => {
    const r = parseUrl('$with=posts($with=comments($with=author&status=approved))')
    expect(r.controls.$with).toMatchObject([
      {
        name: 'posts',
        filter: {},
        controls: {
          $with: [
            {
              name: 'comments',
              filter: { status: 'approved' },
              controls: {
                $with: [
                  { name: 'author', filter: {}, controls: {} },
                ],
              },
            },
          ],
        },
      },
    ])
  })

  it('multiple top-level relations with nested $with and filters', () => {
    const r = parseUrl('$with=owner,tasks($with=comments(body~=Great))')
    expect(r.controls.$with).toMatchObject([
      { name: 'owner', filter: {}, controls: {} },
      {
        name: 'tasks',
        filter: {},
        controls: {
          $with: [
            {
              name: 'comments',
              filter: { body: { $regex: 'Great' } },
              controls: {},
            },
          ],
        },
      },
    ])
    // top-level insights bubble with dot-notation
    expect(r.insights.get('owner')).toEqual(new Set(['$with']))
    expect(r.insights.get('tasks')).toEqual(new Set(['$with']))
    expect(r.insights.get('tasks.comments')).toEqual(new Set(['$with']))
    expect(r.insights.get('tasks.comments.body')).toEqual(new Set(['$regex']))

    // each $with block carries its own scoped insights
    const tasks = r.controls.$with![1]
    expect(tasks.insights?.get('comments')).toEqual(new Set(['$with']))
    expect(tasks.insights?.get('comments.body')).toEqual(new Set(['$regex']))

    const comments = tasks.controls.$with![0]
    expect(comments.insights?.get('body')).toEqual(new Set(['$regex']))

    // simple relation has no insights
    expect(r.controls.$with![0].insights).toBeUndefined()
  })

  it('empty parens treated as no sub-query', () => {
    const r = parseUrl('$with=posts()')
    expect(r.controls.$with).toEqual([{ name: 'posts', filter: {}, controls: {} }])
  })

  it('full $with kitchen-sink', () => {
    const r = parseUrl(
      'status=active' +
      '&$with=posts($sort=-createdAt&$limit=5&$select=title,body&status=published),author'
    )
    expect(r.controls.$with).toMatchObject([
      {
        name: 'posts',
        filter: { status: 'published' },
        controls: {
          $sort: { createdAt: -1 },
          $limit: 5,
          $select: ['title', 'body'],
        },
      },
      { name: 'author', filter: {}, controls: {} },
    ])
    expect(r.filter).toEqual({ status: 'active' })
    expect(r.insights.get('posts')).toEqual(new Set(['$with']))
    expect(r.insights.get('author')).toEqual(new Set(['$with']))
  })
})

describe('parseUrl – control words', () => {
  it('supports only control words', () => {
    const r = parseUrl('%24search=test')
    expect(r.controls).toEqual({
      $search: 'test',
    })
  })
})

describe('parseUrl – $groupBy', () => {
  it('single field', () => {
    const r = parseUrl('$groupBy=currency')
    expect(r.controls.$groupBy).toEqual(['currency'])
    expect(r.insights.get('currency')).toEqual(new Set(['$groupBy']))
  })

  it('multiple fields', () => {
    const r = parseUrl('$groupBy=currency,region')
    expect(r.controls.$groupBy).toEqual(['currency', 'region'])
    expect(r.insights.get('currency')).toEqual(new Set(['$groupBy']))
    expect(r.insights.get('region')).toEqual(new Set(['$groupBy']))
  })

  it('empty value is ignored', () => {
    const r = parseUrl('$groupBy=')
    expect(r.controls.$groupBy).toBeUndefined()
  })
})

describe('parseUrl – aggregate functions in $select', () => {
  it('single aggregate', () => {
    const r = parseUrl('$select=sum(amount)')
    expect(r.controls.$select).toEqual([
      { $fn: 'sum', $field: 'amount', $as: 'sum_amount' },
    ])
    expect(r.insights.get('amount')).toEqual(new Set(['sum']))
  })

  it('aggregate with explicit alias', () => {
    const r = parseUrl('$select=sum(amount):total')
    expect(r.controls.$select).toEqual([
      { $fn: 'sum', $field: 'amount', $as: 'total' },
    ])
  })

  it('count(*)', () => {
    const r = parseUrl('$select=count(*)')
    expect(r.controls.$select).toEqual([
      { $fn: 'count', $field: '*', $as: 'count_star' },
    ])
  })

  it('mixed plain fields and aggregates keep their order', () => {
    const r = parseUrl('$select=sum(amount),currency,count(*)')
    expect(r.controls.$select).toEqual([
      { $fn: 'sum', $field: 'amount', $as: 'sum_amount' },
      'currency',
      { $fn: 'count', $field: '*', $as: 'count_star' },
    ])
    expect(r.insights.get('currency')).toEqual(new Set(['$select']))
    expect(r.insights.get('amount')).toEqual(new Set(['sum']))
    expect(r.insights.get('*')).toEqual(new Set(['count']))
  })

  it('multiple aggregates with aliases', () => {
    const r = parseUrl('$select=sum(amount):total,avg(price):avgPrice,min(age)')
    expect(r.controls.$select).toEqual([
      { $fn: 'sum', $field: 'amount', $as: 'total' },
      { $fn: 'avg', $field: 'price', $as: 'avgPrice' },
      { $fn: 'min', $field: 'age', $as: 'min_age' },
    ])
  })

  it('aggregates force array form even with exclusion prefix', () => {
    const r = parseUrl('$select=sum(amount),-password')
    expect(Array.isArray(r.controls.$select)).toBe(true)
  })

  it('dot-notation field in aggregate', () => {
    const r = parseUrl('$select=sum(order.total)')
    expect(r.controls.$select).toEqual([
      { $fn: 'sum', $field: 'order.total', $as: 'sum_order.total' },
    ])
  })

  it('full aggregation query with groupBy, sort, limit', () => {
    const r = parseUrl('$select=sum(amount):total,currency&$groupBy=currency&$sort=-total&$limit=10')
    expect(r.controls.$select).toEqual([
      { $fn: 'sum', $field: 'amount', $as: 'total' },
      'currency',
    ])
    expect(r.controls.$groupBy).toEqual(['currency'])
    expect(r.controls.$sort).toEqual({ total: -1 })
    expect(r.controls.$limit).toBe(10)
    expect(r.insights.get('amount')).toEqual(new Set(['sum', '$order']))
    expect(r.insights.get('currency')).toEqual(new Set(['$select', '$groupBy']))
    expect(r.insights.has('total')).toBe(false)
  })

  it('aggregates inside $with sub-query', () => {
    const r = parseUrl('$with=orders($select=sum(total):revenue&$groupBy=status)')
    const orders = r.controls.$with![0] as { name: string; controls: Record<string, unknown> }
    expect(orders.name).toBe('orders')
    expect(orders.controls.$select).toEqual([
      { $fn: 'sum', $field: 'total', $as: 'revenue' },
    ])
    expect(orders.controls.$groupBy).toEqual(['status'])
  })

  it('all five aggregate functions', () => {
    const r = parseUrl('$select=sum(a),count(b),avg(c),min(d),max(e)')
    expect(r.controls.$select).toEqual([
      { $fn: 'sum', $field: 'a', $as: 'sum_a' },
      { $fn: 'count', $field: 'b', $as: 'count_b' },
      { $fn: 'avg', $field: 'c', $as: 'avg_c' },
      { $fn: 'min', $field: 'd', $as: 'min_d' },
      { $fn: 'max', $field: 'e', $as: 'max_e' },
    ])
  })

  it('countDistinct(field), with and without alias', () => {
    const r = parseUrl('$select=region,countDistinct(customerId),countDistinct(customerId):n&$groupBy=region')
    expect(r.controls.$select).toEqual([
      'region',
      { $fn: 'countDistinct', $field: 'customerId', $as: 'countDistinct_customerId' },
      { $fn: 'countDistinct', $field: 'customerId', $as: 'n' },
    ])
    expect(r.insights.get('customerId')).toEqual(new Set(['countDistinct']))
  })

  it('passes fn(*) through for any function — validation is core\'s (validateAggregateExpr)', () => {
    expect(parseUrl('$select=countDistinct(*),sum(*):s').controls.$select).toEqual([
      { $fn: 'countDistinct', $field: '*', $as: 'countDistinct_star' },
      { $fn: 'sum', $field: '*', $as: 's' },
    ])
  })

  it('custom (unknown) aggregate function', () => {
    const r = parseUrl('$select=stddev(score):sd')
    expect(r.controls.$select).toEqual([
      { $fn: 'stddev', $field: 'score', $as: 'sd' },
    ])
    expect(r.insights.get('score')).toEqual(new Set(['stddev']))
  })

  it('same field with multiple aggregates', () => {
    const r = parseUrl('$select=sum(amount):total,avg(amount):mean')
    expect(r.controls.$select).toEqual([
      { $fn: 'sum', $field: 'amount', $as: 'total' },
      { $fn: 'avg', $field: 'amount', $as: 'mean' },
    ])
    expect(r.insights.get('amount')).toEqual(new Set(['sum', 'avg']))
  })

  it('aggregate combined with filter', () => {
    const r = parseUrl('status=active&$select=count(*):n&$groupBy=category')
    expect(r.filter).toEqual({ status: 'active' })
    expect(r.controls.$select).toEqual([
      { $fn: 'count', $field: '*', $as: 'n' },
    ])
    expect(r.controls.$groupBy).toEqual(['category'])
  })

  it('plain word with parens that is not aggregate stays as string', () => {
    // A word like "name" without parens is a plain field
    const r = parseUrl('$select=name')
    expect(r.controls.$select).toEqual(['name'])
  })

  it('$groupBy with dot-notation fields', () => {
    const r = parseUrl('$groupBy=address.city,address.country')
    expect(r.controls.$groupBy).toEqual(['address.city', 'address.country'])
  })

  it('aggregate insights bubble up from nested $with', () => {
    const r = parseUrl('$with=orders($select=sum(amount):total&$groupBy=status)')
    expect(r.insights.get('orders')).toEqual(new Set(['$with']))
    expect(r.insights.get('orders.amount')).toEqual(new Set(['sum']))
    expect(r.insights.get('orders.status')).toEqual(new Set(['$groupBy']))
  })

  it('percent-encoded aggregate syntax', () => {
    // sum(amount):total percent-encoded
    const r = parseUrl('$select=sum%28amount%29%3Atotal')
    expect(r.controls.$select).toEqual([
      { $fn: 'sum', $field: 'amount', $as: 'total' },
    ])
  })
})

describe('parseUrl – $having', () => {
  it('single condition', () => {
    const r = parseUrl('$having=total>1000')
    expect(r.controls.$having).toEqual({ total: { $gt: 1000 } })
    expect(r.insights.get('total')).toEqual(new Set(['$having']))
  })

  it('multiple $having params AND-merged', () => {
    const r = parseUrl('$having=total>1000&$having=count_star>=5')
    expect(r.controls.$having).toEqual({
      $and: [
        { total: { $gt: 1000 } },
        { count_star: { $gte: 5 } },
      ],
    })
    expect(r.insights.get('total')).toEqual(new Set(['$having']))
    expect(r.insights.get('count_star')).toEqual(new Set(['$having']))
  })

  it('parenthesized multi-condition', () => {
    const r = parseUrl('$having=(total>1000&count_star>=5)')
    expect(r.controls.$having).toEqual({
      total: { $gt: 1000 },
      count_star: { $gte: 5 },
    })
  })

  it('OR via ^', () => {
    const r = parseUrl('$having=total>1000^avg_price<50')
    expect(r.controls.$having).toEqual({
      $or: [
        { total: { $gt: 1000 } },
        { avg_price: { $lt: 50 } },
      ],
    })
  })

  it('NOT via !()', () => {
    const r = parseUrl('$having=!(total<100)')
    expect(r.controls.$having).toEqual({
      $not: { total: { $lt: 100 } },
    })
  })

  it('empty value is ignored', () => {
    const r = parseUrl('$having=')
    expect(r.controls.$having).toBeUndefined()
  })

  it('combined with full aggregation query', () => {
    const r = parseUrl('$select=sum(amount):total,currency&$groupBy=currency&$having=total>1000&$sort=-total')
    expect(r.controls.$having).toEqual({ total: { $gt: 1000 } })
    expect(r.controls.$groupBy).toEqual(['currency'])
    expect(r.controls.$sort).toEqual({ total: -1 })
    // `total` is the alias of sum(amount): $having and $sort resolve to the source field
    expect(r.insights.has('total')).toBe(false)
    expect(r.insights.get('amount')).toEqual(new Set(['sum', '$having', '$order']))
    expect(r.insights.get('currency')).toEqual(new Set(['$select', '$groupBy']))
  })

  it('$sort by aggregate alias resolves insight to real field', () => {
    const r = parseUrl('$select=category,sum(amount):total&$sort=total')
    expect(r.insights.get('amount')).toEqual(new Set(['sum', '$order']))
    expect(r.insights.has('total')).toBe(false)
  })

  it('$sort by aggregate alias (descending) resolves insight to real field', () => {
    const r = parseUrl('$select=sum(amount):total&$sort=-total')
    expect(r.insights.get('amount')).toEqual(new Set(['sum', '$order']))
    expect(r.insights.has('total')).toBe(false)
  })

  it('$sort by non-alias field keeps field name in insight', () => {
    const r = parseUrl('$select=sum(amount):total&$sort=-createdAt')
    expect(r.insights.get('createdAt')).toEqual(new Set(['$order']))
    expect(r.insights.get('amount')).toEqual(new Set(['sum']))
  })

  it('$having inside $with sub-query', () => {
    const r = parseUrl('$with=orders($select=sum(total):revenue&$groupBy=status&$having=revenue>500)')
    const orders = r.controls.$with![0] as { name: string; controls: Record<string, unknown> }
    expect(orders.controls.$having).toEqual({ revenue: { $gt: 500 } })
    // `revenue` is the alias of sum(total)
    expect(r.insights.has('orders.revenue')).toBe(false)
    expect(r.insights.get('orders.total')).toEqual(new Set(['sum', '$having']))
  })
})

// A `$with` body is itself a query string embedded in the outer one, so it is
// percent-decoded once per nesting level — clients that encode the whole
// `$with` value (URLSearchParams, encodeURIComponent) rely on this.
describe('parseUrl – $with body decoding', () => {
  type Rel = { name: string; filter: Record<string, unknown>; controls: Record<string, any> }
  const rels = (qs: string) => parseUrl(qs).controls.$with as Rel[]

  it('decodes a relation body once more than its `$with` segment', () => {
    expect(rels("$with=posts(t='%2541')")[0].filter).toEqual({ t: 'A' })
    expect(rels("$with=posts(t='%41')")[0].filter).toEqual({ t: 'A' })
  })

  it('parses a `$with` value encoded as a whole by URLSearchParams', () => {
    const qs = new URLSearchParams({
      $with: "posts(status=active&$limit=2&name='50%25'),author",
    }).toString()
    // the value's structure is fully percent-encoded
    expect(qs.slice('%24with='.length)).not.toMatch(/[(),&=$']/u)
    const [posts, author] = rels(qs)
    expect(posts).toMatchObject({
      name: 'posts',
      filter: { status: 'active', name: '50%' },
      controls: { $limit: 2 },
    })
    expect(author).toMatchObject({ name: 'author', filter: {}, controls: {} })
  })

  it('parses a `$with` value encoded by encodeURIComponent (raw parens)', () => {
    const [posts, author] = rels(
      '$with=' + encodeURIComponent('posts($sort=-d&$limit=5&x=1),author'),
    )
    expect(posts).toMatchObject({ filter: { x: 1 }, controls: { $sort: { d: -1 }, $limit: 5 } })
    expect(author.name).toBe('author')
  })

  it('parses mixed raw/encoded structure (`posts(a=1)%2Cauthor`)', () => {
    expect(rels('$with=posts(a=1)%2Cauthor').map((r) => [r.name, r.filter])).toEqual([
      ['posts', { a: 1 }],
      ['author', {}],
    ])
  })

  it('keeps a body segment that is not valid percent-encoding at its second decode', () => {
    // Hand-written with a single level of encoding: 0.1.8 threw "URI malformed".
    expect(rels("$with=posts(name='50%25')")[0].filter).toEqual({ name: '50%' })
    const posts = rels("$with=posts($with=c(name='50%25'&x=1))")[0]
    expect((posts.controls.$with[0] as Rel).filter).toEqual({ name: '50%', x: 1 })
  })

  it('still rejects malformed percent-encoding at the top level', () => {
    expect(() => parseUrl("name='50%'")).toThrow(URIError)
  })
})

describe('parseUrl – calendar buckets in $select', () => {
  const select = (qs: string) => parseUrl(qs).controls.$select

  it('parses every argument form (design §9.1 examples)', () => {
    expect(select('$select=bucket(openedAt,day)')).toEqual([
      { $bucket: 'day', $field: 'openedAt', $as: 'day_openedAt' },
    ])
    expect(select("$select=bucket(openedAt,day,'Europe/Berlin'):day")).toEqual([
      { $bucket: 'day', $field: 'openedAt', $tz: 'Europe/Berlin', $as: 'day' },
    ])
    expect(select("$select=bucket(openedAt,week,'America/New_York',sun):wk")).toEqual([
      { $bucket: 'week', $field: 'openedAt', $tz: 'America/New_York', $weekStart: 'sun', $as: 'wk' },
    ])
    expect(select('$select=bucket(openedAt,week,,sun)')).toEqual([
      { $bucket: 'week', $field: 'openedAt', $weekStart: 'sun', $as: 'week_openedAt' },
    ])
  })

  it('accepts a bare zone, and an empty trailing zone slot means the default', () => {
    expect(select('$select=bucket(t,day,Europe/Berlin)')).toEqual([
      { $bucket: 'day', $field: 't', $tz: 'Europe/Berlin', $as: 'day_t' },
    ])
    expect(select('$select=bucket(t,day,Etc/GMT+5):d')).toEqual([
      { $bucket: 'day', $field: 't', $tz: 'Etc/GMT+5', $as: 'd' },
    ])
    expect(select('$select=bucket(t,day,)')).toEqual([{ $bucket: 'day', $field: 't', $as: 'day_t' }])
  })

  it('is syntactic only: unknown unit, week start and zone pass through', () => {
    expect(select("$select=bucket(t,hour,'Mars/Olympus',funday):x")).toEqual([
      { $bucket: 'hour', $field: 't', $tz: 'Mars/Olympus', $weekStart: 'funday', $as: 'x' },
    ])
    // a quoted zone may hold any chars (the core rejects them): commas, parens, escaped quotes
    expect(select("$select=bucket(t,day,'a,b)\\'c'),n")).toEqual([
      { $bucket: 'day', $field: 't', $tz: "a,b)'c", $as: 'day_t' },
      'n',
    ])
    // a dotted source keeps the default alias; the core requires an explicit $as for it
    expect(select('$select=bucket(stats.firstSeenAt,day)')).toEqual([
      { $bucket: 'day', $field: 'stats.firstSeenAt', $as: 'day_stats.firstSeenAt' },
    ])
  })

  it('keeps entry order when mixed with plain fields and aggregates', () => {
    expect(select("$select=bucket(openedAt,week,'Europe/Berlin',sun):week,status,count(*):n")).toEqual([
      { $bucket: 'week', $field: 'openedAt', $tz: 'Europe/Berlin', $weekStart: 'sun', $as: 'week' },
      'status',
      { $fn: 'count', $field: '*', $as: 'n' },
    ])
  })

  it('forces the array form next to an exclusion, like aggregates', () => {
    expect(Array.isArray(select('$select=bucket(t,day),-secret'))).toBe(true)
  })

  it('parses a percent-encoded bucket', () => {
    expect(select('$select=bucket%28openedAt%2Cweek%2C%27Europe%2FBerlin%27%2Csun%29%3Aweek')).toEqual([
      { $bucket: 'week', $field: 'openedAt', $tz: 'Europe/Berlin', $weekStart: 'sun', $as: 'week' },
    ])
  })

  it('parses the design §0 query', () => {
    const r = parseUrl(
      'openedAt>=1772323200000&openedAt<1775001600000' +
        "&$select=bucket(openedAt,week,'Europe/Berlin',sun):week,status,count(*):n" +
        "&$groupBy=week,status&$having=(week>='2026-03-01'&n>0)&$sort=week,status&$limit=50",
    )
    expect(r.filter).toEqual({ openedAt: { $gte: 1772323200000, $lt: 1775001600000 } })
    expect(r.controls).toEqual({
      $select: [
        { $bucket: 'week', $field: 'openedAt', $tz: 'Europe/Berlin', $weekStart: 'sun', $as: 'week' },
        'status',
        { $fn: 'count', $field: '*', $as: 'n' },
      ],
      $groupBy: ['week', 'status'],
      $having: { week: { $gte: '2026-03-01' }, n: { $gt: 0 } },
      $sort: { week: 1, status: 1 },
      $limit: 50,
    })
  })

  it('parses an hour bucket and a $having on its YYYY-MM-DDTHH:00 label', () => {
    const r = parseUrl(
      "$select=bucket(openedAt,hour,'Asia/Kolkata'):h,count(*):n&$groupBy=h&$having=h>='2026-03-29T05:00'&$sort=h",
    )
    expect(r.controls).toEqual({
      $select: [
        { $bucket: 'hour', $field: 'openedAt', $tz: 'Asia/Kolkata', $as: 'h' },
        { $fn: 'count', $field: '*', $as: 'n' },
      ],
      $groupBy: ['h'],
      $having: { h: { $gte: '2026-03-29T05:00' } },
      $sort: { h: 1 },
    })
    expect(select('$select=bucket(openedAt,hour)')).toEqual([{ $bucket: 'hour', $field: 'openedAt', $as: 'hour_openedAt' }])
  })

  it('parses a bucket inside a $with relation', () => {
    const r = parseUrl('$with=orders($select=bucket(createdAt,month):m,sum(total):s&$groupBy=m)')
    const orders = r.controls.$with![0] as { name: string; controls: Record<string, unknown> }
    expect(orders.controls.$select).toEqual([
      { $bucket: 'month', $field: 'createdAt', $as: 'm' },
      { $fn: 'sum', $field: 'total', $as: 's' },
    ])
    expect(r.insights.get('orders.createdAt')).toEqual(new Set(['$bucket', '$groupBy']))
  })

  it('throws on malformed bucket syntax', () => {
    for (const item of [
      'bucket(',
      'bucket()',
      'bucket(a)',
      'bucket(,day)',
      'bucket(a,)',
      'bucket(a,day,UTC,sun,x)',
      'bucket(a,day,UTC,)',
      'bucket(a,day):',
      'bucket(a,day):a-b',
      'bucket(a,day):a:b',
      'bucket(a,day)x',
      'bucket(a,day,Europe Berlin)',
      "bucket(a,day,'unterminated)",
      'bucket(a(b),day)',
      "bucket(a,'day')",
      'bucket(a,day,UTC,s-n)',
    ]) {
      expect(() => parseUrl(`$select=${encodeURIComponent(item)}`), item).toThrow(SyntaxError)
    }
  })
})

describe('parseUrl – calendar bucket insights', () => {
  it('captures the source field with $bucket and resolves alias references', () => {
    const r = parseUrl(
      "$select=bucket(openedAt,week):wk,sum(amount):total&$groupBy=wk&$sort=-wk,total&$having=(wk>='2026-03-01'&total>5)",
    )
    expect(r.insights.get('openedAt')).toEqual(new Set(['$bucket', '$groupBy', '$order', '$having']))
    expect(r.insights.get('amount')).toEqual(new Set(['sum', '$order', '$having']))
    expect(r.insights.has('wk')).toBe(false)
    expect(r.insights.has('total')).toBe(false)
  })

  it('resolves alias references that come before $select', () => {
    const r = parseUrl('$groupBy=d&$sort=d&$select=bucket(t,day):d')
    expect(r.insights.get('t')).toEqual(new Set(['$bucket', '$groupBy', '$order']))
    expect(r.insights.has('d')).toBe(false)
  })

  it('matches core computeInsights for the same query', () => {
    // toEqual compares Maps and Sets regardless of insertion order
    for (const qs of [
      "status=open&$select=bucket(openedAt,week,'Europe/Berlin',sun):week,status,count(*):n" +
        "&$groupBy=week,status&$having=(week>='2026-03-01'&n>0)&$sort=-week",
      '$sort=-total&$select=-secret&a>1&$with=posts($select=sum(v):total&$groupBy=k&$sort=total&x=1),tags',
    ]) {
      const r = parseUrl(qs)
      expect(r.insights, qs).toEqual(computeInsights(r.filter, r.controls))
    }
  })
})

describe('parseUrl – relational predicates', () => {
  it('parses field=$some(<expr>) into a predicate on the nav field', () => {
    const r = parseUrl('ticket=$some(teamId{t1,t2}&status=open)')
    expect(r.filter).toEqual({ ticket: { $some: { teamId: { $in: ['t1', 't2'] }, status: 'open' } } })
  })

  it('parses $none and an empty body', () => {
    expect(parseUrl('ticket=$none()').filter).toEqual({ ticket: { $none: {} } })
    expect(parseUrl('ticket=$some()').filter).toEqual({ ticket: { $some: {} } })
  })

  it('records insights with the nav prefix, nested', () => {
    const r = parseUrl('ticket=$some(status=open&team=$none(name=x))&title=a')
    expect(r.insights.get('ticket')).toEqual(new Set(['$some']))
    expect(r.insights.get('ticket.status')).toEqual(new Set(['$eq']))
    expect(r.insights.get('ticket.team')).toEqual(new Set(['$none']))
    expect(r.insights.get('ticket.team.name')).toEqual(new Set(['$eq']))
    expect(r.insights.get('title')).toEqual(new Set(['$eq']))
    expect(r.insights.has('status')).toBe(false)
    // eager insights match the lazy ones
    expect(r.insights).toEqual(computeInsights(r.filter, r.controls))
  })

  it('keeps OR inside the body and combines with outer OR / NOT', () => {
    expect(parseUrl('ticket=$some(status=open^status=new)').filter).toEqual({
      ticket: { $some: { $or: [{ status: 'open' }, { status: 'new' }] } },
    })
    expect(parseUrl('a=1^!(ticket=$some(status=open))').filter).toEqual({
      $or: [{ a: 1 }, { $not: { ticket: { $some: { status: 'open' } } } }],
    })
  })

  it('ANDs $some and $none on one key into one operator map; repeats stay separate', () => {
    expect(parseUrl('ticket=$some(a=1)&ticket=$none(b=2)').filter).toEqual({
      ticket: { $some: { a: 1 }, $none: { b: 2 } },
    })
    expect(parseUrl('ticket=$some(a=1)&ticket=$some(b=2)').filter).toEqual({
      $and: [{ ticket: { $some: { a: 1 } } }, { ticket: { $some: { b: 2 } } }],
    })
    // a predicate never merges with a comparison on the same key
    expect(parseUrl('ticket=$some(a=1)&ticket=5').filter).toEqual({
      $and: [{ ticket: { $some: { a: 1 } } }, { ticket: 5 }],
    })
    expect(parseUrl('ticket!=5&ticket=$none()').filter).toEqual({
      $and: [{ ticket: { $ne: 5 } }, { ticket: { $none: {} } }],
    })
  })

  it('accepts predicates inside a $with body', () => {
    const r = parseUrl('$with=a(b=$some(c=1))')
    const rel = r.controls.$with![0] as { name: string; filter: unknown }
    expect(rel.name).toBe('a')
    expect(rel.filter).toEqual({ b: { $some: { c: 1 } } })
  })

  it('a quoted value with a paren inside the body', () => {
    expect(parseUrl("ticket=$some(title='a%29b')").filter).toEqual({ ticket: { $some: { title: 'a)b' } } })
  })

  it('rejects malformed predicates', () => {
    expect(() => parseUrl('ticket=$some')).toThrow(SyntaxError)
    expect(() => parseUrl('ticket=$some(status=open')).toThrow()
    expect(() => parseUrl('ticket!=$some(status=open)')).toThrow(/must follow "="/)
    expect(() => parseUrl('ticket>$none()')).toThrow(/must follow "="/)
    expect(() => parseUrl('ticket=$every(status=open)')).toThrow()
  })

  it('an unterminated body is a SyntaxError, never a TypeError', () => {
    for (const q of ['ticket=$some(', 'ticket=$none(', 'ticket=$some(team=$some(', 'a=1&ticket=$some(', '(', '!(']) {
      expect(() => parseUrl(q), q).toThrow(SyntaxError)
    }
  })

  it('caps relational predicate nesting (MAX_RELATION_DEPTH)', () => {
    const nest = (n: number) => 'a=$some('.repeat(n) + ')'.repeat(n)
    expect(() => parseUrl(nest(32))).not.toThrow()
    expect(() => parseUrl(nest(33))).toThrow(/nested deeper than 32/)
    expect(() => parseUrl(nest(2000))).toThrow(SyntaxError)
  })
})
