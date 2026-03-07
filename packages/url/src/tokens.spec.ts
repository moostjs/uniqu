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
})
