/**
 * Unified, lossless analysis of JSON number lexemes.
 *
 * Every public entry point that has to understand a number token
 * (`parse`/`parseLosslessNumber`, `LosslessNumber`, `stringify`) derives its
 * decision from a single {@link analyzeNumberLexeme} result. The analysis is
 * purely lexical: it never routes the value through the IEEE-754 `number`
 * type, so integer precision or extreme exponents cannot be silently rounded
 * before a conversion strategy is chosen.
 *
 * An analysis result is fully frozen and carries no shared/cached state:
 * analyzing the same lexeme twice yields two equivalent but independent
 * objects, and a failed analysis can never poison a later call.
 */

/**
 * The grammar of a JSON number token (RFC 8259, section 6).
 * Kept in one place so validation and the public `isNumber` helper can never
 * drift apart.
 */
export const NUMBER_GRAMMAR = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

export enum UnsafeNumberReason {
  underflow = 'underflow',
  overflow = 'overflow',
  truncate_integer = 'truncate_integer',
  truncate_float = 'truncate_float'
}

/**
 * The single conversion strategy selected for a number lexeme.
 * - `number`: the lexeme converts to a `number` without any information loss
 * - `bigint`: the lexeme is an integer that exceeds the safe-integer range
 * - `overflow` / `underflow`: the magnitude cannot be represented by `number`
 * - `truncate_float`: a decimal that loses only insignificant digits
 * - `invalid`: the token is not a JSON number lexeme
 */
export type NumberConversionStrategy =
  | 'number'
  | 'bigint'
  | 'overflow'
  | 'underflow'
  | 'truncate_float'
  | 'invalid'

export interface ValidNumberLexemeAnalysis {
  /** The original token, verbatim from the input (never normalized). */
  lexeme: string
  valid: true
  /** '-' for negative tokens (including '-0'), '' otherwise. */
  sign: '-' | ''
  /** Digits before the decimal dot, as written (e.g. '0', '120'). */
  integerPart: string
  /** Digits after the decimal dot, or `undefined` when there was no dot. */
  fractionPart: string | undefined
  /** '+' / '-' sign of the exponent, or '' when absent or unsigned. */
  exponentSign: '+' | '-' | ''
  /** Decimal exponent digits as written, or `undefined` when absent. */
  exponentDigits: string | undefined
  /** Decimal exponent parsed without going through `Number`, or `null`. */
  exponentValue: bigint | null
  /** True only when the lexeme has neither a fraction nor an exponent. */
  isStrictInteger: boolean
  /** True for zero in any spelling ('0', '-0', '0.0', '0e5', ...). */
  isZero: boolean
  /** Significant significand digits without leading/trailing zeros ('0' for zero). */
  significandDigits: string
  /** Decimal exponent of {@link significandDigits}, as an exact BigInt. */
  significandDecimalExponent: bigint
}

export interface InvalidNumberLexemeAnalysis {
  lexeme: string
  valid: false
}

export type NumberLexemeAnalysis =
  | ValidNumberLexemeAnalysis
  | InvalidNumberLexemeAnalysis

function freeze<T extends object>(value: T): T {
  return Object.freeze(value)
}

/**
 * Analyze a JSON number lexeme.
 *
 * Always returns an immutable result instead of throwing for invalid input,
 * so callers can distinguish "not a number" from a conversion decision; the
 * public APIs still reject invalid tokens with their existing error layers.
 */
export function analyzeNumberLexeme(lexeme: string): NumberLexemeAnalysis {
  if (!NUMBER_GRAMMAR.test(lexeme)) {
    return freeze<InvalidNumberLexemeAnalysis>({ lexeme, valid: false })
  }

  const sign = lexeme.startsWith('-') ? '-' : ''

  // Re-derive the components with explicit capture groups instead of mutating
  // indexes; all arithmetic on positions stays integer-based.
  const structure = NUMBER_GRAMMAR_STRUCTURE.exec(lexeme)
  const [, integerPart, fractionPart, , exponentSign = '', exponentDigits] =
    structure as RegExpExecArray

  const exponentValue =
    exponentDigits === undefined
      ? null
      : (exponentSign === '-' ? -1n : 1n) * BigInt(exponentDigits)

  const allDigits = integerPart + (fractionPart ?? '')
  const firstSignificant = indexOfFirstNonZero(allDigits)

  let significandDigits: string
  let significandDecimalExponent: bigint
  let isZero: boolean
  if (firstSignificant === -1) {
    isZero = true
    significandDigits = '0'
    significandDecimalExponent = 0n
  } else {
    isZero = false
    const dotIndex = fractionPart === undefined ? -1 : integerPart.length
    const digitsLength = BigInt(allDigits.length - 1 - firstSignificant)
    const dotOffset = dotIndex === -1 ? digitsLength : BigInt(dotIndex - 1 - firstSignificant)
    const lastSignificant = indexOfLastNonZero(allDigits)
    significandDigits = allDigits.slice(firstSignificant, lastSignificant + 1)
    significandDecimalExponent = (exponentValue ?? 0n) + dotOffset
  }

  return freeze<ValidNumberLexemeAnalysis>({
    lexeme,
    valid: true,
    sign,
    integerPart,
    fractionPart,
    exponentSign: exponentSign as '+' | '-' | '',
    exponentDigits,
    exponentValue,
    isStrictInteger: fractionPart === undefined && exponentDigits === undefined,
    isZero,
    significandDigits,
    significandDecimalExponent
  })
}

