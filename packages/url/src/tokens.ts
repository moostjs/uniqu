const tokenTypes = [
  'regex',
  'string',
  'number',
  'boolean',
  'null',
  'op-ne',
  'op-gte',
  'op-lte',
  'op-regex',
  'op-eq',
  'op-gt',
  'op-lt',
  'or',
  'and',
  'lparen',
  'rparen',
  'lbrace',
  'rbrace',
  'comma',
  'bang',
  'keyword',
  'word',
  'ws',
] as const

export type TokenType = (typeof tokenTypes)[number]

/**
 * A single-token definition.
 * `r` **must** be anchored at start (^) because the lexer always
 * consumes from the beginning of the remaining input.
 */
export interface TokenDef {
  r: RegExp
  type: TokenType
}

/**
 * Order matters:
 *   - keywords before generic words
 *   - multi-char operators (>=, <=, !=, ~=) before single-char
 *   - literals before identifiers
 */
export const tokens: TokenDef[] = [
  /* ---------- literals ---------- */
  // regex literal  /pattern/flags
  { r: /^\/(?:\\.|[^\\/])*\/[imsux]*/u, type: 'regex' },

  // single-quoted string   'any text'
  { r: /^'(?:\\.|[^'\\])*'/u, type: 'string' },

  // number  -12.34   0   42   (but NOT 007, 00, 01, -00)
  { r: /^-?(?:0(?!\d)|[1-9]\d*)(?:\.\d+)?(?!\d)/u, type: 'number' },

  // boolean  true | false
  { r: /^(?:true|false)/u, type: 'boolean' },

  // null literal
  { r: /^null/u, type: 'null' },

  /* ---------- operators (longest first) ---------- */
  { r: /^!=/u, type: 'op-ne' },
  { r: /^>=/u, type: 'op-gte' },
  { r: /^<=/u, type: 'op-lte' },
  { r: /^~=/u, type: 'op-regex' },
  { r: /^=/u, type: 'op-eq' },
  { r: /^>/u, type: 'op-gt' },
  { r: /^</u, type: 'op-lt' },

  /* ---------- punctuation / delimiters ---------- */
  { r: /^\^/u, type: 'or' },
  { r: /^&/u, type: 'and' },

  { r: /^\(/u, type: 'lparen' },
  { r: /^\)/u, type: 'rparen' },

  { r: /^\{/u, type: 'lbrace' },
  { r: /^\}/u, type: 'rbrace' },
  { r: /^,/u, type: 'comma' },

  { r: /^!/u, type: 'bang' },

  /* ---------- identifiers ---------- */
  // $keyword (reserved control keys, supports $exists and $!exists)
  { r: /^\$!?[A-Za-z0-9_]+/u, type: 'keyword' },

  // unquoted string - any text
  { r: /^(?:[^&^)\s=><!]+(?:\s|\+)+[^&^)=><!]*)+/u, type: 'string' },

  // field / bare word  (allow dots inside so we don't need a separate DOT token)
  { r: /^[A-Za-z0-9_.]+/u, type: 'word' },

  /* ---------- whitespace (ignored by parser) ---------- */
  { r: /^[\s]+/u, type: 'ws' },
]

export const tokenMap = new Map<TokenType, RegExp>(
  tokens.map((t) => [t.type, t.r]),
)

export interface Token {
  type: TokenType
  value: string
  pos: number
}

export function lex(input: string): Token[] {
  const tokensOut: Token[] = []
  let idx = 0

  while (idx < input.length) {
    let matched = false

    for (const { r, type } of tokens) {
      r.lastIndex = 0
      const slice = input.slice(idx)
      const m = r.exec(slice)
      if (m) {
        matched = true
        if (type !== 'ws') {
          tokensOut.push({ type, value: m[0], pos: idx })
        }
        idx += m[0].length
        break
      }
    }

    if (!matched) {
      throw new SyntaxError(
        `Unexpected char '${input[idx]}' at ${idx} --- ${input}`,
      )
    }
  }
  return tokensOut
}
