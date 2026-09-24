import { describe, expect, test } from 'vitest'
import {
  isLosslessNumber,
  LosslessNumber,
  parse,
  parseLosslessNumber,
  stringify
} from './index'
import { numberLexemeSlot, type NumberConversionStrategy } from './numberLexeme'

/**
 * Regression material for:
 *   "lossless-json: unified number lexeme classification and conversion decision"
 *
 * Every case enters through a real public entry point (parse / parseLosslessNumber
 * / new LosslessNumber / isLosslessNumber / stringify). The internal lexeme is
 * read through the @internal `numberLexemeSlot`, which is the exact object the
 * production conversion path uses; it is never fabricated by the tests.
 */

interface CorpusCase {
  /** Human-readable contract tag, also visible in the failing test name. */
  tag: string
  /** Exact JSON/number lexeme text. */
  text: string
  /** Expected lexical shape. */
  kind: 'integer' | 'decimal'
  negative: boolean
  isZero: boolean
  significantDigits: string
  /** Expected value = significantDigits * 10 ** exponent (documented model). */
  exponent: bigint
  /** The single conversion decision all entry points must agree on. */
  strategy: NumberConversionStrategy
  /** Expected result of LosslessNumber#valueOf (Error marker for throws). */
  valueOf: number | bigint | typeof THROWS
  /** Expected stringify output (the lexeme formatting is preserved). */
  json: string
}

const THROWS = Symbol('valueOf throws')

/**
 * Fixed lexeme corpus. Deliberately small and hand-chosen so a failure points
 * at the first semantic that broke instead of a big unrelated text blob.
 */
const CORPUS: CorpusCase[] = [
  // --- exponent -----------------------------------------------------------
  {
    tag: 'exponent/safe positive',
    text: '23e3',
    kind: 'decimal',
    negative: false,
    isZero: false,
    significantDigits: '23',
    exponent: 3n,
    strategy: 'safe_number',
    valueOf: 23000,
    json: '23e3'
  },
  {
    tag: 'exponent/signed fraction',
    text: '2.3e-3',
    kind: 'decimal',
    negative: false,
    isZero: false,
    significantDigits: '23',
    exponent: -4n,
    strategy: 'safe_number',
    valueOf: 0.0023,
    json: '2.3e-3'
  },
  {
    tag: 'exponent/uppercase sign',
    text: '42E+4',
    kind: 'decimal',
    negative: false,
    isZero: false,
    significantDigits: '42',
    exponent: 4n,
    strategy: 'safe_number',
    valueOf: 420000,
    json: '42E+4'
  },
  // --- negative zero ------------------------------------------------------
  {
    tag: 'negative-zero/plain',
    text: '-0',
    kind: 'integer',
    negative: true,
    isZero: true,
    significantDigits: '',
    exponent: 0n,
    strategy: 'safe_number',
    valueOf: -0,
    json: '-0'
  },
  {
    tag: 'negative-zero/fraction',
    text: '-0.0',
    kind: 'decimal',
    negative: true,
    isZero: true,
    significantDigits: '',
    exponent: -1n,
    strategy: 'safe_number',
    valueOf: -0,
    json: '-0.0'
  },
  {
    tag: 'negative-zero/extreme exponent stays zero',
    text: '-0e500',
    kind: 'decimal',
    negative: true,
    isZero: true,
    significantDigits: '',
    exponent: 500n,
    strategy: 'safe_number',
    valueOf: -0,
    json: '-0e500'
  },
  // --- long decimal -------------------------------------------------------
  {
    tag: 'long-decimal/truncates insignificant digits',
    text: '0.66666666666666666666667',
    kind: 'decimal',
    negative: false,
    isZero: false,
    significantDigits: '66666666666666666666667',
    exponent: -23n,
    strategy: 'truncate_float',
    valueOf: 0.6666666666666666,
    json: '0.66666666666666666666667'
  },
  {
    tag: 'long-decimal/trailing zeros do not change the value',
    text: '2.300',
    kind: 'decimal',
    negative: false,
    isZero: false,
    significantDigits: '23',
    exponent: -1n,
    strategy: 'safe_number',
    valueOf: 2.3,
    json: '2.300'
  },
  // --- extreme exponent ---------------------------------------------------
  {
    tag: 'extreme-exponent/overflow',
    text: '2.3e+500',
    kind: 'decimal',
    negative: false,
    isZero: false,
    significantDigits: '23',
    exponent: 499n,
    strategy: 'overflow',
    valueOf: THROWS,
    json: '2.3e+500'
  },
  {
    tag: 'extreme-exponent/underflow',
    text: '2.3e-500',
    kind: 'decimal',
    negative: false,
    isZero: false,
    significantDigits: '23',
    exponent: -501n,
    strategy: 'underflow',
    valueOf: THROWS,
    json: '2.3e-500'
  },
  {
    tag: 'extreme-exponent/multi-digit exponent is parsed lexically',
    text: '9e99999999999999999999',
    kind: 'decimal',
    negative: false,
    isZero: false,
    significantDigits: '9',
    exponent: 99999999999999999999n,
    strategy: 'overflow',
    valueOf: THROWS,
    json: '9e99999999999999999999'
  },
  // --- boundary safe integers --------------------------------------------
  {
    tag: 'safe-integer/max',
    text: '9007199254740991',
    kind: 'integer',
    negative: false,
    isZero: false,
    significantDigits: '9007199254740991',
    exponent: 0n,
    strategy: 'safe_number',
    valueOf: 9007199254740991,
    json: '9007199254740991'
  },
  {
    tag: 'safe-integer/max plus one -> bigint',
    text: '9007199254740992',
    kind: 'integer',
    negative: false,
    isZero: false,
    significantDigits: '9007199254740992',
    exponent: 0n,
    strategy: 'bigint',
    valueOf: 9007199254740992n,
    json: '9007199254740992'
  },
  {
    tag: 'safe-integer/min boundary',
    text: '-9007199254740991',
    kind: 'integer',
    negative: true,
    isZero: false,
    significantDigits: '9007199254740991',
    exponent: 0n,
    strategy: 'safe_number',
    valueOf: -9007199254740991,
    json: '-9007199254740991'
  },
  {
    tag: 'safe-integer/min minus one -> bigint',
    text: '-9007199254740992',
    kind: 'integer',
    negative: true,
    isZero: false,
    significantDigits: '9007199254740992',
    exponent: 0n,
    strategy: 'bigint',
    valueOf: -9007199254740992n,
    json: '-9007199254740992'
  },
  {
    tag: 'safe-integer/rounding boundary off by one',
    text: '10038000307000729',
    kind: 'integer',
    negative: false,
    isZero: false,
    significantDigits: '10038000307000729',
    exponent: 0n,
    strategy: 'bigint',
    valueOf: 10038000307000729n,
    json: '10038000307000729'
  }
]

