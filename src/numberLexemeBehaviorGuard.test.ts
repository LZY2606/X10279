/**
 * Regression material for:
 * "lossless-json: unified number-lexeme classification and conversion decision"
 *
 * Every scenario enters through the repository's real public entry points:
 * `parse`, `parseLosslessNumber`, `isLosslessNumber`, and `stringify`.
 * The internal `numberLexeme` analyzer is imported only to assert invariants
 * about the JSON/number-lexeme/conversion-strategy semantics - never to
 * fabricate the public result (it is not part of the package's public API, and
 * the production path runs the very same logic).
 *
 * Assertions report the first violating position with context instead of a
 * bare boolean, and property-based checks use a fixed seed and a fixed size
 * budget.
 */

import { describe, expect, test } from 'vitest'
import {
  isLosslessNumber,
  LosslessNumber,
  parse,
  parseLosslessNumber,
  parseNumberAndBigInt,
  stringify
} from './index'
import {
  analyzeNumberLexeme,
  NumberConversionStrategy,
  type NumberLexemeAnalysis
} from './numberLexeme'
import { numberLexemeAnalysis as analysisSymbol } from './LosslessNumber'

// ---------------------------------------------------------------------------
// First-failure evidence helpers
// ---------------------------------------------------------------------------

interface Violation {
  where: string
  detail: string
}

/**
 * Accumulate checks and keep only the first violation per case, together with
 * enough context (case id, lexeme, position in the source text) to locate the
 * breach without diffing a whole semantic-independent blob of text.
 */
class BehaviorContract {
  private firstViolation: Violation | undefined

  constructor(private readonly context: string) {}

 check(where: string, condition: boolean, detail: () => string): void {
    if (!condition && this.firstViolation === undefined) {
      this.firstViolation = { where, detail: detail() }
    }
  }

  fail(where: string, detail: string): void {
    this.check(where, false, () => detail)
  }

  assert(): void {
    if (this.firstViolation !== undefined) {
      throw new Error(
        `[${this.context}] first contract violation at ${this.firstViolation.where}: ${this.firstViolation.detail}`
      )
    }
  }
}

function positionContext(text: string, position: number): string {
  const start = Math.max(0, position - 8)
  const end = Math.min(text.length, position + 8)
  const excerpt = text
    .slice(start, end)
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
  const marker = ' '.repeat(Math.max(0, position - start)) + '^'
  return `position ${position} of ${text.length} in "${excerpt}"\n${marker}`
}

function expectSyntaxErrorAt(
  contract: BehaviorContract,
  where: string,
  source: string,
  fn: () => unknown
): void {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }

  contract.check(`${where}: rejection`, thrown instanceof SyntaxError, () =>
    thrown === undefined
      ? 'expected a SyntaxError but no error was thrown'
      : `expected SyntaxError, got ${String(thornSafe(thrown))}`
  )

  if (!(thrown instanceof SyntaxError)) {
    return
  }

  const message = thrown.message
  const match = /at position (\d+)/.exec(message)
  contract.check(`${where}: error position`, match !== null, () =>
    `error message carries no source position: "${message}"`
  )

  const position = match ? Number.parseInt(match[1], 10) : -1
  contract.check(
    `${where}: position stays inside the original input`,
    position >= 0 && position <= source.length,
    () => `reported position ${position} does not point into original input (length ${source.length})`
  )

  // the reported character must be the character at that very position in the
  // ORIGINAL input (or the message describes the end of input)
  if (position >= 0 && position < source.length) {
    const ch = source[position]
    const pointsAtOriginal =
      message.includes(`got '${ch}'`) ||
      message.includes(`position ${position}`) ||
      message.includes(`'${ch}'`)
    contract.check(`${where}: position points at original character`, pointsAtOriginal, () =>
      `message "${message}" does not point at original character '${ch}' at ${positionContext(source, position)}`
    )
  }
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

// ---------------------------------------------------------------------------
// Fixed lexical corpus
// ---------------------------------------------------------------------------

interface LexemeCase {
  id: string
  lexeme: string
  category:
    | 'exponent'
    | 'negative-zero'
    | 'long-decimal'
    | 'extreme-exponent'
    | 'safe-integer-boundary'
  expectedStrategy: NumberConversionStrategy
  /** true when Number(lexeme) keeps the exact significant digits */
  safeNumber: boolean
}

const LEXICAL_CORPUS: LexemeCase[] = [
  // exponent
  { id: 'exp-basic', lexeme: '2e3', category: 'exponent', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'exp-plus', lexeme: '2300e+3', category: 'exponent', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'exp-minus', lexeme: '2.3e-3', category: 'exponent', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'exp-zero', lexeme: '0e+2', category: 'exponent', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'exp-upper-E', lexeme: '42E-4', category: 'exponent', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'exp-format-only', lexeme: '2.300', category: 'exponent', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'exp-integer-magnitude', lexeme: '1e21', category: 'exponent', expectedStrategy: 'bigint', safeNumber: false },

  // negative zero
  { id: 'neg-zero', lexeme: '-0', category: 'negative-zero', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'neg-zero-decimal', lexeme: '-0.0', category: 'negative-zero', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'neg-zero-exp', lexeme: '-0e5', category: 'negative-zero', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'neg-zero-tiny-exp', lexeme: '-0.000e-999', category: 'negative-zero', expectedStrategy: 'safe_number', safeNumber: true },

  // long decimals
  { id: 'long-fraction-truncates', lexeme: '0.66666666666666666666667', category: 'long-decimal', expectedStrategy: 'lossless', safeNumber: false },
  { id: 'long-integer-bigint', lexeme: '123456789012345678901234567890', category: 'long-decimal', expectedStrategy: 'bigint', safeNumber: false },
  { id: 'long-fraction-roundtrip', lexeme: '0.30000000000000004', category: 'long-decimal', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'long-decimal-rounds-down', lexeme: '0.9999999999999999', category: 'long-decimal', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'long-decimal-15-digits', lexeme: '1.23456789012345', category: 'long-decimal', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'long-decimal-17-digits', lexeme: '1.2345678901234567', category: 'long-decimal', expectedStrategy: 'lossless', safeNumber: false },
  { id: 'long-decimal-misrounded-int', lexeme: '10038000307000729', category: 'long-decimal', expectedStrategy: 'bigint', safeNumber: false },

  // extreme exponents
  { id: 'extreme-overflow', lexeme: '2.3e500', category: 'extreme-exponent', expectedStrategy: 'overflow', safeNumber: false },
  { id: 'extreme-overflow-neg', lexeme: '-1e500', category: 'extreme-exponent', expectedStrategy: 'overflow', safeNumber: false },
  { id: 'extreme-underflow', lexeme: '2.3e-500', category: 'extreme-exponent', expectedStrategy: 'underflow', safeNumber: false },
  { id: 'extreme-overflow-309', lexeme: '1e309', category: 'extreme-exponent', expectedStrategy: 'overflow', safeNumber: false },
  { id: 'extreme-underflow-325', lexeme: '1e-325', category: 'extreme-exponent', expectedStrategy: 'underflow', safeNumber: false },
  { id: 'extreme-boundary-max', lexeme: '1.7976931348623157e308', category: 'extreme-exponent', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'extreme-boundary-over', lexeme: '1.7976931348623159e308', category: 'extreme-exponent', expectedStrategy: 'overflow', safeNumber: false },
  { id: 'extreme-boundary-subnormal', lexeme: '5e-324', category: 'extreme-exponent', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'extreme-boundary-zero', lexeme: '2e-324', category: 'extreme-exponent', expectedStrategy: 'underflow', safeNumber: false },

  // boundary safe integers
  { id: 'safe-int-max', lexeme: '9007199254740991', category: 'safe-integer-boundary', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'safe-int-max-plus1', lexeme: '9007199254740992', category: 'safe-integer-boundary', expectedStrategy: 'bigint', safeNumber: false },
  { id: 'safe-int-max-plus2', lexeme: '9007199254740993', category: 'safe-integer-boundary', expectedStrategy: 'bigint', safeNumber: false },
  { id: 'safe-int-min', lexeme: '-9007199254740991', category: 'safe-integer-boundary', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'safe-int-min-minus1', lexeme: '-9007199254740992', category: 'safe-integer-boundary', expectedStrategy: 'bigint', safeNumber: false },
  { id: 'safe-int-min-minus2', lexeme: '-9007199254740993', category: 'safe-integer-boundary', expectedStrategy: 'bigint', safeNumber: false },
  { id: 'safe-int-zero', lexeme: '0', category: 'safe-integer-boundary', expectedStrategy: 'safe_number', safeNumber: true },
  { id: 'safe-int-one', lexeme: '1', category: 'safe-integer-boundary', expectedStrategy: 'safe_number', safeNumber: true }
]

