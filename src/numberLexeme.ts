/**
 * Unified, lossless classification of JSON number lexemes.
 *
 * This module is the single source of truth shared by the public entry points
 * `parse`, `parseLosslessNumber`, `isLosslessNumber`, and `stringify`:
 *
 * - the token grammar of a JSON number lexeme (the character predicates),
 * - the structural facts of a lexeme (sign, integer/decimal/exponent, zero),
 * - and the conversion decision derived from those facts
 *   (`NumberConversionStrategy`).
 *
 * The analysis works purely on the textual lexeme (plus `BigInt` for arbitrary
 * precision integer comparison). It never coerces the input through `Number`
 * before classification, so a long integer cannot silently lose digits and
 * influence the decision. An analysis result is fully frozen: it is an
 * immutable value, not a cache entry, and carries no shared mutable state.
 */

const codeZero = 0x30 // "0"
const codeOne = 0x31 // "1"
const codeNine = 0x39 // "9"
const codeMinus = 0x2d // "-"
const codePlus = 0x2b // "+"
const codeDot = 0x2e // "."
const codeLowercaseE = 0x65 // "e"
const codeUppercaseE = 0x45 // "E"

export function isDigit(code: number | undefined): boolean {
  return code !== undefined && code >= codeZero && code <= codeNine
}

export function isNonZeroDigit(code: number | undefined): boolean {
  return code !== undefined && code >= codeOne && code <= codeNine
}

export function isExponentIndicator(code: number | undefined): boolean {
  return code === codeLowercaseE || code === codeUppercaseE
}

export function isSign(code: number | undefined): boolean {
  return code === codeMinus || code === codePlus
}

/**
 * The conversion strategy selected for a JSON number lexeme.
 *
 * - `safe_number`  -> `Number(...)` preserves the value exactly
 * - `lossless`     -> keep the textual lexeme (a LosslessNumber)
 * - `bigint`       -> an arbitrary precision integer is required
 * - `overflow`     -> converting to Number yields ±Infinity
 * - `underflow`    -> converting to Number yields ±0 for a non-zero value
 */
export enum NumberConversionStrategy {
  safe_number = 'safe_number',
  lossless = 'lossless',
  bigint = 'bigint',
  overflow = 'overflow',
  underflow = 'underflow'
}

export type NumberLexemeKind = 'integer' | 'decimal'

export interface NumberLexemeAnalysis {
  /** the original lexeme, exactly as encountered in the source text */
  readonly lexeme: string
  /** true when the lexeme has a leading '-' */
  readonly negative: boolean
  /** 'integer' when there is no decimal fraction and no exponent */
  readonly kind: NumberLexemeKind
  /** true when the numeric value is zero (covers 0, -0, 0.0, 0e999, ...) */
  readonly isZero: boolean
  /** significant digits without sign, decimal dot and leading/trailing zeros */
  readonly significantDigits: string
  /** decimal position of the first significant digit (Infinity for zero) */
  readonly leadingPower: number
  /** true for integer lexemes that fit in a safe JS integer */
  readonly isSafeInteger: boolean
  /** the single conversion decision derived from the facts above */
  readonly strategy: NumberConversionStrategy
}

interface ScannerResult {
  negative: boolean
  integerDigits: string
  fractionDigits: string
  hasFraction: boolean
  exponentDigits: string
  exponentNegative: boolean
  hasExponent: boolean
}

/**
 * Scan a JSON number lexeme starting at `start`, strictly following the JSON
 * grammar. Returns the structural scan result and the index after the lexeme,
 * or `undefined` when the text does not start with a complete, valid lexeme.
 * Never throws: callers own error creation and source-position reporting.
 */
