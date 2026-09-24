import { describe, expect, test } from 'vitest'
import {
  isLosslessNumber,
  LosslessNumber,
  parse,
  parseLosslessNumber,
  stringify
} from './index'
import {
  analyzeNumberLexeme,
  decideNumberConversion,
  getNumberLexeme,
  isValidNumberLexeme,
  type NumberConversionStrategy,
  type NumberLexeme,
  scanNumberLexeme
} from './numberLexeme'
import { getUnsafeNumberReason, isSafeNumber, UnsafeNumberReason } from './utils'

/**
 * Every scenario in this file is entered through the public package API
 * (parse / parseLosslessNumber / isLosslessNumber / stringify). The internal
 * numberLexeme helpers are only read to assert the immutable invariants that
 * back those public results; no internal result object is ever fabricated to
 * satisfy an assertion.
 */

interface CorpusCase {
  id: string
  input: string
  /** expected conversion strategy derived from the shared analysis */
  strategy: NumberConversionStrategy
  /** expected valueOf() outcome, expressed as a JSON-comparable marker */
  valueOfKind: 'number' | 'bigint' | 'throw'
}

/**
 * Fixed lexical corpus guarding "lossless-json: unified number lexeme
 * classification and conversion decision". It covers exponents, negative
 * zero, long decimals, extreme exponents, safe-integer boundaries and the
 * public outcomes of every strategy.
 */
const LEXICAL_CORPUS: CorpusCase[] = [
  // --- exponent forms -----------------------------------------------------
  { id: 'exp-plain', input: '2e3', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'exp-plus', input: '2e+3', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'exp-minus', input: '2e-3', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'exp-fraction', input: '2.3e5', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'exp-upper', input: '2.3E5', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'exp-trailing-zeros', input: '2300e3', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'exp-integer-shape', input: '1e300', strategy: 'safe_number', valueOfKind: 'number' },

  // --- negative zero ------------------------------------------------------
  { id: 'neg-zero-int', input: '-0', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'neg-zero-frac', input: '-0.0', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'neg-zero-exp', input: '-0e5', strategy: 'safe_number', valueOfKind: 'number' },

  // --- long decimals ------------------------------------------------------
  { id: 'long-decimal-rounds', input: '0.66666666666666666667', strategy: 'truncate_float', valueOfKind: 'number' },
  { id: 'long-decimal-binary-safe', input: '0.30000000000000004', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'long-decimal-leading', input: '1.2345678901234567890', strategy: 'truncate_float', valueOfKind: 'number' },

  // --- extreme exponents --------------------------------------------------
  { id: 'max-finite', input: '1e308', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'first-overflow', input: '1e309', strategy: 'overflow', valueOfKind: 'throw' },
  { id: 'overflow-explicit', input: '2.3e500', strategy: 'overflow', valueOfKind: 'throw' },
  { id: 'min-denormal', input: '1e-323', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'first-underflow', input: '1e-324', strategy: 'underflow', valueOfKind: 'throw' },
  { id: 'underflow-explicit', input: '2.3e-500', strategy: 'underflow', valueOfKind: 'throw' },
  { id: 'extreme-positive-zero', input: '0e99999999999999999999', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'extreme-negative-zero', input: '-0.0e99999999999999999999', strategy: 'safe_number', valueOfKind: 'number' },

  // --- safe integer boundaries -------------------------------------------
  { id: 'max-safe-int', input: '9007199254740991', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'max-safe-plus-one', input: '9007199254740992', strategy: 'bigint', valueOfKind: 'bigint' },
  { id: 'max-safe-plus-two', input: '9007199254740993', strategy: 'bigint', valueOfKind: 'bigint' },
  { id: 'min-safe-int', input: '-9007199254740991', strategy: 'safe_number', valueOfKind: 'number' },
  { id: 'min-safe-minus-one', input: '-9007199254740992', strategy: 'bigint', valueOfKind: 'bigint' },
  { id: 'very-large-int', input: '12345678901234567890', strategy: 'bigint', valueOfKind: 'bigint' }
]

/** Illegal tokens: each must be rejected through the public error hierarchy. */
interface IllegalCase {
  id: string
  input: string
  /** offset, inside the ORIGINAL input, of the first offending character */
  offset: number
  /** public entry through which the rejection is asserted */
  entry: 'parse' | 'lossless' | 'both'
  /** expected public error constructor */
  errorClass: 'SyntaxError' | 'Error'
  /** fragment the existing, stable public error message must contain */
  messageFragment: string
}