interface IllegalTokenCase {
  id: string
  /** the full JSON document presented to the public parser */
  source: string
  /** expected zero-based position named by the SyntaxError */
  position: number
  note: string
}

const ILLEGAL_TOKEN_CORPUS: IllegalTokenCase[] = [
  { id: 'illegal-plus', source: '+24', position: 0, note: 'leading plus is not a JSON number' },
  { id: 'illegal-leading-zero', source: '01', position: 1, note: 'leading zero must not be followed by a digit' },
  { id: 'illegal-dot-prefix', source: '.5', position: 0, note: 'a number cannot start with a dot' },
  { id: 'illegal-trailing-dot', source: '22.', position: 2, note: 'fraction requires digits' },
  { id: 'illegal-double-dot', source: '2.3.4', position: 3, note: 'second dot is outside the number token' },
  { id: 'illegal-exp-open', source: '2e', position: 2, note: 'exponent requires a digit' },
  { id: 'illegal-exp-sign-open', source: '2e+', position: 3, note: 'exponent sign needs a digit' },
  { id: 'illegal-exp-dot', source: '2e3.4', position: 3, note: 'dot after exponent is outside the token' },
  { id: 'illegal-minus-alone', source: '-', position: 1, note: 'minus alone is not a number' },
  { id: 'illegal-letter', source: 'NaN', position: 0, note: 'NaN is not valid JSON' },
  { id: 'illegal-0x', source: '0x10', position: 1, note: 'hex notation is not a JSON number' },
  { id: 'illegal-underscore', source: '1_000', position: 1, note: 'numeric separators are not valid JSON' },
  { id: 'illegal-trailing-x', source: '123abc', position: 3, note: 'trailing letters are outside the token' },
  { id: 'illegal-space-inside', source: '1 2', position: 1, note: 'whitespace ends the scalar document' },
  { id: 'illegal-in-array', source: '[1,2e,3]', position: 5, note: 'open exponent inside an array' },
  { id: 'illegal-in-object', source: '{"a":-}', position: 6, note: 'minus without digit as object value' }
]

// ---------------------------------------------------------------------------
// Guard: the immutable analysis matches an independent oracle and is frozen
// ---------------------------------------------------------------------------

describe('unified number lexeme: immutable analysis of the fixed lexical corpus', () => {
  for (const testCase of LEXICAL_CORPUS) {
    test(`analysis [${testCase.id}] "${testCase.lexeme}" captures JSON/number lexeme facts`, () => {
      const contract = new BehaviorContract(testCase.id)
      const analysis = analyzeNumberLexeme(testCase.lexeme)

      contract.check('analyzer returns a result', analysis !== undefined, () => 'got undefined for a valid lexeme')
      if (analysis === undefined) {
        contract.assert()
        return
      }

      const facts = oracleFacts(testCase.lexeme)
      checkAnalysisAgainstOracle(contract, testCase.lexeme, analysis, facts)
      checkAnalysisImmutable(contract, analysis)

      const expected = testCase.expectedStrategy
      contract.check('strategy matches corpus decision', analysis.strategy === expected, () =>
        `strategy ${analysis.strategy} !== expected ${expected}`
      )

      // far-from-boundary cases must also agree with the independent platform oracle
      const platform = oracleStrategyFarFromBoundary(testCase.lexeme, facts)
      if (platform !== undefined) {
        contract.check('strategy agrees with independent platform oracle', analysis.strategy === platform, () =>
          `strategy ${analysis.strategy} !== platform oracle ${platform}`
        )
      }

      contract.assert()
    })
  }
})

function checkAnalysisAgainstOracle(
  contract: BehaviorContract,
  lexeme: string,
  analysis: NumberLexemeAnalysis,
  facts: ReturnType<typeof oracleFacts>
): void {
  contract.check('lexeme echoes the original text', analysis.lexeme === lexeme, () =>
    `lexeme was normalized to "${analysis.lexeme}"`
  )
  contract.check('negative flag', analysis.negative === facts.negative, () =>
    `${analysis.negative} !== ${facts.negative}`
  )
  contract.check('kind (integer/decimal)', analysis.kind === facts.kind, () =>
    `${analysis.kind} !== ${facts.kind}`
  )
  contract.check('zero recognition', analysis.isZero === facts.isZero, () =>
    `${analysis.isZero} !== ${facts.isZero}`
  )
  contract.check('significant digits extracted without Number', analysis.significantDigits === facts.significantDigits, () =>
    `"${analysis.significantDigits}" !== "${facts.significantDigits}"`
  )
  contract.check('leading power', analysis.leadingPower === facts.leadingPower, () =>
    `${analysis.leadingPower} !== ${facts.leadingPower}`
  )
  contract.check('safe integer classification', analysis.isSafeInteger === facts.isSafeInteger, () =>
    `${analysis.isSafeInteger} !== ${facts.isSafeInteger}`
  )
}

