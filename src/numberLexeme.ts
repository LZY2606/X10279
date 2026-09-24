/**
 * Unified analysis of JSON number lexemes.
 *
 * Every public entry point that has to classify or convert a JSON number
 * (`parse`, `parseLosslessNumber`, `LosslessNumber#valueOf`,
 * `getUnsafeNumberReason`, the number parser `parseNumberAndBigInt`, and
 * `stringify` validation) goes through this module, so the decision about
 * how a number lexeme is converted always derives from the same immutable
 * {@link NumberLexemeAnalysis}.
 *
 * Structural classification (integer vs decimal, safe integer range,
 * overflow/underflow magnitude) is computed purely on the lexeme text. The
 * JavaScript `Number` type is never consulted while parsing the lexeme, so
 * long integers cannot silently lose precision before the conversion decision
 * is made. `Number.parseFloat` is only invoked on the original lexeme text
 * for the two things that genuinely require IEEE-754 rounding: the exact
 * safe-float roundtrip check and the tiny underflow/overflow boundary zone
 * around `Number.MIN_VALUE`/`Number.MAX_VALUE`.
 */

/** Conversion strategy derived once from an immutable lexeme analysis. */
export enum NumberConversionStrategy {
  /** The lexeme round-trips exactly through a JavaScript `Number`. */
  safe_number = 'safe_number',
  /** Decimal that only loses insignificant digits when converted to `Number`. */
  truncate_float = 'truncate_float',
  /** Integer that fits in the IEEE-754 safe integer range. */
  safe_integer = 'safe_integer',
  /** Integer outside the safe integer range; converts losslessly to `bigint`. */
  bigint = 'bigint',
  /** Magnitude is larger than `Number.MAX_VALUE`; conversion yields Infinity. */
  overflow = 'overflow',
  /** Non-zero magnitude smaller than `Number.MIN_VALUE`; conversion yields 0. */
  underflow = 'underflow'
}

/** The structural parts a JSON number lexeme is split into. */
export interface NumberLexemeParts {
  sign: '-' | ''
  integerDigits: string
  fractionDigits: string
  exponentDigits: string
  exponentSign: '-' | '+' | ''
}

/**
 * Immutable result of analyzing a single JSON number lexeme.
 * The object and all nested objects are frozen; every call for a distinct
 * lexeme produces a fresh object, so there is no shared cache that a failed
 * call could poison.
 */
export interface NumberLexemeAnalysis {
  /** Original lexeme text, exactly as it occurred in the JSON input. */
  readonly lexeme: string
  /** True when the lexeme is structurally an integer (no fraction/exponent). */
  readonly isInteger: boolean
  /** True when the lexeme denotes zero (handles 0, -0, 0.0, 0e99, ...). */
  readonly isZero: boolean
  /** True for the textual zero values `0`, `-0`, `0.0`, `-0.0`. */
  readonly isNegativeZero: boolean
  readonly parts: Readonly<NumberLexemeParts>
  /** Significant (mantissa) digits with leading and trailing zeros removed. */
  readonly significantDigits: string
  /** Number of significant digits. */
  readonly significantDigitCount: number
  /** Scientific exponent of the most significant digit, exact (bigint). */
  readonly adjustedExponent: bigint
  /** The single conversion strategy all entry points must follow. */
  readonly strategy: NumberConversionStrategy
}

/** Result of scanning a lexeme inside a larger JSON text. */
export interface NumberLexemeToken extends NumberLexemeParts {
  /** Start index, inclusive. */
  start: number
  /** End index, exclusive. */
  end: number
  /** True when a number lexeme starts at `start` (possibly malformed). */
  started: boolean
}

/** A scanner that got a sign or digit but is missing a required digit. */
export interface NumberLexemeError {
  token: NumberLexemeToken
  /** Index where the required digit was missing. */
  at: number
}

const codeZero = 0x30
const codeNine = 0x39
const codePlus = 0x2b // "+"
const codeMinus = 0x2d // "-"
const codeDot = 0x2e // "."
const codeLowercaseE = 0x65 // "e"
const codeUppercaseE = 0x45 // "E"

function isDigitCode(code: number | undefined): boolean {
  return code !== undefined && code >= codeZero && code <= codeNine
}

function scanDigits(text: string, index: number): number {
  let end = index
  while (isDigitCode(text.charCodeAt(end))) {
    end++
  }
  return end
}

