import type { QueryIssue } from './aggregate'
import type { ArithExpr } from './types'

/** Most nodes (literals, names, operators) an arithmetic expression may have. */
export const ARITH_MAX_NODES = 64
/** Deepest nesting an arithmetic expression may have (a leaf is depth 1). */
export const ARITH_MAX_DEPTH = 16
/** Names accepted in an expression: identifiers with dotted paths. */
const NAME_RE = /^[A-Za-z_][\w.]*$/u
/** Nesting of parentheses and unary minus the text parser follows before giving up. */
const MAX_PARSE_NESTING = 64

type Node = Exclude<ArithExpr, number | string>

const BINARY_OPS: readonly string[] = ['+', '-', '*', '/']

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && typeof (v as Node).$op === 'string' && Array.isArray((v as Node).$args)
}

const KNOWN_OPS: readonly string[] = [...BINARY_OPS, 'coalesce']

/**
 * The shape problem of one expression node (not its children), or `undefined`:
 * a non-finite literal, an invalid name, a non-node object, an unknown operator
 * or a wrong arity. Shared by {@link formatArith} (throws) and {@link validateArith} (collects).
 */
function nodeProblem(e: unknown): string | undefined {
  if (typeof e === 'number') return Number.isFinite(e) ? undefined : `Expression literal ${e} is not finite`
  if (typeof e === 'string') return NAME_RE.test(e) ? undefined : `Invalid name "${e}" in expression`
  if (!isNode(e)) return 'Invalid expression: expected a number, a name or an { $op, $args } node'
  const n = e.$args.length
  if (e.$op === 'coalesce') return n < 2 ? 'coalesce needs at least 2 arguments' : undefined
  if (e.$op === '-') return n !== 1 && n !== 2 ? 'Operator "-" takes 1 or 2 arguments' : undefined
  if (BINARY_OPS.includes(e.$op)) return n !== 2 ? `Operator "${e.$op}" takes 2 arguments` : undefined
  return `Unknown operator "${String(e.$op)}" — use + - * / or coalesce`
}

// ── parse ────────────────────────────────────────────────────────────────

type Tok = { t: 'num'; v: number; pos: number } | { t: 'name' | 'op'; v: string; pos: number } | { t: 'end'; v: ''; pos: number }

const NUM_RE = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/uy
const NAME_TOKEN_RE = /[A-Za-z_][\w.]*/uy

function lexArith(text: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/u.test(ch)) {
      i++
      continue
    }
    if ('+-*/(),'.includes(ch)) {
      out.push({ t: 'op', v: ch, pos: i })
      i++
      continue
    }
    NUM_RE.lastIndex = i
    const num = NUM_RE.exec(text)
    if (num) {
      const n = Number(num[0])
      // A non-zero mantissa that collapses to 0 would silently change the value.
      if (n === 0 && /[1-9]/u.test(num[0].split(/[eE]/u)[0])) {
        throw new SyntaxError(`Number "${num[0]}" underflows to 0 at offset ${i}`)
      }
      out.push({ t: 'num', v: n, pos: i })
      i += num[0].length
      continue
    }
    NAME_TOKEN_RE.lastIndex = i
    const name = NAME_TOKEN_RE.exec(text)
    if (name) {
      out.push({ t: 'name', v: name[0], pos: i })
      i += name[0].length
      continue
    }
    throw new SyntaxError(`Unexpected character "${ch}" at offset ${i}`)
  }
  out.push({ t: 'end', v: '', pos: text.length })
  return out
}

/**
 * Parse arithmetic text into an {@link ArithExpr}: `+ - * /` (left-associative,
 * `*` `/` bind tighter), unary `-`, parentheses, number literals, names
 * (`[A-Za-z_][\w.]*`) and `coalesce(a, b, …)`. A `-` directly followed by a
 * number in operand position is a negative literal; `-(5)` is a negation node.
 * Whitespace is skipped. Throws `SyntaxError` with the offset. Syntax only:
 * node and depth limits and "needs a name" are {@link validateArith}'s.
 */