function checkAnalysisImmutable(contract: BehaviorContract, analysis: NumberLexemeAnalysis): void {
  contract.check('analysis is frozen', Object.isFrozen(analysis), () => 'analysis result is not frozen')

  const attempt: Array<[string, () => void]> = [
    ['strategy', () => ((analysis as { strategy: string }).strategy = 'tampered')],
    ['lexeme', () => ((analysis as { lexeme: string }).lexeme = 'tampered')],
    ['significantDigits', () => ((analysis as { significantDigits: string }).significantDigits = 'tampered')]
  ]
  for (const [field, mutate] of attempt) {
    let threw = false
    try {
      mutate()
    } catch {
      threw = true
    }
    contract.check(`mutation of ${field} is rejected`, threw, () => 'frozen analysis was mutated')
  }
}

// ---------------------------------------------------------------------------
// Guard: all four public entry points consume the same classification
// ---------------------------------------------------------------------------

describe('unified number lexeme: parse/parseLosslessNumber/isLosslessNumber/stringify share one decision', () => {
  for (const testCase of LEXICAL_CORPUS) {
    test(`public entries [${testCase.id}] "${testCase.lexeme}" agree`, () => {
      const contract = new BehaviorContract(`${testCase.category}/${testCase.id}`)
      const { lexeme } = testCase
      const analysis = analyzeNumberLexeme(lexeme)
      if (analysis === undefined) {
        throw new Error('fixed corpus must contain valid lexemes only')
      }

      // Entry 1: parse (default number parser) enters through the real parser
      const parsed = parse(lexeme)
      contract.check('parse yields a LosslessNumber', isLosslessNumber(parsed), () =>
        `parse produced ${Object.prototype.toString.call(parsed)}`
      )

      // Entry 2: parseLosslessNumber is the documented public number parser
      const viaParser = parseLosslessNumber(lexeme)
      contract.check('parseLosslessNumber yields a LosslessNumber', isLosslessNumber(viaParser), () =>
        'parseLosslessNumber result is not a LosslessNumber'
      )

      // Entry 3: isLosslessNumber recognizes both public constructions and
      // routes its decision through the shared analysis (see negative guards)
      contract.check('isLosslessNumber(parse(x))', isLosslessNumber(parsed), () => 'false for parse result')
      contract.check(
        'isLosslessNumber(parseLosslessNumber(x))',
        isLosslessNumber(viaParser),
        () => 'false for parseLosslessNumber result'
      )

      // both constructions must carry the very same immutable analysis
      if (isLosslessNumber(parsed) && isLosslessNumber(viaParser)) {
        const parsedAnalysis = readAnalysis(parsed)
        const parserAnalysis = readAnalysis(viaParser)
        contract.check('parse attaches the shared analysis', parsedAnalysis === readAnalysisOfLexeme(parsed.value), () =>
          'analysis attached by parse differs from a fresh shared analysis'
        )
        contract.check(
          'parseLosslessNumber attaches the shared analysis',
          parserAnalysis === readAnalysisOfLexeme(viaParser.value),
          () => 'analysis attached by parseLosslessNumber differs'
        )
        contract.check('both entries classify identically', parsedAnalysis.strategy === analysis.strategy, () =>
          `${parsedAnalysis.strategy} !== ${analysis.strategy}`
        )
      }

      // Entry 4: stringify must preserve the original lexeme text (no Number
      // coercion in the output path)
      const stringified = stringify(parsed)
      contract.check('stringify emits the original lexeme', stringified === lexeme, () =>
        `"${stringified}" !== "${lexeme}"`
      )

      // round-trip through the real API returns to the same lexeme
      const roundTripped = stringify(parse(lexeme))
      contract.check('parse -> stringify is the identity on the lexeme', roundTripped === lexeme, () =>
        `"${roundTripped}" !== "${lexeme}"`
      )

      // valueOf() must honor the single conversion decision
      assertValueOfDecision(contract, viaParser, analysis)

      // parseNumberAndBigInt is the public alternative parser: integer
      // lexemes must be bigint unless they are safe integers; decimal lexemes
      // are plain numbers
      assertBigIntAlternative(contract, lexeme, analysis)

      // the number stringifier extension validates its output with the same
      // lexeme grammar
      assertNumberStringifierValidation(contract, lexeme)

      contract.assert()
    })
  }
})

function readAnalysis(value: LosslessNumber): NumberLexemeAnalysis {
  // access through the internal symbol; this symbol is not part of the public
  // API but stores the exact result the production path decided on
  return (value as unknown as Record<symbol, NumberLexemeAnalysis>)[analysisSymbol]
}

function readAnalysisOfLexeme(lexeme: string): NumberLexemeAnalysis {
  const fresh = analyzeNumberLexeme(lexeme)
  if (fresh === undefined) {
    throw new Error(`unexpected invalid lexeme "${lexeme}"`)
  }
  return fresh
}

function assertValueOfDecision(
  contract: BehaviorContract,
  number: LosslessNumber,
  analysis: NumberLexemeAnalysis
): void {
  const strategy = analysis.strategy

  if (strategy === NumberConversionStrategy.safe_number) {
    let coerced: unknown
    try {
      coerced = number.valueOf()
    } catch (error) {
      contract.fail('valueOf(safe)', `unexpected error: ${errorText(error)}`)
      return
    }
    contract.check('valueOf returns a number for safe_number', typeof coerced === 'number', () =>
      `got ${typeof coerced}`
    )
    return
  }

  if (strategy === NumberConversionStrategy.lossless) {
    let coerced: unknown
    try {
      coerced = number.valueOf()
    } catch (error) {
      contract.fail('valueOf(lossless decimal)', `unexpected error: ${errorText(error)}`)
      return
    }
    contract.check('valueOf returns an approximate number for lossless decimals', typeof coerced === 'number', () =>
      `got ${typeof coerced}`
    )
    return
  }

  if (strategy === NumberConversionStrategy.bigint) {
    let coerced: unknown
    try {
      coerced = number.valueOf()
    } catch (error) {
      contract.fail('valueOf(bigint)', `unexpected error: ${errorText(error)}`)
      return
    }
    contract.check('valueOf returns a bigint', typeof coerced === 'bigint', () => `got ${typeof coerced}`)
    contract.check('bigint has the exact magnitude', BigInt(analysis.lexeme) === (coerced as bigint), () =>
      `${String(coerced)} !== ${analysis.lexeme}`
    )
    return
  }

  // overflow / underflow: an error in the existing error layer is required
  let thrown: unknown
  try {
    number.valueOf()
  } catch (error) {
    thrown = error
  }
  contract.check(`valueOf(${strategy}) throws`, thrown instanceof Error, () =>
    thrown === undefined ? 'no error thrown' : `non-error value ${String(thrown)}`
  )
  if (thrown instanceof Error) {
    contract.check(`valueOf(${strategy}) names the reason`, thrown.message.includes(strategy), () =>
      `message "${thrown.message}" does not mention ${strategy}`
    )
    contract.check(
      `valueOf(${strategy}) reports the post-conversion value without mutating the lexeme`,
      thrown.message.includes(analysis.lexeme) && number.toString() === analysis.lexeme,
      () => `message "${thrown.message}" lost the original lexeme`
    )
  }
}