export function scanNumberLexeme(
  text: string,
  start: number = 0
): { end: number; scan: ScannerResult } | undefined {
  let i = start
  let negative = false

  if (text.charCodeAt(i) === codeMinus) {
    negative = true
    i++
  }

  let integerDigits: string
  if (text.charCodeAt(i) === codeZero) {
    integerDigits = '0'
    i++
  } else if (isNonZeroDigit(text.charCodeAt(i))) {
    const digitStart = i
    i++
    while (isDigit(text.charCodeAt(i))) {
      i++
    }
    integerDigits = text.slice(digitStart, i)
  } else {
    return undefined
  }

  let hasFraction = false
  let fractionDigits = ''
  if (text.charCodeAt(i) === codeDot) {
    hasFraction = true
    const fractionStart = i + 1
    i++
    if (!isDigit(text.charCodeAt(i))) {
      return undefined
    }
    while (isDigit(text.charCodeAt(i))) {
      i++
    }
    fractionDigits = text.slice(fractionStart, i)
  }

  let hasExponent = false
  let exponentNegative = false
  let exponentDigits = ''
  if (isExponentIndicator(text.charCodeAt(i))) {
    hasExponent = true
    i++
    if (text.charCodeAt(i) === codeMinus || text.charCodeAt(i) === codePlus) {
      exponentNegative = text.charCodeAt(i) === codeMinus
      i++
    }
    if (!isDigit(text.charCodeAt(i))) {
      return undefined
    }
    const exponentStart = i
    while (isDigit(text.charCodeAt(i))) {
      i++
    }
    exponentDigits = text.slice(exponentStart, i)
  }

  // a lone '-' is not a number
  if (i === start) {
    return undefined
  }

  return {
    end: i,
    scan: {
      negative,
      integerDigits,
      fractionDigits,
      hasFraction,
      exponentDigits,
      exponentNegative,
      hasExponent
    }
  }
}

/**
 * Analyze a complete JSON number lexeme without lossy numeric coercion.
 * Returns an immutable analysis result, or `undefined` when `lexeme` is not a
 * valid JSON number lexeme (including surrounding whitespace or extra text).
 */
export function analyzeNumberLexeme(lexeme: string): NumberLexemeAnalysis | undefined {
  const scanned = scanNumberLexeme(lexeme, 0)
  if (scanned === undefined || scanned.end !== lexeme.length) {
    return undefined
  }

  return analysisFromScan(lexeme, scanned.scan)
}

function analysisFromScan(lexeme: string, scan: ScannerResult): NumberLexemeAnalysis {
  const {
    negative,
    integerDigits,
    fractionDigits,
    hasFraction,
    exponentDigits,
    exponentNegative,
    hasExponent
  } = scan

  const kind: NumberLexemeKind = hasFraction || hasExponent ? 'decimal' : 'integer'

  const combined = `${integerDigits}${fractionDigits}`
  const firstSignificant = combined.search(/[1-9]/)
  const isZero = firstSignificant === -1

  const significantDigits = isZero
    ? '0'
    : combined.slice(firstSignificant).replace(/0+$/, '')

  // Power of ten of the leading significant digit.
  // Exponent strings longer than 4 digits are beyond every finite double, so
  // keep the result as ±Infinity instead of parsing a lossy JS number.
  let exponent = 0
  if (hasExponent) {
    exponent =
      exponentDigits.length > 4
        ? exponentNegative
          ? Number.NEGATIVE_INFINITY
          : Number.POSITIVE_INFINITY
        : Number.parseInt(exponentDigits, 10) * (exponentNegative ? -1 : 1)
  }

  // position of the decimal point measured from the start of `combined`
  const dotPosition = integerDigits.length
  const leadingPower = isZero
    ? Number.NEGATIVE_INFINITY
    : exponent + dotPosition - firstSignificant - 1

  // integer safety is decided by exact string/bigint comparison: no Number
  // coercion can round a long integer into a (wrong) safe result
  const isSafeInteger =
    kind === 'integer' && !isZero ? isWithinSafeIntegerRange(negative, integerDigits) : isZero

  const strategy = decideConversionStrategy({
    kind,
    isZero,
    significantDigits,
    leadingPower,
    isSafeInteger
  })

  return Object.freeze({
    lexeme,
    negative,
    kind,
    isZero,
    significantDigits,
    leadingPower,
    isSafeInteger,
    strategy
  })
}

const MAX_SAFE_INTEGER_DIGITS = '9007199254740991' // Number.MAX_SAFE_INTEGER

function isWithinSafeIntegerRange(negative: boolean, digits: string): boolean {
  if (digits.length < MAX_SAFE_INTEGER_DIGITS.length) {
    return true
  }
  if (digits.length > MAX_SAFE_INTEGER_DIGITS.length) {
    return false
  }

  // same digit count: compare magnitude exactly. The sign does not affect
  // safety because both safe bounds have the same magnitude. Leading zeros
  // are normalized first; the strict JSON scanner never produces them.
  const normalized = digits.replace(/^0+/, (zeros) => (zeros.length === digits.length ? '0' : ''))
  if (normalized === '0') {
    return true
  }
  return normalized <= MAX_SAFE_INTEGER_DIGITS
}

/**
 * Derive the single conversion decision from structural facts. Shared by every
 * public entry point so classification cannot diverge between parse,
 * parseLosslessNumber, isLosslessNumber, and stringify.
 */
