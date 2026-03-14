import { describe, it, expect } from 'vitest'
import { parseUrl } from './parse-url'

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
        "status" => Set {
          "$ne",
        },
        "name" => Set {
          "$regex",
        },
        "role" => Set {
          "$in",
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

  it('mixed plain fields and aggregates', () => {
    const r = parseUrl('$select=sum(amount),currency,count(*)')
    expect(r.controls.$select).toEqual([
      'currency',
      { $fn: 'sum', $field: 'amount', $as: 'sum_amount' },
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
      'currency',
      { $fn: 'sum', $field: 'amount', $as: 'total' },
    ])
    expect(r.controls.$groupBy).toEqual(['currency'])
    expect(r.controls.$sort).toEqual({ total: -1 })
    expect(r.controls.$limit).toBe(10)
    expect(r.insights.get('amount')).toEqual(new Set(['sum']))
    expect(r.insights.get('currency')).toEqual(new Set(['$select', '$groupBy']))
    expect(r.insights.get('total')).toEqual(new Set(['$order']))
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
    expect(r.insights.get('total')).toEqual(new Set(['$having', '$order']))
    expect(r.insights.get('currency')).toEqual(new Set(['$select', '$groupBy']))
  })

  it('$having inside $with sub-query', () => {
    const r = parseUrl('$with=orders($select=sum(total):revenue&$groupBy=status&$having=revenue>500)')
    const orders = r.controls.$with![0] as { name: string; controls: Record<string, unknown> }
    expect(orders.controls.$having).toEqual({ revenue: { $gt: 500 } })
    expect(r.insights.get('orders.revenue')).toEqual(new Set(['$having']))
  })
})