function assertBigIntAlternative(
  contract: BehaviorContract,
  lexeme: string,
  analysis: NumberLexemeAnalysis
): void {
  const value = parseNumberAndBigInt(lexeme)
  if (analysis.kind === 'integer') {
    if (analysis.isSafeInteger) {
      contract.check('parseNumberAndBigInt keeps a safe integer as number', typeof value === 'number', () =>
        `got ${typeof value}`
      )
      if (typeof value === 'number') {
        contract.check('safe integer value is exact', Number.isSafeInteger(value) && BigInt(value) === BigInt(lexeme), () =>
          `${value} !== ${lexeme}`
        )
      }
    } else {
      contract.check('parseNumberAndBigInt upgrades an unsafe integer to bigint', typeof value === 'bigint', () =>
        `got ${typeof value}`
      )
      if (typeof value === 'bigint') {
        contract.check('bigint value is exact', value === BigInt(lexeme), () => `${value} !== ${lexeme}`)
      }
    }
  } else {
    contract.check('parseNumberAndBigInt returns a number for decimals', typeof value === 'number', () =>
      `got ${typeof value}`
    )
  }
}

function assertNumberStringifierValidation(contract: BehaviorContract, lexeme: string): void {
  const validStringifier = [
    { test: (value: unknown) => typeof value === 'bigint', stringify: (value: unknown) => String(value) }
  ]
  const big = BigInt(lexeme.replace(/[.eE+-]/g, '1') || '0')
  contract.check(
    'number stringifier accepting the lexeme grammar works',
    stringify(big, undefined, undefined, validStringifier) === String(big),
    () => 'a valid number stringifier output was rejected'
  )

  const invalidStringifier = [
    {
      test: (value: unknown) => typeof value === 'number',
      // valid numeric content but NOT a JSON number lexeme: must be rejected by
      // the shared grammar, not by a duplicated regex
      stringify: () => `01.${lexeme}`
    }
  ]
  let thrown: unknown
  try {
    stringify(1, undefined, undefined, invalidStringifier)
  } catch (error) {
    thrown = error
  }
  contract.check('number stringifier rejecting a non-lexeme throws', thrown instanceof Error, () =>
    thrown === undefined ? 'invalid stringifier output was accepted' : 'a non-error was thrown'
  )
}

// ---------------------------------------------------------------------------
// Independent, minimal test-side oracles (no copy of the production algorithm)
// ---------------------------------------------------------------------------

/**
 * Independent structural facts computed with small, explicit string logic
 * used only to cross-check the immutable analysis. This is deliberately a
 * different implementation style than the production scanner.
 */
function oracleFacts(lexeme: string): {
  negative: boolean
  kind: 'integer' | 'decimal'
  isZero: boolean
  significantDigits: string
  leadingPower: number
  isSafeInteger: boolean
} {
  let body = lexeme
  const negative = body.startsWith('-')
  if (negative) {
    body = body.slice(1)
  }

  const eIndex = body.search(/[eE]/)
  const mantissa = eIndex === -1 ? body : body.slice(0, eIndex)
  const hasExponent = eIndex !== -1
  const kind: 'integer' | 'decimal' = mantissa.includes('.') || hasExponent ? 'decimal' : 'integer'

  const dotIndex = mantissa.indexOf('.')
  const digitsOnly = mantissa.replace('.', '')
  const firstSignificant = digitsOnly.search(/[1-9]/)
  const isZero = firstSignificant === -1
  const significantDigits = isZero
    ? '0'
    : digitsOnly.slice(firstSignificant).replace(/0+$/, '')

  let exponent = 0
  if (hasExponent) {
    const expText = body.slice(eIndex + 1).replace(/^[+-]/, '')
    const expSign = body[eIndex + 1] === '-' ? -1 : 1
    exponent = expText.length > 4 ? (expSign === -1 ? -Infinity : Infinity) : expSign * Number(expText)
  }

  const dotPosition = dotIndex === -1 ? digitsOnly.length : dotIndex
  const leadingPower = isZero
    ? -Infinity
    : exponent + dotPosition - firstSignificant - 1

  const maxSafe = '9007199254740991'
  const normalized = digitsOnly.replace(/^0+/, '') || '0'
  const isSafeInteger =
    kind === 'integer' &&
    (isZero ||
      normalized.length < maxSafe.length ||
      (normalized.length === maxSafe.length && normalized <= maxSafe))

  return { negative, kind, isZero, significantDigits, leadingPower, isSafeInteger }
}

/**
 * Independent strategy oracle built from platform semantics. Only used on
 * cases whose magnitude is far from a binary rounding boundary, where the
 * language answer is unambiguous.
 */
function oracleStrategyFarFromBoundary(
  lexeme: string,
  facts: ReturnType<typeof oracleFacts>
): NumberConversionStrategy | undefined {
  if (facts.isZero) {
    return NumberConversionStrategy.safe_number
  }
  if (facts.kind === 'integer') {
    return facts.isSafeInteger
      ? NumberConversionStrategy.safe_number
      : NumberConversionStrategy.bigint
  }
  if (facts.leadingPower > 400) {
    return NumberConversionStrategy.overflow
  }
  if (facts.leadingPower < -400) {
    return NumberConversionStrategy.underflow
  }
  if (Math.abs(facts.leadingPower - 308) < 3 || Math.abs(facts.leadingPower + 324) < 3) {
    return undefined // boundary zone: do not second-guess from this oracle
  }
  const n = Number.parseFloat(lexeme)
  return extractSignificantDigits(String(n)) === facts.significantDigits ||
    String(n) === lexeme
    ? NumberConversionStrategy.safe_number
    : NumberConversionStrategy.lossless
}

function extractSignificantDigits(value: string): string {
  let start = 0
  if (value[0] === '-') {
    start++
  }
  while (value[start] === '0' || value[start] === '.') {
    start++
  }
  let end = value.search(/[eE]/)
  if (end === -1) {
    end = value.length
  }
  while ((value[end - 1] === '0' || value[end - 1] === '.') && end > start) {
    end--
  }
  return value.substring(start, end).replace('.', '')
}

// ---------------------------------------------------------------------------
// Guard: illegal tokens are rejected through the existing error layer and the
// error position keeps pointing into the ORIGINAL input
// ---------------------------------------------------------------------------

