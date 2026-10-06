import { describe, it, expect } from 'vitest'
import {
  ARITH_MAX_DEPTH,
  ARITH_MAX_NODES,
  arithNames,
  arithNullable,
  formatArith,
  parseArith,
  validateArith,
} from './arith'
import type { ArithExpr } from './types'

const bin = (op: '+' | '-' | '*' | '/', a: ArithExpr, b: ArithExpr): ArithExpr => ({ $op: op, $args: [a, b] })
const neg = (a: ArithExpr): ArithExpr => ({ $op: '-', $args: [a] })

describe('parseArith', () => {
  it('parses names, numbers and precedence', () => {
    expect(parseArith('a')).toBe('a')
    expect(parseArith('2.5')).toBe(2.5)
    expect(parseArith('a+b*c')).toEqual(bin('+', 'a', bin('*', 'b', 'c')))
    expect(parseArith('(a+b)*c')).toEqual(bin('*', bin('+', 'a', 'b'), 'c'))
  })

  it('is left-associative', () => {
    expect(parseArith('a-b-c')).toEqual(bin('-', bin('-', 'a', 'b'), 'c'))
    expect(parseArith('a/b/c')).toEqual(bin('/', bin('/', 'a', 'b'), 'c'))
    expect(parseArith('a-(b-c)')).toEqual(bin('-', 'a', bin('-', 'b', 'c')))
  })

  it('folds "-" before a number into a literal; -(5) stays a negation', () => {
    expect(parseArith('-5')).toBe(-5)
    expect(parseArith('-(5)')).toEqual(neg(5))
    expect(parseArith('a--5')).toEqual(bin('-', 'a', -5))
    expect(parseArith('a - -5')).toEqual(bin('-', 'a', -5))
    expect(parseArith('-a')).toEqual(neg('a'))
    expect(parseArith('--a')).toEqual(neg(neg('a')))
    expect(parseArith('-a*b')).toEqual(bin('*', neg('a'), 'b'))
    expect(parseArith('-(a*b)')).toEqual(neg(bin('*', 'a', 'b')))
  })

  it('parses exponent literals and dotted names', () => {
    expect(parseArith('1e3*x.y')).toEqual(bin('*', 1000, 'x.y'))
    expect(parseArith('2.5e-3+a')).toEqual(bin('+', 0.0025, 'a'))
  })

  it('parses coalesce with 2+ arguments', () => {
    expect(parseArith('coalesce(a, 0)')).toEqual({ $op: 'coalesce', $args: ['a', 0] })
    expect(parseArith('coalesce(a,b,c+1)')).toEqual({ $op: 'coalesce', $args: ['a', 'b', bin('+', 'c', 1)] })
    expect(() => parseArith('coalesce(a)')).toThrow(/at least 2/)
  })

  it('skips whitespace', () => {
    expect(parseArith('  a  +\t b ')).toEqual(bin('+', 'a', 'b'))
  })

  it('throws SyntaxError with an offset', () => {
    expect(() => parseArith('')).toThrow(SyntaxError)
    expect(() => parseArith('a+')).toThrow(/Unexpected end of expression at offset 2/)
    expect(() => parseArith('a b')).toThrow(/Missing operator before "b" at offset 2/)
    expect(() => parseArith('open 1')).toThrow(/Missing operator/)
    expect(() => parseArith('(a+b')).toThrow(/Expected "\)"/)
    expect(() => parseArith('a)')).toThrow(/Unexpected "\)"/)
    expect(() => parseArith('a $ b')).toThrow(/Unexpected character "\$" at offset 2/)
    expect(() => parseArith('sum(a)')).toThrow(/Unknown function "sum"/)
    expect(() => parseArith('a*/b')).toThrow(/Unexpected "\/"/)
  })

  it('rejects a literal that underflows to 0', () => {
    expect(() => parseArith('1e-400')).toThrow(/underflows/)
    expect(parseArith('0e5')).toBe(0)
  })

  it('does not overflow the stack on deep nesting', () => {
    expect(() => parseArith('('.repeat(5000) + 'a' + ')'.repeat(5000))).toThrow(/nested too deeply/)
    expect(() => parseArith('-'.repeat(5000) + 'a')).toThrow(/nested too deeply/)
  })
})

