import { describe, it, expect } from 'vitest'
import { lex } from './tokens'

describe('Lexer', () => {
  it('should tokenize a simple query', () => {
    const tokens = lex('name=John&age>=18')
    expect(tokens).toEqual([
      { pos: 0, type: 'word', value: 'name' },
      { pos: 4, type: 'op-eq', value: '=' },
      { pos: 5, type: 'word', value: 'John' },
      { pos: 9, type: 'and', value: '&' },
      { pos: 10, type: 'word', value: 'age' },
      { pos: 13, type: 'op-gte', value: '>=' },
      { pos: 15, type: 'number', value: '18' },
    ])
  })

  it('should tokenize a free text', () => {
    const tokens = lex('name=John Doe')
    expect(tokens).toEqual([
      { pos: 0, type: 'word', value: 'name' },
      { pos: 4, type: 'op-eq', value: '=' },
      { pos: 5, type: 'string', value: 'John Doe' },
    ])
  })

  it('should tokenize a regex literal', () => {
    const tokens = lex('/^John/i')
    expect(tokens).toEqual([{ pos: 0, type: 'regex', value: '/^John/i' }])
  })

  it('should tokenize hex strings (e.g. ObjectId) as words, not numbers', () => {
    const tokens = lex('taskId=69aca32e434504011457636c')
    expect(tokens).toEqual([
      { pos: 0, type: 'word', value: 'taskId' },
      { pos: 6, type: 'op-eq', value: '=' },
      { pos: 7, type: 'word', value: '69aca32e434504011457636c' },
    ])
  })

  it('should tokenize a list', () => {
    const tokens = lex('role{Admin,Editor}')
    expect(tokens).toEqual([
      { pos: 0, type: 'word', value: 'role' },
      { pos: 4, type: 'lbrace', value: '{' },
      { pos: 5, type: 'word', value: 'Admin' },
      { pos: 10, type: 'comma', value: ',' },
      { pos: 11, type: 'word', value: 'Editor' },
      { pos: 17, type: 'rbrace', value: '}' },
    ])
  })

  it('should tokenize a list of quoted strings containing spaces', () => {
    const tokens = lex("city{'New York','Los Angeles'}")
    expect(tokens).toEqual([
      { pos: 0, type: 'word', value: 'city' },
      { pos: 4, type: 'lbrace', value: '{' },
      { pos: 5, type: 'string', value: "'New York'" },
      { pos: 15, type: 'comma', value: ',' },
      { pos: 16, type: 'string', value: "'Los Angeles'" },
      { pos: 29, type: 'rbrace', value: '}' },
    ])
  })
})

describe('Lexer – relational predicates', () => {
  it('lexes $some / $none as keywords followed by parens', () => {
    expect(lex('ticket=$some(status=open)').map((t) => t.type)).toEqual([
      'word', 'op-eq', 'keyword', 'lparen', 'word', 'op-eq', 'word', 'rparen',
    ])
    expect(lex('ticket=$none()').map((t) => t.value)).toEqual(['ticket', '=', '$none', '(', ')'])
  })
})

describe('Lexer – bare words with hyphens and literal prefixes', () => {
  it('lexes a bare word with interior hyphens as one string token', () => {
    expect(lex('status=in-progress')).toEqual([
      { pos: 0, type: 'word', value: 'status' },
      { pos: 6, type: 'op-eq', value: '=' },
      { pos: 7, type: 'string', value: 'in-progress' },
    ])
    expect(lex('d>=2026-01-01').map((t) => `${t.type}:${t.value}`)).toEqual([
      'word:d', 'op-gte:>=', 'string:2026-01-01',
    ])
  })

  it('lexes a bare local date-time as one string token', () => {
    expect(lex('h>=2026-03-29T14:00:30').map((t) => `${t.type}:${t.value}`)).toEqual([
      'word:h', 'op-gte:>=', 'string:2026-03-29T14:00:30',
    ])
  })

  it('keeps a leading - as a negative number', () => {
    expect(lex('a>-5').map((t) => `${t.type}:${t.value}`)).toEqual(['word:a', 'op-gt:>', 'number:-5'])
  })

  it('lexes a literal-prefixed word (nullable, trueish, 1.5.3) as one word', () => {
    for (const v of ['nullable', 'trueish', 'false_flag', 'null.x', '1.5.3', '5.']) {
      expect(lex(v), v).toEqual([{ pos: 0, type: 'word', value: v }])
    }
  })
})