const ILLEGAL_CORPUS: IllegalCase[] = [
  {
    id: 'bad-leading-plus',
    input: '+24',
    offset: 0,
    entry: 'lossless',
    errorClass: 'Error',
    messageFragment: 'Invalid number'
  },
  {
    id: 'bad-trailing-dot',
    input: '22.',
    offset: 2,
    entry: 'parse',
    errorClass: 'SyntaxError',
    messageFragment: "Invalid number '22.', expecting a digit but got '.' at position 2"
  },
  {
    id: 'bad-empty-exponent',
    input: '0.2e',
    offset: 3,
    entry: 'parse',
    errorClass: 'SyntaxError',
    messageFragment: "Invalid number '0.2e', expecting a digit but reached end of input at position 3"
  },
  {
    id: 'bad-exponent-dot',
    input: '2e3.4',
    offset: 4,
    entry: 'lossless',
    errorClass: 'Error',
    messageFragment: 'Invalid number'
  },
  {
    id: 'bad-double-dot',
    input: '2.3.4',
    offset: 4,
    entry: 'lossless',
    errorClass: 'Error',
    messageFragment: 'Invalid number'
  },
  {
    id: 'bad-leading-space',
    input: '   123',
    offset: 0,
    entry: 'lossless',
    errorClass: 'Error',
    messageFragment: 'Invalid number'
  },
  {
    id: 'bad-trailing-space',
    input: '123   ',
    offset: 3,
    entry: 'lossless',
    errorClass: 'Error',
    messageFragment: 'Invalid number'
  },
  {
    id: 'bad-leading-zero-array',
    input: '[01]',
    offset: 2,
    entry: 'parse',
    errorClass: 'SyntaxError',
    messageFragment: "Expected end of input but got '1' at position 2"
  },
  {
    id: 'bad-dash-only',
    input: '-',
    offset: 1,
    entry: 'parse',
    errorClass: 'SyntaxError',
    messageFragment: "Invalid number '-', expecting a digit but reached end of input at position 1"
  },
  {
    id: 'bad-letter-token',
    input: 'NaN',
    offset: 0,
    entry: 'parse',
    errorClass: 'SyntaxError',
    messageFragment: "JSON value expected but got 'N' at position 0"
  }
]

/**
 * Assert a corpus predicate, reporting the FIRST violating case only, with
 * enough local context (id/input/expected/actual) to diagnose it. Never dumps
 * the whole corpus or a fixed semantic text snapshot.
 */
function assertFirstViolation<T>(
  cases: T[],
  predicate: (entry: T) => { ok: boolean; detail: string }
): void {
  for (const entry of cases) {
    const { ok, detail } = predicate(entry)
    if (!ok) {
      throw new Error(`first violation at corpus case ${detail}`)
    }
  }
}

function valueOfKindOf(value: LosslessNumber): 'number' | 'bigint' | 'throw' {
  try {
    const coerced = value.valueOf()
    return typeof coerced === 'bigint' ? 'bigint' : 'number'
  } catch {
    return 'throw'
  }
}