describe('formatArith', () => {
  it('rejects a hostile deep tree with a TypeError instead of overflowing the stack', () => {
    let e: ArithExpr = 'a'
    for (let i = 0; i < 100_000; i++) e = { $op: '-', $args: [e] } as ArithExpr
    expect(() => formatArith(e)).toThrow(TypeError)
  })

  it('prints minimal parentheses', () => {
    expect(formatArith(bin('+', 'a', bin('*', 'b', 'c')))).toBe('a+b*c')
    expect(formatArith(bin('*', bin('+', 'a', 'b'), 'c'))).toBe('(a+b)*c')
    expect(formatArith(bin('-', bin('-', 'a', 'b'), 'c'))).toBe('a-b-c')
    expect(formatArith(bin('-', 'a', bin('-', 'b', 'c')))).toBe('a-(b-c)')
    expect(formatArith(bin('/', 'a', bin('*', 'b', 'c')))).toBe('a/(b*c)')
    expect(formatArith(bin('+', 'a', bin('+', 'b', 'c')))).toBe('a+(b+c)')
  })

  it('prints negative literals as -5 and negation of a literal as -(5)', () => {
    expect(formatArith(-5)).toBe('-5')
    expect(formatArith(neg(5))).toBe('-(5)')
    expect(formatArith(neg(-5))).toBe('-(-5)')
    expect(formatArith(neg('a'))).toBe('-a')
    expect(formatArith(neg(neg('a')))).toBe('--a')
    expect(formatArith(neg(bin('+', 'a', 'b')))).toBe('-(a+b)')
    expect(formatArith(bin('*', neg('a'), 'b'))).toBe('-a*b')
    expect(formatArith(bin('-', 'a', -5))).toBe('a--5')
  })

  it('encodes + only on request, including inside coalesce', () => {
    const e = bin('+', bin('*', 'open', 10), 'sevMax')
    expect(formatArith(e)).toBe('open*10+sevMax')
    expect(formatArith(e, { encodePlus: true })).toBe('open*10%2BsevMax')
    expect(formatArith({ $op: 'coalesce', $args: ['a', bin('+', 'b', 1)] }, { encodePlus: true })).toBe(
      'coalesce(a,b%2B1)',
    )
  })

  it('prints exponent numbers without a plus sign', () => {
    expect(formatArith(bin('*', 'a', 1e21))).toBe('a*1e21')
    expect(formatArith(bin('*', 'a', 1.5e-7))).toBe('a*1.5e-7')
  })

  it('throws on a malformed expression', () => {
    expect(() => formatArith(Number.NaN)).toThrow(TypeError)
    expect(() => formatArith('a b')).toThrow(/Invalid name/)
    expect(() => formatArith({ $op: '%', $args: ['a', 'b'] } as never)).toThrow(/Unknown operator/)
    expect(() => formatArith({ $op: '*', $args: ['a'] } as never)).toThrow(/takes 2 arguments/)
    expect(() => formatArith({ $op: 'coalesce', $args: ['a'] } as never)).toThrow(/at least 2/)
    expect(() => formatArith({} as never)).toThrow(/Invalid expression/)
  })
})

describe('parseArith ↔ formatArith', () => {
  const cases: ArithExpr[] = [
    'a',
    4,
    -4,
    0.25,
    1e21,
    1.5e-7,
    bin('+', 'a', 'b'),
    bin('-', 'a', bin('-', 'b', 'c')),
    bin('-', bin('-', 'a', 'b'), 'c'),
    bin('/', 'a', bin('/', 'b', 'c')),
    bin('*', bin('+', 'a', 'b'), bin('-', 'c', 'd')),
    bin('+', 'a', bin('+', 'b', 'c')),
    bin('-', 'a', -5),
    bin('*', -5, 'a'),
    neg(5),
    neg(-5),
    neg(neg(5)),
    neg('a'),
    neg(neg('a')),
    neg(bin('+', 'a', 'b')),
    bin('*', neg('a'), neg(bin('/', 'b', 'c'))),
    bin('+', neg(2), neg('a')),
    { $op: 'coalesce', $args: ['a', 0] },
    { $op: 'coalesce', $args: [bin('/', 'a', 'b'), neg('c'), -1] },
    bin('+', { $op: 'coalesce', $args: ['a', 'b'] }, 1),
    bin('*', bin('+', bin('*', 'open', 10), 'sevMax'), 'x.y'),
  ]
  for (const encodePlus of [false, true]) {
    it.each(cases.map((c) => [JSON.stringify(c), c] as const))(
      `round-trips %s (encodePlus=${encodePlus})`,
      (_name, expr) => {
        const text = formatArith(expr, { encodePlus })
        const decoded = encodePlus ? decodeURIComponent(text) : text
        expect(parseArith(decoded)).toEqual(expr)
        // A raw + is read as plus too
        expect(parseArith(formatArith(expr))).toEqual(expr)
      },
    )
  }
})