export function parseArith(text: string): ArithExpr {
  const toks = lexArith(text)
  let p = 0
  let nesting = 0
  const peek = () => toks[p]
  const fail = (msg: string, tok: Tok = peek()): never => {
    throw new SyntaxError(`${msg} at offset ${tok.pos}`)
  }
  const isOp = (tok: Tok, v: string) => tok.t === 'op' && tok.v === v
  const enter = () => {
    if (++nesting > MAX_PARSE_NESTING) fail('Expression is nested too deeply')
  }

  function expr(): ArithExpr {
    let left = term()
    while (isOp(peek(), '+') || isOp(peek(), '-')) {
      const op = toks[p++].v as '+' | '-'
      left = { $op: op, $args: [left, term()] }
    }
    return left
  }
  function term(): ArithExpr {
    let left = unary()
    while (isOp(peek(), '*') || isOp(peek(), '/')) {
      const op = toks[p++].v as '*' | '/'
      left = { $op: op, $args: [left, unary()] }
    }
    return left
  }
  function unary(): ArithExpr {
    if (isOp(peek(), '-')) {
      p++
      const next = peek()
      if (next.t === 'num') {
        p++
        return -next.v
      }
      enter()
      const arg = unary()
      nesting--
      return { $op: '-', $args: [arg] }
    }
    return primary()
  }
  function primary(): ArithExpr {
    const tok = peek()
    if (tok.t === 'num') {
      p++
      return tok.v
    }
    if (tok.t === 'name') {
      p++
      if (!isOp(peek(), '(')) return tok.v
      if (tok.v !== 'coalesce') fail(`Unknown function "${tok.v}"`, tok)
      p++
      enter()
      const args: ArithExpr[] = [expr()]
      while (isOp(peek(), ',')) {
        p++
        args.push(expr())
      }
      if (!isOp(peek(), ')')) fail('Expected ")"')
      p++
      nesting--
      if (args.length < 2) fail('coalesce needs at least 2 arguments', tok)
      return { $op: 'coalesce', $args: args as [ArithExpr, ArithExpr, ...ArithExpr[]] }
    }
    if (isOp(tok, '(')) {
      p++
      enter()
      const inner = expr()
      if (!isOp(peek(), ')')) fail('Expected ")"')
      p++
      nesting--
      return inner
    }
    return fail(tok.t === 'end' ? 'Unexpected end of expression' : `Unexpected "${tok.v}"`)
  }

  const result = expr()
  const rest = peek()
  if (rest.t !== 'end') {
    fail(rest.t === 'name' || rest.t === 'num' ? `Missing operator before "${rest.v}"` : `Unexpected "${rest.v}"`)
  }
  return result
}

// ── format ───────────────────────────────────────────────────────────────

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 }

// Differs from `numberToPlain` in @uniqu/url on purpose: that one spells a number in plain decimal for a
// filter value; here exponent form is kept (shorter, and the arithmetic parser reads it).
function fmtNumber(n: number): string {
  // `1e+21` → `1e21`: a `+` would need URL escaping and the parser reads both.
  return String(n).replace('e+', 'e')
}

/** Options of {@link formatArith}. */
export interface FormatArithOptions {
  /** Print the `+` operator as `%2B`, for use inside a URL query string. Default: false. */
  encodePlus?: boolean
}

/**
 * Print an {@link ArithExpr} as canonical text with minimal parentheses —
 * the inverse of {@link parseArith}: `parseArith(formatArith(x))` deep-equals
 * `x` for every valid `x`. Operators are left-associative, so a right operand
 * of equal precedence is parenthesized (`a-(b-c)`). A negative literal prints
 * `-5`, a negation of a literal `-(5)`. Throws `TypeError` for a malformed
 * expression (unknown operator, wrong arity, non-finite literal, invalid name).
 */