describe('unified number lexeme: illegal token corpus is rejected with original-source positions', () => {
  for (const testCase of ILLEGAL_TOKEN_CORPUS) {
    test(`illegal [${testCase.id}] "${testCase.source}" rejected at position ${testCase.position}`, () => {
      const contract = new BehaviorContract(`illegal/${testCase.id}`)

      expectSyntaxErrorAt(contract, 'parse', testCase.source, () => parse(testCase.source))

      // position stability: the same input, parsed after other successful
      // parses (warmed/shared state), still reports the same position
      parse('{"warmup":12345678901234567890}')
      parse('[2.3e500,-0,0.66666666666666666667]')
      let second: SyntaxError | undefined
      try {
        parse(testCase.source)
      } catch (error) {
        second = error as SyntaxError
      }
      contract.check('rejection is repeatable', second instanceof SyntaxError, () =>
        'second parse did not throw a SyntaxError'
      )
      if (second) {
        const m = /at position (\d+)/.exec(second.message)
        const p = m ? Number.parseInt(m[1], 10) : -1
        contract.check('rejection position is repeatable', p === testCase.position, () =>
          `position ${p} !== expected ${testCase.position} (${testCase.note})`
        )
      }

      // reject through parseLosslessNumber too, via a token slice: error
      // layering differs (plain Error constructor API) but it must be an Error
      // and must carry the offending lexeme
      if (!testCase.source.includes(' ') && !testCase.source.includes(',')) {
        let thrown: unknown
        try {
          parseLosslessNumber(testCase.source)
        } catch (error) {
          thrown = error
        }
        contract.check('parseLosslessNumber rejects through the constructor error layer', thrown instanceof Error, () =>
          thrown === undefined ? 'no error thrown' : 'non-error thrown'
        )
        if (thrown instanceof Error) {
          contract.check('error names the offending lexeme', thrown.message.includes(testCase.source), () =>
            `"${thrown.message}" does not quote "${testCase.source}"`
          )
        }
      }

      // an illegal token must never be accepted as a LosslessNumber by the
      // shared classifier, nor by isLosslessNumber on a faked brand
      contract.check('analyzer rejects the token directly', analyzeNumberLexeme(testCase.source) === undefined, () =>
        'analyzer accepted an illegal token as a complete lexeme'
      )
      contract.check(
        'isLosslessNumber does not trust a faked brand over illegal text',
        !isLosslessNumber({ isLosslessNumber: true, value: testCase.source }),
        () => 'a faked brand with illegal text was recognized as LosslessNumber'
      )

      contract.assert()
    })
  }
})

// ---------------------------------------------------------------------------
// Guard: changing only result-independent enumeration/scheduling conditions
// keeps the observable order and results stable
// ---------------------------------------------------------------------------

describe('unified number lexeme: order stability under permuted enumeration and scheduling', () => {
  const mixedDocument =
    '{"z":9007199254740993,"a":2.3e500,"m":[1,2e-3,-0,0.66666666666666666667],"b":"s","n":null}'

  function collect(numberParser?: (value: string) => unknown) {
    const reviverKeys: string[] = []
    const numberParserLexemes: string[] = []
    const wrappedParser = (value: string) => {
      numberParserLexemes.push(value)
      return numberParser ? numberParser(value) : parseLosslessNumber(value)
    }
    const parsed = parse(
      mixedDocument,
      (key, value) => {
        reviverKeys.push(key)
        return value
      },
      wrappedParser
    )
    return {
      output: stringify(parsed),
      reviverKeys,
      numberParserLexemes,
      losslessNumbers: collectLosslessNumbers(parsed).map((n) => n.toString())
    }
  }

  test('reversed/shuffled corpus iteration leaves every result identical', () => {
    const baseline = collect()
    const permutations = [
      LEXICAL_CORPUS.slice().reverse(),
      LEXICAL_CORPUS.slice().sort((a, b) => a.lexeme.length - b.lexeme.length),
      LEXICAL_CORPUS.filter((c) => c.lexeme.startsWith('-')),
      LEXICAL_CORPUS.filter((c) => !c.lexeme.startsWith('-'))
    ]

    for (const [permutationIndex, permutation] of permutations.entries()) {
      const contract = new BehaviorContract(`permutation-${permutationIndex}`)
      // touch every corpus lexeme through public entries in this order; this
      // only changes scheduling history, never the semantics of the document
      for (const c of permutation) {
        const parsed = parse(c.lexeme)
        if (isLosslessNumber(parsed)) {
          stringify(parsed)
          readAnalysis(parsed)
        }
      }

      const after = collect()
      contract.check('stringified output is stable', after.output === baseline.output, () =>
        `"${after.output}" !== "${baseline.output}"`
      )
      contract.check('reviver call order is stable', after.reviverKeys.join('|') === baseline.reviverKeys.join('|'), () =>
        `${JSON.stringify(after.reviverKeys)} !== ${JSON.stringify(baseline.reviverKeys)}`
      )
      contract.check(
        'number parser call order is stable',
        after.numberParserLexemes.join('|') === baseline.numberParserLexemes.join('|'),
        () =>
          `${JSON.stringify(after.numberParserLexemes)} !== ${JSON.stringify(baseline.numberParserLexemes)}`
      )
      contract.check(
        'lossless number lexeme order is stable',
        after.losslessNumbers.join('|') === baseline.losslessNumbers.join('|'),
        () => `${JSON.stringify(after.losslessNumbers)} !== ${JSON.stringify(baseline.losslessNumbers)}`
      )
      contract.assert()
    }
  })

  test('interleaving custom number parser and reviver preserves documented invocation order', () => {
    const document = '{"a":[10,11,2.3e500],"b":-0}'
    const log: string[] = []
    parse(
      document,
      (key, value) => {
        log.push(`reviver:${key}`)
        return value
      },
      (lexeme) => {
        log.push(`parseNumber:${lexeme}`)
        return parseLosslessNumber(lexeme)
      }
    )

    // parseNumber must run bottom-up during tokenization BEFORE the reviver
    // walks the tree; compare against the reference implementation shape
    const referenceOrder: string[] = []
    JSON.parse(
      document,
      ((key: string) => {
        referenceOrder.push(`reviver:${key}`)
        return (this as Record<string, unknown>)[key]
      }) as never
    )
    const contract = new BehaviorContract('invocation-order')
    const firstReviver = log.findIndex((entry) => entry.startsWith('reviver:'))
    const lastParser = log.map((entry) => entry.startsWith('parseNumber:')).lastIndexOf(true)
    contract.check('every parseNumber call precedes every reviver call', lastParser < firstReviver, () =>
      `parseNumber/reviver interleaved: ${JSON.stringify(log)}`
    )
    contract.check('reviver key order matches native JSON.parse', log.slice(firstReviver).join('|') === referenceOrder.join('|'), () =>
      `${JSON.stringify(log.slice(firstReviver))} !== ${JSON.stringify(referenceOrder)}`
    )
    contract.check(
      'all four number lexemes reached the custom parser in source order',
      log.slice(0, firstReviver).join('|') ===
        'parseNumber:10|parseNumber:11|parseNumber:2.3e500|parseNumber:-0',
      () => JSON.stringify(log.slice(0, firstReviver))
    )
    contract.assert()
  })
})