describe('unified lexeme classification - fixed lexical corpus behavior guard', () => {
  test('every public entry derives the same immutable analysis for one lexeme', () => {
    assertFirstViolation(LEXICAL_CORPUS, (entry) => {
      const fromFactory = parseLosslessNumber(entry.input)
      const fromParse = parse(entry.input)
      const viaStringify = JSON.parse(stringify([fromFactory]) ?? 'null')[0]

      const lexemeOfFactory = getNumberLexeme(fromFactory)
      const lexemeOfParsed = isLosslessNumber(fromParse) ? getNumberLexeme(fromParse) : undefined

      const sameIdentity = lexemeOfParsed === lexemeOfFactory
      const valid =
        isValidNumberLexeme(entry.input) &&
        isLosslessNumber(fromFactory) &&
        isLosslessNumber(fromParse) &&
        typeof sameIdentity === 'boolean' &&
        viaStringify === entry.input

      return {
        ok: Boolean(valid) && sameIdentity === false && lexemeOfParsed?.raw === entry.input,
        detail: `${entry.id}: input='${entry.input}' parsedClass=${isLosslessNumber(fromParse)} factoryRaw='${lexemeOfFactory.raw}' parsedRaw='${lexemeOfParsed?.raw}' stringifyRoundtrip='${viaStringify}'`
      }
    })
  })

  test('conversion strategy and valueOf outcome match the corpus, one decision source', () => {
    assertFirstViolation(LEXICAL_CORPUS, (entry) => {
      const lexeme = analyzeNumberLexeme(entry.input)
      const conversion = decideNumberConversion(lexeme)
      const publicNumber = parseLosslessNumber(entry.input)
      const actualKind = valueOfKindOf(publicNumber)
      const reason = getUnsafeNumberReason(entry.input)
      const safe = isSafeNumber(entry.input)

      const expectedSafe = entry.strategy === 'safe_number'
      const strategyConsistent =
        (conversion.unsafeReason === undefined) === (reason === undefined) &&
        safe === expectedSafe &&
        (conversion.unsafeReason === undefined) === expectedSafe

      return {
        ok:
          conversion.strategy === entry.strategy &&
          actualKind === entry.valueOfKind &&
          strategyConsistent,
        detail: `${entry.id}: input='${entry.input}' expectedStrategy=${entry.strategy} actualStrategy=${conversion.strategy}; expectedValueOf=${entry.valueOfKind} actualValueOf=${actualKind}; reason=${reason}; isSafeNumber=${safe}`
      }
    })
  })

  test('stringify round-trips every valid lexeme byte-identically through parse', () => {
    assertFirstViolation(LEXICAL_CORPUS, (entry) => {
      const text = `{"n":${entry.input}}`
      const parsed = parse(text) as { n: LosslessNumber }
      const stringified = stringify(parsed)
      const reparsed = parse(stringified ?? '') as { n: LosslessNumber }

      return {
        ok:
          stringified === text &&
          getNumberLexeme(reparsed.n).raw === entry.input &&
          reparsed.n.toString() === entry.input,
        detail: `${entry.id}: original='${text}' stringify='${stringified}' reparsed='${reparsed.n.toString()}'`
      }
    })
  })

  test('structural analysis never routes through Number (long integers stay exact)', () => {
    assertFirstViolation(
      LEXICAL_CORPUS.filter((entry) => entry.strategy === 'bigint'),
      (entry) => {
        const lexeme = getNumberLexeme(parseLosslessNumber(entry.input))
        const expectedSig = entry.input.replace(/^-/, '').replace(/^0+/, '')
        return {
          ok: lexeme.isIntegerForm && lexeme.significantDigits === expectedSig,
          detail: `${entry.id}: input='${entry.input}' isIntegerForm=${lexeme.isIntegerForm} sig='${lexeme.significantDigits}' expectedSig='${expectedSig}'`
        }
      }
    )
  })
})

describe('unified lexeme classification - illegal token corpus rejects in the error hierarchy', () => {
  function attempt(entry: IllegalCase): { error: unknown } | undefined {
    try {
      if (entry.entry === 'parse') {
        parse(entry.input)
      } else {
        parseLosslessNumber(entry.input)
      }
      return undefined
    } catch (error) {
      return { error }
    }
  }

  test('rejection is typed, positioned on the original input and repeatable', () => {
    assertFirstViolation(ILLEGAL_CORPUS, (entry) => {
      const first = attempt(entry)
      const again = attempt(entry)

      if (!first || !again) {
        return {
          ok: false,
          detail: `${entry.id}: input='${entry.input}' was accepted instead of rejected`
        }
      }

      const error = first.error as Error
      const repeatError = again.error as Error
      const isExpectedType =
        entry.errorClass === 'SyntaxError' ? error instanceof SyntaxError : !(error instanceof SyntaxError)
      const messageOk = error.message.includes(entry.messageFragment)
      const repeatable = repeatError.message === error.message

      let scannerOffset: number | undefined
      try {
        scanNumberLexeme(entry.input, 0)
      } catch (scanError) {
        scannerOffset = (scanError as { offset?: number }).offset
      }
      const offsetOk =
        entry.entry === 'lossless'
          ? scannerOffset === undefined || scannerOffset === entry.offset
          : error.message.includes(`at position ${entry.offset}`)

      return {
        ok: Boolean(isExpectedType) && messageOk && repeatable && offsetOk,
        detail: `${entry.id}: input='${entry.input}' offset=${entry.offset} type=${error.name} message='${error.message}' scannerOffset=${scannerOffset} repeatable=${repeatable}`
      }
    })
  })

  test('a rejection leaves no analysis state behind on a later successful parse', () => {
    assertFirstViolation(ILLEGAL_CORPUS, (entry) => {
      attempt(entry)
      const after = parse('12345678901234567890') as LosslessNumber
      const lexeme = getNumberLexeme(after)
      return {
        ok: lexeme.raw === '12345678901234567890' && lexeme.significantDigits === '1234567890123456789',
        detail: `${entry.id}: successful parse after failure carried raw='${lexeme.raw}' sig='${lexeme.significantDigits}' instead of a fresh integer analysis`
      }
    })
  })
})