export function formatArith(expr: ArithExpr, opts: FormatArithOptions = {}): string {
  const plus = opts.encodePlus ? '%2B' : '+'
  function fmt(e: ArithExpr, parent: number, rightOfSamePrec: boolean): string {
    const problem = nodeProblem(e)
    if (problem) throw new TypeError(problem)
    if (typeof e === 'number') return fmtNumber(e)
    if (typeof e === 'string') return e
    if (e.$op === 'coalesce') return `coalesce(${e.$args.map((a) => fmt(a, 0, false)).join(',')})`
    if (e.$args.length === 1) {
      const arg = e.$args[0]
      const inner = typeof arg === 'number' ? `(${fmtNumber(arg)})` : fmt(arg, 3, false)
      return `-${inner}`
    }
    const prec = PREC[e.$op]
    const [l, r] = e.$args
    const text = `${fmt(l, prec, false)}${e.$op === '+' ? plus : e.$op}${fmt(r, prec, true)}`
    return prec < parent || (prec === parent && rightOfSamePrec) ? `(${text})` : text
  }
  return fmt(expr, 0, false)
}

// ── inspect ──────────────────────────────────────────────────────────────

/** The distinct names an expression references, in first-use order. */
export function arithNames(expr: ArithExpr): string[] {
  const out = new Set<string>()
  // Iterative: an expression may be hostile (10k levels deep) before it is validated.
  const stack: ArithExpr[] = [expr]
  while (stack.length) {
    const e = stack.pop()!
    if (typeof e === 'string') out.add(e)
    else if (isNode(e)) for (let i = e.$args.length - 1; i >= 0; i--) stack.push(e.$args[i] as ArithExpr)
  }
  return [...out]
}

/**
 * Whether an expression may evaluate to NULL: a division (by zero gives NULL),
 * a nullable name, or a `coalesce` whose arguments are all nullable. NULL
 * propagates through `+ - * /` and negation.
 */
export function arithNullable(expr: ArithExpr, isNullable: (name: string) => boolean): boolean {
  if (typeof expr === 'number') return false
  if (typeof expr === 'string') return isNullable(expr)
  if (expr.$op === '/') return true
  if (expr.$op === 'coalesce') return expr.$args.every((a) => arithNullable(a, isNullable))
  return expr.$args.some((a) => arithNullable(a, isNullable))
}

/**
 * Check an expression's shape and the rules knowable without a schema: known
 * operators and arities (`-` takes 1 or 2 arguments, `coalesce` at least 2, the
 * others 2), identifier names, finite literals within `Number.MAX_SAFE_INTEGER`,
 * at least one name (a constant expression is rejected), and at most
 * {@link ARITH_MAX_NODES} nodes and depth {@link ARITH_MAX_DEPTH}. Issues carry
 * `path` `'$select'`.
 */
export function validateArith(expr: unknown): QueryIssue[] {
  const issues: QueryIssue[] = []
  const push = (message: string) => issues.push({ path: '$select', message })
  let nodes = 0
  let names = 0
  let tooMany = false
  let tooDeep = false

  function visit(e: unknown, depth: number): void {
    // Hostile input: stop walking once a limit is exceeded, so the work stays bounded.
    if (tooMany || tooDeep) return
    if (++nodes > ARITH_MAX_NODES) {
      tooMany = true
      return
    }
    if (depth > ARITH_MAX_DEPTH) {
      tooDeep = true
      return
    }
    const problem = nodeProblem(e)
    if (problem) push(problem)
    if (typeof e === 'number') {
      if (Number.isFinite(e) && Math.abs(e) > Number.MAX_SAFE_INTEGER) {
        push(`Expression literal ${e} exceeds the safe integer range`)
      }
      return
    }
    if (typeof e === 'string') {
      names++
      return
    }
    if (!isNode(e) || !KNOWN_OPS.includes(e.$op)) return
    for (const a of e.$args) {
      if (tooMany || tooDeep) break
      visit(a, depth + 1)
    }
  }

  visit(expr, 1)
  if (tooMany) push(`Expression is too large (more than ${ARITH_MAX_NODES} nodes)`)
  if (tooDeep) push(`Expression is nested too deeply (more than ${ARITH_MAX_DEPTH} levels)`)
  if (!issues.length && names === 0) push('Expression has no field or alias — a constant is not allowed')
  return issues
}