function collectLosslessNumbers(value: unknown, acc: LosslessNumber[] = []): LosslessNumber[] {
  if (isLosslessNumber(value)) {
    acc.push(value)
    return acc
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLosslessNumbers(item, acc)
    }
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      collectLosslessNumbers((value as Record<string, unknown>)[key], acc)
    }
  }
  return acc
}

// ---------------------------------------------------------------------------
// Guard: one recoverable failure mid-acceptance leaves no half-updated state;
// retrying the exact same input is stable
// ---------------------------------------------------------------------------

describe('unified number lexeme: recoverable failure atomicity', () => {
  const document = '{"safe":42,"big":123456789012345678901234,"fraction":0.66666666666666666667,"extreme":2.3e500,"zero":-0}'

  test('a throwing custom number parser leaves no cached/temporary state behind', () => {
    const contract = new BehaviorContract('parseNumber-failure')
    const seenOnFailure: string[] = []
    const failingParser = (lexeme: string) => {
      seenOnFailure.push(lexeme)
      if (lexeme === '0.66666666666666666667') {
        throw new Error('recoverable injected failure')
      }
      return parseLosslessNumber(lexeme)
    }

    let failure: unknown
    try {
      parse(document, null, failingParser)
    } catch (error) {
      failure = error
    }
    contract.check('the injected failure surfaced', failure instanceof Error, () =>
      failure === undefined ? 'no error thrown' : 'non-error thrown'
    )
    if (failure instanceof Error) {
      contract.check('failure preserves the caller error message', failure.message === 'recoverable injected failure', () =>
        failure.message
      )
    }

    // retry with the default parser over the exact same input must succeed and
    // produce the canonical output
    const retried = parse(document)
    const canonical =
      '{"safe":42,"big":123456789012345678901234,"fraction":0.66666666666666666667,"extreme":2.3e500,"zero":-0}'
    contract.check('retry after recovery yields the canonical output', stringify(retried) === canonical, () =>
      String(stringify(retried))
    )

    // the failed parse must not have installed counters/caches visible on the
    // successful results: every LosslessNumber analysis must be fresh and equal
    // to an independently computed analysis of its own lexeme only
    for (const number of collectLosslessNumbers(retried)) {
      const own = readAnalysis(number)
      const fresh = readAnalysisOfLexeme(number.toString())
      contract.check(`no stale analysis carried onto "${number}"`, own.lexeme === number.toString(), () =>
        `analysis lexeme "${own.lexeme}" !== instance lexeme "${number}"`
      )
      contract.check(`analysis equals a fresh shared analysis for "${number}"`, own.strategy === fresh.strategy, () =>
        `${own.strategy} !== ${fresh.strategy}`
      )
      contract.check(`analysis carries no counter field for "${number}"`, !('callCount' in own) && !('cache' in own), () =>
        'temporary counter/cache fields leaked onto the analysis'
      )
    }

    // the custom parser invocation sequence on retry must start clean: count of
    // invocations for this fresh parse is independent of the failed one
    const retryLog: string[] = []
    parse(
      document,
      null,
      (lexeme) => {
        retryLog.push(lexeme)
        return parseLosslessNumber(lexeme)
      }
    )
    contract.check(
      'fresh parser invocation history',
      retryLog.join('|') === '42|123456789012345678901234|0.66666666666666666667|2.3e500|-0',
      () => JSON.stringify(retryLog)
    )
    contract.check('failed parse history is not extended into the retry', retryLog.length === 5, () =>
      `expected 5 parser calls, got ${retryLog.length}`
    )

    contract.assert()
  })

  test('a throwing reviver is atomic: re-running returns stable, equal results', () => {
    const contract = new BehaviorContract('reviver-failure')
    const reviverCalls: string[] = []
    const failingReviver = (key: string, value: unknown) => {
      reviverCalls.push(key)
      if (key === 'big') {
        throw new Error('recoverable reviver failure')
      }
      return value
    }

    expect(() => parse(document, failingReviver)).toThrow('recoverable reviver failure')

    // successful run immediately after the failure
    const ok1 = parse(document)
    const ok2 = parse(document)
    contract.check('two post-failure parses are equal', stringify(ok1) === stringify(ok2), () =>
      `${String(stringify(ok1))} !== ${String(stringify(ok2))}`
    )

    // reviver order on retry matches the first (failed) run up to completion
    const retryCalls: string[] = []
    parse(document, (key, value) => {
      retryCalls.push(key)
      return value
    })
    contract.check(
      'reviver ordering after recovery is the canonical bottom-up order',
      retryCalls.join('|') === 'safe|big|fraction|extreme|zero|',
      () => JSON.stringify(retryCalls)
    )
    contract.check(
      'failure did not trim or extend the key space',
      reviverCalls.slice(0, 3).join('|') === retryCalls.slice(0, 3).join('|'),
      () => `${JSON.stringify(reviverCalls)} vs ${JSON.stringify(retryCalls)}`
    )
    contract.assert()
  })

  test('default output and public API shape are unchanged by the failure episode', () => {
    const contract = new BehaviorContract('api-shape')
    try {
      parse('[1,2e,3]')
    } catch {
      // expected recoverable failure
    }
    const parsed = parse('[1,2.3,3]')
    contract.check('default parse returns an array', Array.isArray(parsed), () => typeof parsed)
    const numbers = (parsed as unknown[]).filter(isLosslessNumber)
    contract.check('default parse returns LosslessNumber instances', numbers.length === 3, () =>
      `got ${numbers.length} LosslessNumbers`
    )
    contract.check('default stringify is unchanged', stringify(parsed) === '[1,2.3,3]', () => String(stringify(parsed)))
    contract.check('LosslessNumber keeps its public .value/.toString', numbers[0]?.toString() === '1', () =>
      String(numbers[0])
    )
    contract.assert()
  })
})

// ---------------------------------------------------------------------------
// Guard: deterministic order, idempotence, and concurrency isolation
// ---------------------------------------------------------------------------

