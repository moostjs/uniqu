import type { Token, TokenType } from './tokens'
import type {
  FilterExpr,
  ComparisonNode,
  ComparisonOp,
  Primitive,
  RelationOp,
} from '@uniqu/core'
import { isPrimitive, isLogicalKey, isRelationOp } from '@uniqu/core'

const opMap: Partial<Record<TokenType, ComparisonOp>> = {
  'op-eq': '$eq',
  'op-ne': '$ne',
  'op-gt': '$gt',
  'op-gte': '$gte',
  'op-lt': '$lt',
  'op-lte': '$lte',
  'op-regex': '$regex',
}

/**
 * Hard cap on `$some(` / `$none(` nesting in a URL filter: a stack-safety
 * bound for the recursive parser and filter walkers, far above any
 * consumer's own nesting limit.
 */
const MAX_RELATION_DEPTH = 32

export class Parser {
  private i = 0
  /** Current relational predicate nesting depth (bounded by `MAX_RELATION_DEPTH`). */
  private relDepth = 0

  constructor(private readonly t: Token[]) {}

  /* ── helpers ─────────────────────────────────────────── */

  private peek(offset = 0) {
    return this.t[this.i + offset]
  }

  private consume(type?: TokenType) {
    const tok = this.t[this.i++]
    if (!tok) {
      throw new SyntaxError(`Expected ${type ?? 'a token'}, got end of input`)
    }
    if (type && tok.type !== type) {
      throw new SyntaxError(
        `Expected ${type}, got "${tok.value}" at pos ${tok.pos}`,
      )
    }
    return tok
  }

  private match(type: TokenType) {
    if (this.peek()?.type === type) {
      this.consume()
      return true
    }
    return false
  }

  expectEof() {
    if (this.i !== this.t.length)
      throw new SyntaxError(
        `Unexpected token at pos ${this.t[this.i]?.pos}. End of input expected.`,
      )
  }

  /* ── grammar ─────────────────────────────────────────── */

  /** expression := disjunction */
  parseExpression(): FilterExpr {
    return this.parseDisjunction()
  }

  private parseDisjunction(): FilterExpr {
    let node = this.parseConjunction()
    const orNodes: FilterExpr[] = [node]

    while (this.match('or')) {
      orNodes.push(this.parseConjunction())
    }

    return orNodes.length === 1 ? node : { $or: orNodes }
  }

  private parseConjunction(): FilterExpr {
    const nodes: FilterExpr[] = [this.parseTerm()]
    while (this.match('and')) nodes.push(this.parseTerm())

    if (nodes.length === 1) return nodes[0]

    const merged = mergeConjunction(nodes)
    return merged ?? { $and: nodes }
  }

  private parseTerm(): FilterExpr {
    if (!this.peek()) {
      const last = this.t[this.t.length - 1]
      throw new SyntaxError(
        `Unexpected end of input${last ? ` after "${last.value}" at pos ${last.pos}` : ''}`,
      )
    }

    /* NOT group  !(expr) */
    if (this.peek()?.type === 'bang' && this.peek(1)?.type === 'lparen') {
      this.consume('bang')
      this.consume('lparen')
      const inside = this.parseDisjunction()
      this.consume('rparen')
      return { $not: inside }
    }

    /* group */
    if (this.match('lparen')) {
      const inside = this.parseDisjunction()
      this.consume('rparen')
      return inside
    }

    /* BETWEEN: literal (<|<=) path (<|<=) literal */
    if (
      this.peek().type === 'number' ||
      this.peek().type === 'string'
    ) {
      const lhsLit = this.parseLiteral()
      const firstOp = this.consume().type as TokenType
      if (firstOp !== 'op-lt' && firstOp !== 'op-lte') {
        this.i -= 2
      } else {
        const field = this.consume('word').value
        const secondOpTok = this.consume()
        if (
          secondOpTok.type !== 'op-lt' &&
          secondOpTok.type !== 'op-lte'
        ) {
          throw new SyntaxError(
            `Invalid between syntax at pos ${secondOpTok.pos}`,
          )
        }
        const rhsLit = this.parseLiteral()
        const out: FilterExpr = {}
        const op1: ComparisonOp =
          firstOp === 'op-lt' ? '$gt' : '$gte'
        const op2: ComparisonOp =
          secondOpTok.type === 'op-lt' ? '$lt' : '$lte'
        out[field] = {
          [op1]: lhsLit,
          [op2]: rhsLit,
        }
        return out
      }
    }

    /* $exists / $!exists */
    if (this.peek().type === 'keyword') {
      const kwTok = this.peek()
      if (kwTok.value === '$exists' || kwTok.value === '$!exists') {
        this.consume('keyword')
        this.consume('op-eq')
        const fields: string[] = []
        fields.push(this.consume('word').value)
        while (this.match('comma'))
          fields.push(this.consume('word').value)
        return buildExists(fields, kwTok.value === '$exists')
      }
    }

    /* IN / NIN list   word {!} { lit , lit } */
    if (
      (this.peek().type === 'word' && this.peek(1)?.type === 'lbrace') ||
      (this.peek(1)?.type === 'bang' && this.peek(2)?.type === 'lbrace')
    ) {
      const field = this.consume('word').value
      let negate = false
      if (this.match('bang')) negate = true
      this.consume('lbrace')
      const list: Primitive[] = []
      // `field{}` / `field!{}`: an empty list (matches nothing / excludes nothing)
      if (this.peek()?.type !== 'rbrace') {
        list.push(this.parseLiteral())
        while (this.match('comma')) list.push(this.parseLiteral())
      }
      this.consume('rbrace')

      const out: FilterExpr = {}
      const op: ComparisonOp = negate ? '$nin' : '$in'
      out[field] = { [op]: list }
      return out
    }

    /* comparison   path op lit */
    const fieldTok = this.consume('word')
    const opTok = this.consume() as Token

    /* relational predicate   path = $some( [expr] )  |  path = $none( [expr] ) */
    const relTok = this.peek()
    if (relTok?.type === 'keyword' && isRelationOp(relTok.value)) {
      return this.parseRelation(fieldTok.value, opTok, relTok)
    }

    const lit = this.parseLiteral()
    const op = opMap[opTok.type]
    const field = fieldTok.value
    if (op === undefined)
      throw new SyntaxError(
        `Unsupported operator "${opTok.value}" at pos ${opTok.pos}`,
      )

    return op === '$eq'
      ? { [field]: lit }
      : { [field]: { [op]: lit } }
  }

