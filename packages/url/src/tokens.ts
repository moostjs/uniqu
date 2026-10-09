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
 * `r` **must** be anchored at start (^): it describes a match at the current
 * lexer position (the lexer runs a sticky copy of it from that position).
 * `first` matches every character a match of `r` can start with. It only
 * narrows which definitions are tried at a position, so it may be broader than
 * `r`'s real first set but never narrower.
 */
export interface TokenDef {
  r: RegExp
  type: TokenType
  first: RegExp
}

/**
 * Order matters:
 *   - keywords before generic words
 *   - multi-char operators (>=, <=, !=, ~=) before single-char
 *   - literals before identifiers
 *
 * A number / boolean / null literal must span the whole bare run of
 * `[A-Za-z0-9_.-]` chars (`(?![\w.-])`), so `nullable`, `1.5.3` and
 * `2026-01-01` lex as one word instead of a literal plus a stray tail.
 */
export const tokens: TokenDef[] = [
  /* ---------- literals ---------- */
  // regex literal  /pattern/flags
  { r: /^\/(?:\\.|[^\\/])*\/[imsux]*/u, type: 'regex', first: /\//u },

  // single-quoted string   'any text'
  { r: /^'(?:\\.|[^'\\])*'/u, type: 'string', first: /'/u },

  // number  -12.34   0   42   (but NOT 007, 00, 01, -00)
  { r: /^-?(?:0(?!\d)|[1-9]\d*)(?:\.\d+)?(?![\w.-])/u, type: 'number', first: /[-\d]/u },

  // boolean  true | false
  { r: /^(?:true|false)(?![\w.-])/u, type: 'boolean', first: /[ft]/u },

  // null literal
  { r: /^null(?![\w.-])/u, type: 'null', first: /n/u },

  /* ---------- operators (longest first) ---------- */
  { r: /^!=/u, type: 'op-ne', first: /!/u },
  { r: /^>=/u, type: 'op-gte', first: />/u },
  { r: /^<=/u, type: 'op-lte', first: /</u },
  { r: /^~=/u, type: 'op-regex', first: /~/u },
  { r: /^=/u, type: 'op-eq', first: /=/u },
  { r: /^>/u, type: 'op-gt', first: />/u },
  { r: /^</u, type: 'op-lt', first: /</u },

  /* ---------- punctuation / delimiters ---------- */
  { r: /^\^/u, type: 'or', first: /\^/u },
  { r: /^&/u, type: 'and', first: /&/u },

  { r: /^\(/u, type: 'lparen', first: /\(/u },
  { r: /^\)/u, type: 'rparen', first: /\)/u },

  { r: /^\{/u, type: 'lbrace', first: /\{/u },
  { r: /^\}/u, type: 'rbrace', first: /\}/u },
  { r: /^,/u, type: 'comma', first: /,/u },

  { r: /^!/u, type: 'bang', first: /!/u },

  /* ---------- identifiers ---------- */
  // $keyword (reserved control keys, supports $exists and $!exists)
  { r: /^\$!?[A-Za-z0-9_]+/u, type: 'keyword', first: /\$/u },

  // unquoted multi-word string (e.g. `name=John Doe`). The `{` / `}` list
  // delimiters are excluded from both runs so this greedy rule stops at a list
  // boundary instead of swallowing it: without this, a quoted item containing a
  // space inside a `{…}` list (e.g. `city{'New York'}`) gets eaten whole and the
  // braces never tokenize. Quotes stay allowed so unquoted apostrophes (`O'Brien`)
  // still lex as free text.
  { r: /^(?:[^&^){}\s=><!]+(?:\s|\+)+[^&^){}=><!]*)+/u, type: 'string', first: /[^&^){}\s=><!]/u },

  // bare local date-time `YYYY-MM-DDTHH:MM[:SS]` (an `'hour'` bucket label):
  // a string. `:` has no meaning in the filter grammar, so this is unambiguous;
  // any other shape with `:` (`Z`, fractions, offsets) must be quoted.
  { r: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?![\w.:-])/u, type: 'string', first: /\d/u },

  // bare word with interior hyphens: `in-progress`, `2026-01-01`, `a1b2-c3d4`.
  // Always a string literal, never a field. A leading `-` stays a negative number.
  { r: /^[A-Za-z0-9_.]+(?:-+[A-Za-z0-9_.]+)+/u, type: 'string', first: /[A-Za-z0-9_.]/u },

  // field / bare word  (allow dots inside so we don't need a separate DOT token)
  { r: /^[A-Za-z0-9_.]+/u, type: 'word', first: /[A-Za-z0-9_.]/u },

  /* ---------- whitespace (ignored by parser) ---------- */
  { r: /^[\s]+/u, type: 'ws', first: /\s/u },
]

export const tokenMap = new Map<TokenType, RegExp>(
  tokens.map((t) => [t.type, t.r]),
)

export interface Token {
  type: TokenType
  value: string
  pos: number
}

interface StickyDef {
  r: RegExp
  type: TokenType
}

// Sticky copies of `tokens` (the leading `^` dropped): matched in place via
// `lastIndex`, so no per-position `input.slice()`. `lex` is synchronous and
// sets `lastIndex` before every `exec`, so sharing them is safe.
const stickyTokens: StickyDef[] = tokens.map(({ r, type }) => ({
  r: new RegExp(r.source.slice(1), `${r.flags}y`),
  type,
}))

// Candidate definitions per ASCII first char, in `tokens` order (so the first
// match still wins exactly as in a full ordered scan). Other chars try the full list.
const asciiCandidates: StickyDef[][] = Array.from({ length: 128 }, (_, code) => {
  const ch = String.fromCharCode(code)
  return stickyTokens.filter((_, i) => tokens[i].first.test(ch))
})

export function lex(input: string): Token[] {
  const tokensOut: Token[] = []
  const len = input.length
  let idx = 0

  while (idx < len) {
    const code = input.charCodeAt(idx)
    const candidates = code < 128 ? asciiCandidates[code] : stickyTokens
    let matched = false

    for (let i = 0; i < candidates.length; i++) {
      const { r, type } = candidates[i]
      r.lastIndex = idx
      const m = r.exec(input)
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