function indexOfFirstNonZero(digits: string): number {
  for (let index = 0; index < digits.length; index++) {
    if (digits[index] !== '0') {
      return index
    }
  }
  return -1
}

function indexOfLastNonZero(digits: string): number {
  for (let index = digits.length - 1; index >= 0; index--) {
    if (digits[index] !== '0') {
      return index
    }
  }
  return -1
}

// Structural counterpart of NUMBER_GRAMMAR. Both regexes describe the exact
// same language; NUMBER_GRAMMAR stays the validation source of truth while
// this one only names capture groups for already-validated input.
const NUMBER_GRAMMAR_STRUCTURE =
  /^(-)?(?:0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-])?(\d+))?$/

// 9007199254740991
const MAX_SAFE_INTEGER_PART = 9007199254740991n
// Number.MAX_VALUE = 1.7976931348623157e308 = 17976931348623157 * 10^292
const MAX_VALUE_MANTISSA = 17976931348623157n
const MAX_VALUE_EXPONENT = 292n
const MAX_VALUE_TOP_POSITION = 308n
// Number.MIN_VALUE = 5e-324, the smallest positive value above an underflow
const MIN_VALUE_MANTISSA = 5n
const MIN_VALUE_EXPONENT = -324n
const MIN_VALUE_TOP_POSITION = -324n

/**
 * Describe why a valid lexeme is unsafe to convert to `number`, or return
 * `undefined` when it is safe. The decision is computed from the immutable
 * analysis; `Number.parseFloat` is only consulted once the magnitude is known
 * to lie within the representable range, purely to emulate IEEE-754 rounding.
 */
export function getUnsafeReasonFromAnalysis(
  analysis: NumberLexemeAnalysis
): UnsafeNumberReason | undefined {
  if (!analysis.valid) {
    return undefined
  }

  if (analysis.isZero) {
    return undefined
  }

  if (analysis.isStrictInteger) {
    return isWithinSafeIntegerRange(analysis)
      ? undefined
      : UnsafeNumberReason.truncate_integer
  }

  const magnitude = compareMagnitudeToRange(analysis)
  if (magnitude > 0) {
    return UnsafeNumberReason.overflow
  }
  if (magnitude < 0) {
    return UnsafeNumberReason.underflow
  }

  // In range: the only possible loss is insignificant float digits.
  const num = Number.parseFloat(analysis.lexeme)
  const parsed = String(num)
  if (analysis.lexeme === parsed) {
    return undefined
  }
  if (extractSignificantDigits(analysis.lexeme) === extractSignificantDigits(parsed)) {
    return undefined
  }

  return UnsafeNumberReason.truncate_float
}

/**
 * Map the immutable analysis to the single conversion strategy used by every
 * public conversion path (e.g. `LosslessNumber.valueOf()`).
 */
export function conversionStrategyFromAnalysis(
  analysis: NumberLexemeAnalysis
): NumberConversionStrategy {
  if (!analysis.valid) {
    return 'invalid'
  }

  const reason = getUnsafeReasonFromAnalysis(analysis)
  if (reason === undefined) {
    return 'number'
  }
  if (reason === UnsafeNumberReason.truncate_integer) {
    return 'bigint'
  }
  if (reason === UnsafeNumberReason.truncate_float) {
    return 'truncate_float'
  }
  return reason // 'overflow' or 'underflow'
}

function isWithinSafeIntegerRange(analysis: ValidNumberLexemeAnalysis): boolean {
  const digits = analysis.significandDigits
  if (digits.length > 16) {
    return false
  }
  const magnitude = BigInt(digits)
  return magnitude <= MAX_SAFE_INTEGER_PART
}

/**
 * Compare a positive (non-zero) lexeme magnitude against the finite `number`
 * range. Returns 1 above Number.MAX_VALUE, -1 below Number.MIN_VALUE, 0 in
 * between. Uses digit lengths as cheap guards and BigInt scaling only when
 * the exponents are close, so extreme exponents never allocate huge powers.
 */