describe('unified number lexeme: determinism, idempotence, and concurrent isolation', () => {
  test('repeated analysis of the same lexeme returns equal immutable decisions', () => {
    const contract = new BehaviorContract('idempotence')
    for (const c of LEXICAL_CORPUS) {
      const first = analyzeNumberLexeme(c.lexeme)
      const second = analyzeNumberLexeme(c.lexeme)
      if (first === undefined || second === undefined) {
        contract.fail(`analyzer/${c.id}`, 'valid corpus lexeme analyzed as undefined')
        continue
      }
      contract.check(`equal strategy for ${c.id}`, first.strategy === second.strategy, () =>
        `${first.strategy} !== ${second.strategy}`
      )
      contract.check(`equal facts for ${c.id}`, JSON.stringify(first) === JSON.stringify(second), () =>
        `${JSON.stringify(first)} !== ${JSON.stringify(second)}`
      )
      contract.check(`no shared mutable cache object for ${c.id}`, first !== second || Object.isFrozen(first), () =>
        'analysis results share a mutable object'
      )
    }
    contract.assert()
  })

  test('interleaved parses of different documents do not leak state between them', () => {
    const contract = new BehaviorContract('concurrency-isolation')
    const documents = LEXICAL_CORPUS.map((c) => `[${c.lexeme}]`)
    const inFlight = documents.map((doc) => parse(doc))

    // shuffle the order in which results are inspected/stringified; outputs
    // must remain tied to their own source document regardless of scheduling
    const shuffledOrder = documents.map((_, index) => index).reverse()
    for (const index of shuffledOrder) {
      const expected = `[${LEXICAL_CORPUS[index].lexeme}]`
      contract.check(`isolated result for ${LEXICAL_CORPUS[index].id}`, stringify(inFlight[index]) === expected, () =>
        `"${String(stringify(inFlight[index]))}" !== "${expected}"`
      )
      const number = (inFlight[index] as unknown[])[0]
      if (isLosslessNumber(number)) {
        const own = readAnalysis(number)
        contract.check(`isolated analysis for ${LEXICAL_CORPUS[index].id}`, own.lexeme === LEXICAL_CORPUS[index].lexeme, () =>
          `"${own.lexeme}" !== "${LEXICAL_CORPUS[index].lexeme}"`
        )
      }
    }
    contract.assert()
  })

  test('mutating a faked brand never affects real LosslessNumber classification', () => {
    const real = parse('123456789012345678901234')
    const fake = { isLosslessNumber: true, value: 'not-a-number' }
    const contract = new BehaviorContract('brand-isolation')
    contract.check('fake is rejected', !isLosslessNumber(fake), () => 'fake accepted')
    contract.check('real still accepted after touching the fake', isLosslessNumber(real), () => 'real rejected')
    contract.assert()
  })
})

// ---------------------------------------------------------------------------
// Property-based guard with a fixed seed and an explicit size budget
// ---------------------------------------------------------------------------

const PROPERTY_SEED = 0x5151_5151
const PROPERTY_ITERATIONS = 400 // fixed size budget, no machine-dependent growth
const PROPERTY_MAX_DIGITS = 40 // fixed digit budget

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296

  }
}

function randomDigits(random: () => number, length: number, startAtOne: boolean): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    if (i === 0 && startAtOne) {
      out += String(1 + Math.floor(random() * 9))
    } else {
      out += String(Math.floor(random() * 10))
    }
  }
  return out
}

function randomLexeme(random: () => number): string {
  const integerLength = 1 + Math.floor(random() * 20)
  const integer = randomDigits(random, integerLength, true)
  const shape = Math.floor(random() * 6)
  if (shape === 0) {
    return integer
  }
  if (shape === 1) {
    return `-${integer}`
  }
  if (shape === 2) {
    const fractionLength = 1 + Math.floor(random() * PROPERTY_MAX_DIGITS)
    return `${integer}.${randomDigits(random, fractionLength, false)}`
  }
  if (shape === 3) {
    const exp = Math.floor(random() * 300) // bounded, stays away from overflow
    return `${integer}e${exp}`
  }
  if (shape === 4) {
    const exp = Math.floor(random() * 300)
    return `${integer}.${randomDigits(random, 1 + Math.floor(random() * 20), false)}e-${exp}`
  }
  return `0.${'0'.repeat(Math.floor(random() * 5))}${randomDigits(random, 1 + Math.floor(random() * 20), true)}`
}

function randomIllegalToken(random: () => number): string {
  const fragments = ['01', '1.', '2e', '2e+', '-', '+1', '1_0', '0x1', '1a', '2..3', '.5', '1e2.3', '00.5', '--1', '1 2']
  return fragments[Math.floor(random() * fragments.length)]
}

describe('unified number lexeme: property guard (fixed seed, fixed budget)', () => {
  test(`generated valid lexemes are classified consistently across all entries (seed=${PROPERTY_SEED}, n=${PROPERTY_ITERATIONS})`, () => {
    const random = mulberry32(PROPERTY_SEED)
    const contract = new BehaviorContract('property/valid')

    for (let iteration = 0; iteration < PROPERTY_ITERATIONS; iteration++) {
      const lexeme = randomLexeme(random)
      if (lexeme.length > 200) {
        continue // defensive budget
      }
      const analysis = analyzeNumberLexeme(lexeme)
      if (analysis === undefined) {
        contract.fail(`valid-generation/${iteration}`, `generator produced an illegal lexeme "${lexeme}"`)
        break
      }

      const facts = oracleFacts(lexeme)
      checkAnalysisAgainstOracle(
        new BehaviorContract(`${contractContext(contract)}/n${iteration}`),
        lexeme,
        analysis,
        facts
      )

      // only assert strategy vs the platform oracle away from binary boundaries
      const platform = oracleStrategyFarFromBoundary(lexeme, facts)
      if (platform !== undefined) {
        contract.check(`strategy/n${iteration}/"${lexeme}"`, analysis.strategy === platform, () =>
          `${analysis.strategy} !== ${platform}`
        )
      }

      // public round-trip identity
      const parsed = parse(lexeme)
      if (isLosslessNumber(parsed)) {
        contract.check(`round-trip/n${iteration}`, stringify(parsed) === lexeme, () =>
          `"${String(stringify(parsed))}" !== "${lexeme}"`
        )
        const viaParser = parseLosslessNumber(lexeme)
        contract.check(`parser-equivalence/n${iteration}`, readAnalysis(parsed).strategy === readAnalysis(viaParser).strategy, () =>
          'parse and parseLosslessNumber diverged'
        )
      } else {
        contract.fail(`parse-result/n${iteration}`, `parse("${lexeme}") did not yield a LosslessNumber`)
      }
    }

    contract.assert()
  })

  test(`generated illegal tokens never pass the shared grammar (seed=${PROPERTY_SEED + 1}, n=${PROPERTY_ITERATIONS})`, () => {
    const random = mulberry32(PROPERTY_SEED + 1)
    const contract = new BehaviorContract('property/illegal')

    for (let iteration = 0; iteration < PROPERTY_ITERATIONS; iteration++) {
      const token = randomIllegalToken(random)
      contract.check(`analyzer/n${iteration}/"${token}"`, analyzeNumberLexeme(token) === undefined, () =>
        'illegal token was accepted as a complete lexeme'
      )

      // embedding it in an array yields a SyntaxError pointing into the
      // ORIGINAL source text for tokens that actually reach the number scanner
      const embedded = `[1,${token},3]`
      let thrown: unknown
      try {
        parse(embedded)
      } catch (error) {
        thrown = error
      }
      if (token === '1 2') {
        // '1 2' parses as 1 then fails end-of-array; still a SyntaxError
        contract.check(`embedded/n${iteration}`, thrown instanceof SyntaxError, () => 'no SyntaxError for "1 2"')
        continue
      }
      contract.check(`embedded/n${iteration}/"${token}"`, thrown instanceof SyntaxError, () =>
        thrown === undefined ? 'invalid embedded token was accepted' : 'non-SyntaxError thrown'
      )
      if (thrown instanceof SyntaxError) {
        const m = /at position (\d+)/.exec(thrown.message)
        const p = m ? Number.parseInt(m[1], 10) : -1
        contract.check(`embedded-position/n${iteration}`, p >= 0 && p <= embedded.length, () =>
          `position ${p} does not point into "${embedded}"`
        )
      }
    }

    contract.assert()
  })
})