describe('arithNames on hostile input', () => {
  it('reads a 10k-deep chain without a stack overflow, in left-to-right order', () => {
    let e: ArithExpr = 'a'
    for (let i = 0; i < 10_000; i++) e = { $op: '+', $args: [e, 'b'] }
    expect(arithNames(e)).toEqual(['a', 'b'])
  })
})

describe('arithNames / arithNullable', () => {
  it('lists distinct names in first-use order', () => {
    expect(arithNames(parseArith('a*b+a/coalesce(c,1)-2'))).toEqual(['a', 'b', 'c'])
    expect(arithNames(5)).toEqual([])
  })

  it('follows the nullability rules', () => {
    const optional = (n: string) => n === 'opt'
    expect(arithNullable(parseArith('a+b'), optional)).toBe(false)
    expect(arithNullable(parseArith('a+opt'), optional)).toBe(true)
    expect(arithNullable(parseArith('-opt'), optional)).toBe(true)
    expect(arithNullable(parseArith('a/b'), optional)).toBe(true)
    expect(arithNullable(parseArith('coalesce(opt,0)'), optional)).toBe(false)
    expect(arithNullable(parseArith('coalesce(opt,opt)'), optional)).toBe(true)
    expect(arithNullable(2, optional)).toBe(false)
  })
})

describe('validateArith', () => {
  it('accepts a valid expression', () => {
    expect(validateArith(parseArith('a*b+coalesce(c,0)'))).toEqual([])
  })

  it('rejects a constant expression', () => {
    expect(validateArith(parseArith('1+2'))).toEqual([
      { path: '$select', message: 'Expression has no field or alias — a constant is not allowed' },
    ])
    expect(validateArith(5)).toHaveLength(1)
  })

  it('checks shapes and arities', () => {
    expect(validateArith({ $op: '*', $args: ['a'] })[0].message).toMatch(/takes 2 arguments/)
    expect(validateArith({ $op: '-', $args: ['a', 'b', 'c'] })[0].message).toMatch(/1 or 2 arguments/)
    expect(validateArith({ $op: 'coalesce', $args: ['a'] })[0].message).toMatch(/at least 2/)
    expect(validateArith({ $op: '%', $args: ['a', 'b'] })[0].message).toMatch(/Unknown operator/)
    expect(validateArith({ nope: 1 })[0].message).toMatch(/Invalid expression/)
    expect(validateArith(null)[0].message).toMatch(/Invalid expression/)
    expect(validateArith(true)[0].message).toMatch(/Invalid expression/)
    expect(validateArith('a b')[0].message).toMatch(/Invalid name/)
  })

  it('checks literal bounds', () => {
    expect(validateArith(bin('+', 'a', Number.NaN))[0].message).toMatch(/not finite/)
    expect(validateArith(bin('+', 'a', Infinity))[0].message).toMatch(/not finite/)
    expect(validateArith(bin('+', 'a', 2 ** 60))[0].message).toMatch(/safe integer/)
    expect(validateArith(bin('+', 'a', Number.MAX_SAFE_INTEGER))).toEqual([])
    expect(validateArith(bin('+', 'a', -Number.MAX_SAFE_INTEGER))).toEqual([])
  })

  it('limits the node count', () => {
    const wide = (n: number): ArithExpr => ({
      $op: 'coalesce',
      $args: Array.from({ length: n }, () => 'a') as [ArithExpr, ArithExpr, ...ArithExpr[]],
    })
    expect(ARITH_MAX_NODES).toBe(64)
    expect(validateArith(wide(63))).toEqual([]) // 1 + 63 = 64 nodes
    expect(validateArith(wide(64))[0].message).toMatch(/too large/)
  })

  it('limits the depth', () => {
    const nest = (levels: number): ArithExpr => {
      let e: ArithExpr = 'a'
      for (let i = 1; i < levels; i++) e = neg(e)
      return e
    }
    expect(ARITH_MAX_DEPTH).toBe(16)
    expect(validateArith(nest(16))).toEqual([])
    expect(validateArith(nest(17))[0].message).toMatch(/nested too deeply/)
  })
})