function compareMagnitudeToRange(analysis: ValidNumberLexemeAnalysis): 1 | 0 | -1 {
  const mantissa = BigInt(analysis.significandDigits)
  const exponent = analysis.significandDecimalExponent
  const topPosition = exponent + BigInt(analysis.significandDigits.length - 1)

  if (topPosition > MAX_VALUE_TOP_POSITION) {
    return 1
  }
  if (topPosition < MIN_VALUE_TOP_POSITION) {
    return -1
  }
  if (topPosition === MAX_VALUE_TOP_POSITION) {
    return compareScaled(mantissa, exponent, MAX_VALUE_MANTISSA, MAX_VALUE_EXPONENT) > 0 ? 1 : 0
  }
  if (topPosition === MIN_VALUE_TOP_POSITION) {
    return compareScaled(mantissa, exponent, MIN_VALUE_MANTISSA, MIN_VALUE_EXPONENT) < 0 ? -1 : 0
  }

  return 0
}

/**
 * Compare `mantissa * 10^exponent` with `referenceMantissa * 10^referenceExponent`.
 * The caller guarantees the decimal top positions are close, so the exponent
 * delta always fits in a normal integer and scaling stays bounded.
 */
function compareScaled(
  mantissa: bigint,
  exponent: bigint,
  referenceMantissa: bigint,
  referenceExponent: bigint
): 1 | 0 | -1 {
  const delta = exponent - referenceExponent

  if (delta === 0n) {
    return compareBigInt(mantissa, referenceMantissa)
  }
  if (delta > 0n) {
    return compareBigInt(mantissa * 10n ** delta, referenceMantissa)
  }
  return compareBigInt(mantissa, referenceMantissa * 10n ** -delta)
}

function compareBigInt(left: bigint, right: bigint): 1 | 0 | -1 {
  if (left > right) {
    return 1
  }
  if (left < right) {
    return -1
  }
  return 0
}

/**
 * Compare two analyzed number lexemes exactly (no `Number` rounding),
 * returning 1/0/-1. Negative zero compares equal to positive zero.
 */
export function compareAnalyzedNumbers(
  left: NumberLexemeAnalysis,
  right: NumberLexemeAnalysis
): 1 | 0 | -1 {
  if (left.lexeme === right.lexeme) {
    return 0
  }
  if (left.isZero && right.isZero) {
    return 0
  }
  if (left.sign !== right.sign) {
    return left.sign === '-' ? -1 : 1
  }

  const sign: 1 | -1 = left.sign === '-' ? -1 : 1
  if (left.significandDecimalExponent !== right.significandDecimalExponent) {
    return left.significandDecimalExponent > right.significandDecimalExponent ? sign : -sign
  }
  if (left.significandDigits !== right.significandDigits) {
    return left.significandDigits > right.significandDigits ? sign : -sign
  }
  return 0
}

/**
 * Count the significant digits of a number.
 *
 * For example:
 *   '2.34' returns 3
 *   '-77' returns 2
 *   '0.003400' returns 2
 *   '120.5e+30' returns 4
 **/
export function countSignificantDigits(value: string): number {
  const { start, end } = getSignificantDigitRange(value)

  const dot = value.indexOf('.')
  if (dot === -1 || dot < start || dot > end) {
    return end - start
  }

  return end - start - 1
}

/**
 * Get the significant digits of a number.
 *
 * For example:
 *   '2.34' returns '234'
 *   '-77' returns '77'
 *   '0.003400' returns '34'
 *   '120.5e+30' returns '1205'
 **/
export function extractSignificantDigits(value: string): string {
  const { start, end } = getSignificantDigitRange(value)

  const digits = value.substring(start, end)

  const dot = digits.indexOf('.')
  if (dot === -1) {
    return digits
  }

  return digits.substring(0, dot) + digits.substring(dot + 1)
}

/**
 * Returns the range (start to end) of the significant digits of a value.
 * Note that this range _may_ contain the decimal dot.
 *
 * For example:
 *
 *     getSignificantDigitRange('0.0325900') // { start: 3, end: 7 }
 *     getSignificantDigitRange('2.0300')    // { start: 0, end: 3 }
 *     getSignificantDigitRange('0.0')       // { start: 3, end: 3 }
 *
 */
function getSignificantDigitRange(value: string): { start: number; end: number } {
  let start = 0
  if (value[0] === '-') {
    start++
  }
  while (value[start] === '0' || value[start] === '.') {
    start++
  }

  let end = value.lastIndexOf('e')
  if (end === -1) {
    end = value.lastIndexOf('E')
  }
  if (end === -1) {
    end = value.length
  }
  while ((value[end - 1] === '0' || value[end - 1] === '.') && end > start) {
    end--
  }

  return { start, end }
}