/**
 * Assert one field at a time, in semantic order, and include the first failing
 * position and necessary context in the thrown message. This avoids a single
 * opaque boolean while keeping the failure pinned to the first violated fact.
 */
function assertLexeme(tag: string, lexeme: unknown, expected: CorpusCase): void {
  const facts: Array<[string, unknown, unknown]> = [
    ['kind', (lexeme as { kind?: unknown }).kind, expected.kind],
    ['negative', (lexeme as { negative?: unknown }).negative, expected.negative],
    ['isZero', (lexeme as { isZero?: unknown }).isZero, expected.isZero],
    ['significantDigits', (lexeme as { significantDigits?: unknown }).significantDigits,
      expected.significantDigits],
    ['exponent', (lexeme as { exponent?: unknown }).exponent, expected.exponent],
    ['conversion strategy', (lexeme as { conversion?: unknown }).conversion, expected.strategy]
  ]

  for (const [label, actual, wanted] of facts) {
    if (!Object.is(actual, wanted)) {
      throw new Error(
        `[${tag}] first violated fact: ${label}\n` +
          `  lexeme text : ${expected.text}\n` +
          `  expected    : ${String(wanted)}\n` +
          `  actual      : ${String(actual)}`
      )
    }
  }
}

describe('unified number lexeme: fixed lexeme corpus behavior guard', () => {
  for (const entry of CORPUS) {
    test(`corpus [${entry.tag}] classifies identically through every public entry`, () => {
      // entry 1: parseLosslessNumber public entry
      const fromParserEntry = parseLosslessNumber(entry.text)
      expect(isLosslessNumber(fromParserEntry)).toBe(true)
      assertLexeme(entry.tag, fromParserEntry[numberLexemeSlot], entry)

      // entry 2: parse() default pipeline
      const fromParse = parse(entry.text)
      expect(isLosslessNumber(fromParse)).toBe(true)
      assertLexeme(entry.tag, (fromParse as LosslessNumber)[numberLexemeSlot], entry)

      // the analysis result is the same immutable object across both reads
      const a = fromParserEntry[numberLexemeSlot]
      const b = (fromParse as LosslessNumber)[numberLexemeSlot]
      expect(Object.isFrozen(a)).toBe(true)
      expect(a).not.toBe(b) // separate inputs -> separate immutable analyses

      // entry 3: new LosslessNumber + valueOf conversion
      const number = new LosslessNumber(entry.text)
      if (entry.valueOf === THROWS) {
        expect(() => number.valueOf()).toThrowError(
          new RegExp(`Cannot safely convert to number: the value '${entry.text.replace(/[.+]/g, '\\$&')}' would ${entry.strategy}`)
        )
      } else {
        expect(Object.is(number.valueOf(), entry.valueOf)).toBe(true)
      }

      // entry 4: stringify preserves the original lexeme formatting
      expect(stringify(number)).toBe(entry.json)
      expect(stringify(parse(`[${entry.text}]`))).toBe(`[${entry.json}]`)
    })
  }
})

export { THROWS }