/**
 * Scan a JSON number lexeme starting at `start`, without requiring the whole
 * value to be valid: a leading `-` or digit marks a started lexeme, and a
 * missing mandatory digit is reported separately so the caller can point its
 * error at the original input position.
 */
export function scanNumberLexeme(
  text: string,
  start: number
): { token: NumberLexemeToken; error?: NumberLexemeError } {
  let index = start

  const token: NumberLexemeToken = {
    start,
    end: start,
    started: false,
    sign: '',
    integerDigits: '',
    fractionDigits: '',
    exponentDigits: '',
    exponentSign: ''
  }

  if (text.charCodeAt(index) === codeMinus) {
    token.sign = '-'
    token.started = true
    index++
    if (!isDigitCode(text.charCodeAt(index))) {
      token.end = index
      return { token, error: { token, at: index } }
    }
  }

  if (isDigitCode(text.charCodeAt(index))) {
    token.started = true
    const digitsEnd = scanDigits(text, index)
    token.integerDigits = text.slice(index, digitsEnd)
    index = digitsEnd
  } else if (token.started) {
    token.end = index
    return { token, error: { token, at: index } }
  } else {
    return { token }
  }

  if (text.charCodeAt(index) === codeDot) {
    index++
    if (!isDigitCode(text.charCodeAt(index))) {
      token.end = index
      return { token, error: { token, at: index } }
    }
    const digitsEnd = scanDigits(text, index)
    token.fractionDigits = text.slice(index, digitsEnd)
    index = digitsEnd
  }

  const exponentCode = text.charCodeAt(index)
  if (exponentCode === codeLowercaseE || exponentCode === codeUppercaseE) {
    index++
    if (text.charCodeAt(index) === codeMinus || text.charCodeAt(index) === codePlus) {
      token.exponentSign = text[index] === '-' ? '-' : '+'
      index++
    }
    if (!isDigitCode(text.charCodeAt(index))) {
      token.end = index
      return { token, error: { token, at: index } }
    }
    const digitsEnd = scanDigits(text, index)
    token.exponentDigits = text.slice(index, digitsEnd)
    index = digitsEnd
  }

  token.end = index
  return { token }
}

/**
 * Test whether a complete string is a syntactically valid JSON number lexeme.
 * This is the single grammar source, replacing the previously duplicated
 * regular expression.
 */
export function isValidNumberLexeme(value: string): boolean {
  if (value.length === 0) {
    return false
  }

  const { token, error } = scanNumberLexeme(value, 0)
  return (
    !error &&
    token.started &&
    token.end === value.length &&
    hasCanonicalIntegerDigits(token.integerDigits)
  )
}

// JSON grammar disallows leading zeros on multi-digit integer parts.
function hasCanonicalIntegerDigits(integerDigits: string): boolean {
  return integerDigits.length === 1 || integerDigits[0] !== '0'
}

/** Split a validated lexeme into its structural parts. */
function lexemeParts(value: string): NumberLexemeParts {
  const { token } = scanNumberLexeme(value, 0)
  return {
    sign: token.sign,
    integerDigits: token.integerDigits,
    fractionDigits: token.fractionDigits,
    exponentDigits: token.exponentDigits,
    exponentSign: token.exponentSign
  }
}

/**
 * Compute the adjusted exponent (scientific exponent of the most significant
 * digit) using arbitrary-precision integer arithmetic, so extreme exponents
 * such as `1e99999999999999999999` are classified structurally instead of
 * wrapping through a `Number`.
 */
function computeAdjustedExponent(parts: NumberLexemeParts): bigint {
  const integerLength = parts.integerDigits.length
  const exponent =
    parts.exponentDigits.length > 0
      ? BigInt(`${parts.exponentSign === '-' ? '-' : ''}${parts.exponentDigits}`)
      : 0n

  if (parts.fractionDigits.length > 0) {
    // Place the dot after integerLength digits, then count back to the first
    // significant digit, mirroring splitNumber(): leading zeros of the
    // integer part shift the exponent down.
    const mantissa = `${parts.integerDigits}${parts.fractionDigits}`.replace(/^0+/, '')
    const dotExponent = BigInt(integerLength - 1)
    const leadingZeros = BigInt(parts.integerDigits.length + parts.fractionDigits.length - mantissa.length)
    return exponent + dotExponent - leadingZeros
  }

  const mantissa = parts.integerDigits.replace(/^0+/, '')
  if (mantissa.length === 0) {
    // Zero: the adjusted exponent is 0 by convention.
    return 0n
  }

  const leadingZeros = BigInt(parts.integerDigits.length - mantissa.length)
  return exponent + BigInt(integerLength - 1) - leadingZeros
}