  /**
   * `field=$some(<expr>)` / `field=$none(<expr>)` → `{ field: { $some: <expr | {}> } }`.
   */
  private parseRelation(field: string, opTok: Token, relTok: Token): FilterExpr {
    const op = relTok.value as RelationOp
    if (opTok.type !== 'op-eq') {
      throw new SyntaxError(
        `Relational predicate "${op}" must follow "=" (got "${opTok.value}" at pos ${opTok.pos}); negate with ${field}=$none(…) or !(…)`,
      )
    }
    if (this.relDepth >= MAX_RELATION_DEPTH) {
      throw new SyntaxError(
        `Relational predicates nested deeper than ${MAX_RELATION_DEPTH} levels at pos ${relTok.pos}`,
      )
    }
    this.consume('keyword')
    this.consume('lparen')
    this.relDepth++
    let operand: FilterExpr = {}
    try {
      if (this.peek()?.type !== 'rparen') operand = this.parseDisjunction()
    } finally {
      this.relDepth--
    }
    this.consume('rparen')
    return { [field]: { [op]: operand } }
  }

  parseLiteral(): Primitive {
    const tok = this.consume()
    switch (tok.type) {
      case 'number':
        return Number(tok.value)
      case 'boolean':
        return tok.value === 'true'
      case 'null':
        return null
      case 'regex':
        return tok.value
      case 'word':
        return tok.value
      case 'string':
        return unescapeString(tok.value)
      default:
        throw new SyntaxError(
          `Unexpected literal "${tok.value}" at pos ${tok.pos}`,
        )
    }
  }
}

/** Body of a single-quoted literal `'…'`: the quotes stripped and `\\x` escapes unescaped. */
export function unescapeString(str: string): string {
  return str.replace(/(^'|'$)/gu, '').replace(/\\(.)/gu, '$1')
}

/**
 * Attempt to merge an array of simple nodes produced by `parseTerm`.
 * Returns a single flattened object if safe, or null on conflict.
 */
function mergeConjunction(nodes: FilterExpr[]): FilterExpr | null {
  const merged: FilterExpr[] = []
  let currentMerge: ComparisonNode = {}
  for (const node of nodes) {
    if (Object.keys(node).some(isLogicalKey)) {
      merged.push(node)
      continue
    }
    for (const [key, val] of Object.entries(node)) {
      if (key in currentMerge) {
        const currentVal = currentMerge[key]
        const currentOps = isPrimitive(currentVal)
          ? ['$eq']
          : Object.keys(currentVal as object)
        const otherOps = isPrimitive(val)
          ? new Set(['$eq'])
          : new Set(Object.keys(val as object))
        const intersects: boolean = currentOps.some((op) => otherOps.has(op))
        // A relational predicate never shares an operator map with comparison
        // operators (`ticket=$some(a=1)&ticket=5` stays two `$and` members):
        // mixed maps are not predicates (`isRelationPredicate`) and consumers
        // reject them, so keep each clause well-formed.
        const mixesKinds = currentOps.some(isRelationOp) !== (otherOps.has('$some') || otherOps.has('$none'))
        if (intersects || mixesKinds) {
          // Same operator twice on one field (or a predicate next to a
          // comparison): close the current object and start the next one
          // with this clause (never drop it).
          merged.push(currentMerge)
          currentMerge = { [key]: val }
        } else {
          const m: Record<string, unknown> = {}
          for (const op of currentOps) {
            m[op] = isPrimitive(currentVal) ? currentVal : (currentVal as Record<string, unknown>)[op]
          }
          for (const op of otherOps) {
            m[op] = isPrimitive(val) ? val : (val as Record<string, unknown>)[op]
          }
          currentMerge[key] = m
        }
      } else {
        currentMerge[key] = val
      }
    }
  }
  if (Object.keys(currentMerge).length > 0) {
    merged.push(currentMerge)
  }

  return merged.length > 1 ? { $and: merged } : (merged[0] ?? null)
}

function buildExists(fields: string[], positive: boolean): FilterExpr {
  const out: FilterExpr = {}
  for (const f of fields) {
    out[f] = { $exists: positive }
  }
  return out
}