export function decideConversionStrategy(facts: {
  kind: NumberLexemeKind
  isZero: boolean
  significantDigits: string
  leadingPower: number
  isSafeInteger: boolean
}): NumberConversionStrategy {
  const { kind, isZero, significantDigits, leadingPower, isSafeInteger } = facts

  if (isZero) {
    return NumberConversionStrategy.safe_number
  }

  if (kind === 'integer') {
    return isSafeInteger ? NumberConversionStrategy.safe_number : NumberConversionStrategy.bigint
  }

  // decimal: locate the finite-double range from the textual magnitude. The two
  // rounding boundaries are compared exactly against the binary limits
  // (2^1024 for +Infinity, 2^-1075 for rounding to zero) using BigInt, so no
  // lossy Number coercion participates in the decision.
  if (leadingPower > 308) {
    return NumberConversionStrategy.overflow
  }
  if (leadingPower === 308 && roundsBeyondMaxDouble(significantDigits)) {
    return NumberConversionStrategy.overflow
  }
  if (leadingPower < -324) {
    return NumberConversionStrategy.underflow
  }
  if (leadingPower === -324 && roundsBelowMinSubnormal(significantDigits)) {
    return NumberConversionStrategy.underflow
  }

  // finite decimal: whether Number keeps the exact value is resolved via a
  // significant-digit round-trip in `classifyFiniteDecimal`
  return NumberConversionStrategy.lossless
}

// Rounding boundary for +Infinity: the midpoint between Number.MAX_VALUE
// (2^1024 - 2^971) and 2^1024, i.e. 2^1024 - 2^970 = 2^970 * (2^54 - 1).
// The exact tie rounds to Infinity (ties-to-even).
const OVERFLOW_BOUNDARY = 2n ** 970n * (2n ** 54n - 1n)

// 2^1075: used to test the subnormal rounding boundary 2^-1075 exactly
const UNDERFLOW_SCALE = 2n ** 1075n

/**
 * Compare a decimal whose leading power is 308 against 2^1024 exactly.
 * The value equals significantDigits * 10^(309 - digitCount).
 */
function roundsBeyondMaxDouble(significantDigits: string): boolean {
  const digits = BigInt(significantDigits)
  const power = 309 - significantDigits.length
  if (power >= 0) {
    return digits * 10n ** BigInt(power) >= OVERFLOW_BOUNDARY
  }
  return digits >= OVERFLOW_BOUNDARY * 10n ** BigInt(-power)
}

/**
 * Compare a decimal whose leading power is -324 against 2^-1075 exactly.
 * The value equals significantDigits * 10^(-323 - digitCount); it rounds to
 * zero when it is at or below half of the smallest subnormal unit.
 */
function roundsBelowMinSubnormal(significantDigits: string): boolean {
  const digits = BigInt(significantDigits)
  return digits * UNDERFLOW_SCALE <= 10n ** BigInt(323 + significantDigits.length)
}

/**
 * Refine a finite decimal lexeme from the shared structural analysis into
 * either `safe_number` (a Number round-trips the exact significant digits) or
 * `lossless` (some significant digits would be truncated). This is the only
 * place where a `Number` round-trip may occur, and only after the structural
 * decision (integer/overflow/underflow) was already made without coercion.
 */
export function classifyFiniteDecimal(
  analysis: NumberLexemeAnalysis,
  coerce: (lexeme: string) => number
): NumberConversionStrategy {
  if (analysis.strategy !== NumberConversionStrategy.lossless) {
    return analysis.strategy
  }
  if (analysis.isZero || analysis.kind === 'integer') {
    return NumberConversionStrategy.safe_number
  }

  const roundTripped = String(coerce(analysis.lexeme))
  if (analysis.lexeme === roundTripped) {
    return NumberConversionStrategy.safe_number
  }

  const roundTrippedAnalysis = analyzeNumberLexeme(roundTripped)
  if (roundTrippedAnalysis === undefined) {
    return NumberConversionStrategy.lossless
  }

  return roundTrippedAnalysis.significantDigits === analysis.significantDigits
    ? NumberConversionStrategy.safe_number
    : NumberConversionStrategy.lossless
}

/**
 * Fully resolve the conversion strategy for a lexeme, including the finite
 * decimal round-trip check. Pure apart from the injected `coerce` function.
 */
export function resolveConversionStrategy(
  lexeme: string,
  coerce: (lexeme: string) => number = Number.parseFloat
): NumberConversionStrategy | undefined {
  const analysis = analyzeNumberLexeme(lexeme)
  if (analysis === undefined) {
    return undefined
  }
  return classifyFiniteDecimal(analysis, coerce)
}