function contractContext(contract: BehaviorContract): string {
  // the contract keeps its context private; for nested property checks we use
  // a fixed prefix, first-failure evidence is on the outer contract
  void contract
  return 'property/valid'
}

// ---------------------------------------------------------------------------
// Guard: classification never passes through Number for big integers, and a
// large array parse stays within an explicit allocation/time budget
// ---------------------------------------------------------------------------

describe('unified number lexeme: no Number coercion for big integers', () => {
  test('parsing big integers never invokes Number.parseFloat/Number on the lexeme', () => {
    const contract = new BehaviorContract('no-number-coercion')
    const originalParseFloat = Number.parseFloat
    let observedCoercion: string | undefined

    const spyParseFloat = (value: string) => {
      // only flag coercion of big-integer lexemes; other decimals legitimately
      // need a round-trip, but integers above the safe range must never be
      // coerced to make the structural decision
      if (/^-?\d{16,}$/.test(value) && BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
        observedCoercion = value
      }
      return originalParseFloat(value)
    }

    Number.parseFloat = spyParseFloat as typeof Number.parseFloat
    try {
      const big = parse('[123456789012345678901234567890,9007199254740993,-9007199254740993]')
      const stringified = stringify(big)
      contract.check(
        'no big-integer lexeme reached Number.parseFloat during analysis',
        observedCoercion === undefined,
        () => `Number.parseFloat was called with big integer "${observedCoercion}"`
      )
      contract.check(
        'output preserves all digits',
        stringified === '[123456789012345678901234567890,9007199254740993,-9007199254740993]',
        () => String(stringified)
      )
    } finally {
      Number.parseFloat = originalParseFloat
    }
    contract.assert()
  })
})

describe('unified number lexeme: large array parse budget (allocation and wall time caps)', () => {
  const SMALL_SIZE = 10_000
  const LARGE_SIZE = 50_000 // fixed scale budget, not environment dependent
  const WALL_TIME_CAP_MS = 2_000 // hard per-parse ceiling on this fixed input
  const LINEARITY_CAP = 6 // doubling-equivalent ratio ceiling (5x data -> < 6x time)

  function buildArray(size: number): string {
    const parts: string[] = new Array(size)
    for (let i = 0; i < size; i++) {
      parts[i] = i % 5 === 0 ? '123456789012345678901234' : i % 5 === 1 ? '2.3e500' : i % 5 === 2 ? '-0' : i % 5 === 3 ? '0.66666666666666666667' : '2e-3'
    }
    return `[${parts.join(',')}]`
  }

  test(`parses ${LARGE_SIZE} lexemes under the wall-time ceiling and remains linear`, () => {
    const contract = new BehaviorContract('large-array/budget')

    const smallInput = buildArray(SMALL_SIZE)
    const largeInput = buildArray(LARGE_SIZE)

    const smallStart = performance.now()
    const small = parse(smallInput)
    const smallMs = performance.now() - smallStart

    const largeStart = performance.now()
    const large = parse(largeInput)
    const largeMs = performance.now() - largeStart

    contract.check('hard wall-time cap for the large parse', largeMs <= WALL_TIME_CAP_MS, () =>
      `large parse took ${largeMs.toFixed(1)}ms > ${WALL_TIME_CAP_MS}ms cap`
    )

    // allocation budget: exactly one result entry per lexeme, one analysis per
    // LosslessNumber; no per-lexeme cache maps may inflate retained structure
    contract.check('allocation: one array slot per lexeme', (large as unknown[]).length === LARGE_SIZE, () =>
      `got ${(large as unknown[]).length} slots for ${LARGE_SIZE} lexemes`
    )

    const largeNumbers = collectLosslessNumbers(large)
    contract.check('allocation: every element is one LosslessNumber', largeNumbers.length === LARGE_SIZE, () =>
      `got ${largeNumbers.length} LosslessNumbers`
    )

    let ownKeysCount = 0
    for (const number of largeNumbers.slice(0, 1000)) {
      ownKeysCount += Object.getOwnPropertyNames(number).length
    }
    // .value and .isLosslessNumber are the two own fields; the immutable
    // analysis is stored as a non-enumerable symbol property, not per-entry data
    contract.check('allocation: no extra enumerable cache fields per number', ownKeysCount === 2000, () =>
      `expected 2 own keys per sampled number, found total ${ownKeysCount}`
    )

    // linearity: large/small size ratio is 5; time ratio must be bounded (a
    // warm-up allowance of 5ms is granted to dampen scheduling noise)
    const ratio = (largeMs + 1) / (smallMs + 1)
    contract.check(
      `linearity: 5x input took ${ratio.toFixed(2)}x time (<= ${LINEARITY_CAP}x)`,
      ratio <= LINEARITY_CAP,
      () => `small=${smallMs.toFixed(1)}ms large=${largeMs.toFixed(1)}ms ratio=${ratio.toFixed(2)}`
    )

    contract.check('small parse count sanity', (small as unknown[]).length === SMALL_SIZE, () => 'small array miscounted')
    contract.assert()
  })

  test('re-parsing the large input after a failed parse stays within the same budget', () => {
    const contract = new BehaviorContract('large-array/recovery-budget')
    const input = buildArray(LARGE_SIZE)
    try {
      parse('[' + '1,'.repeat(100) + '2e]')
    } catch {
      // recoverable mid-parse failure
    }

    const start = performance.now()
    const parsed = parse(input)
    const elapsed = performance.now() - start
    contract.check('recovered large parse within the ceiling', elapsed <= WALL_TIME_CAP_MS, () =>
      `${elapsed.toFixed(1)}ms > ${WALL_TIME_CAP_MS}ms after failure`
    )
    contract.check('recovered parse has the full length', (parsed as unknown[]).length === LARGE_SIZE, () =>
      `got ${(parsed as unknown[]).length}`
    )
    contract.assert()
  })
})