function significantDigitsOf(parts: NumberLexemeParts): string {
  const mantissa = `${parts.integerDigits}${parts.fractionDigits}`.replace(/^0+/, '')
  return mantissa.replace(/0+$/, '')
}

const MAX_SAFE_INTEGER_DIGITS = '9007199254740991' // Number.MAX_SAFE_INTEGER

function isSafeIntegerLexeme(parts: NumberLexemeParts): boolean {
  const digits = parts.integerDigits
  if (digits.length < MAX_SAFE_INTEGER_DIGITS.length) {
    return true
  }
  if (digits.length > MAX_SAFE_INTEGER_DIGITS.length) {
    return false
  }
  return digits <= MAX_SAFE_INTEGER_DIGITS
}

function decideStrategy(lexeme: string, parts: NumberLexemeParts, analysis: {
  isZero: boolean
  isInteger: boolean
  significantDigits: string
  adjustedExponent: bigint
}): NumberConversionStrategy {
  if (analysis.isZero) {
    return NumberConversionStrategy.safe_number
  }

  if (analysis.isInteger) {
    return isSafeIntegerLexeme(parts)
      ? NumberConversionStrategy.safe_integer
      : NumberConversionStrategy.bigint
  }

  // Decimal: the magnitude gates are structural and exact.
  // adjustedExponent >= 308 can only round to Infinity; values beyond the
  // decimal range < -324 can only round to zero (the smallest positive
  // finite number is 5e-324, adjusted exponent -324).
  if (analysis.adjustedExponent >= 308n && !boundaryRoundTrips(lexeme)) {
    return NumberConversionStrategy.overflow
  }
  if (analysis.adjustedExponent < -324n) {
    return NumberConversionStrategy.underflow
  }

  // Only here may IEEE-754 rounding be consulted, on the original lexeme:
  // exact round-trip means a safe number, otherwise only insignificant
  // trailing digits are lost.
  return String(Number.parseFloat(lexeme)) === lexeme
    ? NumberConversionStrategy.safe_number
    : NumberConversionStrategy.truncate_float
}

// The overflow threshold is sharp (>=1.8e308), so for adjustedExponent
// exactly 308 the lexeme text itself decides.
function boundaryRoundTrips(lexeme: string): boolean {
  return Number.isFinite(Number.parseFloat(lexeme))
}

/**
 * Analyze a syntactically valid JSON number lexeme and return the immutable,
 * shared basis for every conversion decision.
 *
 * @throws SyntaxError when the input is not a valid JSON number lexeme.
 */
export function analyzeNumberLexeme(value: string): NumberLexemeAnalysis {
  if (!isValidNumberLexeme(value)) {
    throw new SyntaxError(`Invalid number: ${value}`)
  }

  const parts = lexemeParts(value)
  const isInteger = parts.fractionDigits.length === 0 && parts.exponentDigits.length === 0
  const significantDigits = significantDigitsOf(parts)
  const isZero = significantDigits.length === 0
  const adjustedExponent = computeAdjustedExponent(parts)
  const isNegativeZero =
    isZero && parts.sign === '-' && parts.fractionDigits.length === 0 && parts.exponentDigits.length === 0

  const mutableAnalysis = {
    lexeme: value,
    isInteger,
    isZero,
    isNegativeZero,
    parts,
    significantDigits,
    significantDigitCount: significantDigits.length,
    adjustedExponent,
    strategy: NumberConversionStrategy.safe_number
  }
  mutableAnalysis.strategy = decideStrategy(value, parts, mutableAnalysis)

  Object.freeze(mutableAnalysis.parts)
  return Object.freeze(mutableAnalysis)
}

/**
 * Symbol used to attach the shared, immutable analysis of a LosslessNumber
 * without exposing any enumerable public property.
 */
export const numberLexemeAnalysisSymbol: unique symbol = Symbol('numberLexemeAnalysis')
