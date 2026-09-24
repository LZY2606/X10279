import {
  compareNumber,
  countSignificantDigits,
  getUnsafeNumberReason,
  UnsafeNumberReason
} from './utils.js'
import {
  analyzeNumberLexeme,
  classifyFiniteDecimal,
  NumberConversionStrategy,
  type NumberLexemeAnalysis
} from './numberLexeme.js'

/**
 * Internal symbol holding the immutable lexeme analysis of a LosslessNumber.
 * It is deliberately not part of the public API: it is the shared internal
 * representation produced by the same analysis used by the public entry points.
 */
export const numberLexemeAnalysis: unique symbol = Symbol('numberLexemeAnalysis')

/**
 * A lossless number. Stores its numeric value as string
 */
export class LosslessNumber {
  // numeric value as string
  value: string

  // type information
  isLosslessNumber = true

  // immutable, shared classification of the lexeme backing this number
  readonly [numberLexemeAnalysis]!: NumberLexemeAnalysis

  constructor(value: string) {
    const analysis = analyzeNumberLexeme(value)
    if (analysis === undefined) {
      throw new Error(`Invalid number (value: "${value}")`)
    }

    this.value = value
    Object.defineProperty(this, numberLexemeAnalysis, {
      value: analysis,
      enumerable: false,
      writable: false,
      configurable: false
    })
  }

  /**
   * Get the value of the LosslessNumber as number or bigint.
   *
   * - a number is returned for safe numbers and decimal values that only lose some insignificant digits
   * - a bigint is returned for big integer numbers
   * - an Error is thrown for values that will overflow or underflow
   *
   * Note that you can implement your own strategy for conversion by just getting the value as string
   * via .toString(), and using util functions like isInteger, isSafeNumber, getUnsafeNumberReason,
   * and toSafeNumberOrThrow to convert it to a numeric value.
   */
  valueOf(): number | bigint {
    const strategy = classifyFiniteDecimal(this[numberLexemeAnalysis], Number.parseFloat)

    if (
      strategy === NumberConversionStrategy.safe_number ||
      strategy === NumberConversionStrategy.lossless
    ) {
      // safe numbers, and decimals losing only insignificant digits, become a
      // floating point number
      return Number.parseFloat(this.value)
    }

    if (strategy === NumberConversionStrategy.bigint) {
      return BigInt(this.value)
    }

    // overflow or underflow
    const unsafeReason =
      strategy === NumberConversionStrategy.overflow
        ? UnsafeNumberReason.overflow
        : UnsafeNumberReason.underflow
    throw new Error(
      `Cannot safely convert to number: the value '${this.value}' would ${unsafeReason} and become ${Number.parseFloat(this.value)}`
    )
  }

  /**
   * Get the value of the LosslessNumber as string.
   */
  toString(): string {
    return this.value
  }

  // Note: we do NOT implement a .toJSON() method, and you should not implement
  // or use that, it cannot safely turn the numeric value in the string into
  // stringified JSON since it has to be parsed into a number first.
}

/**
 * Test whether a value is a LosslessNumber
 */
export function isLosslessNumber(value: unknown): value is LosslessNumber {
  const candidate = value as
    | ({ isLosslessNumber?: unknown; value?: unknown } & Record<symbol, unknown>)
    | null

  if (candidate === null || typeof candidate !== 'object' || !candidate.isLosslessNumber) {
    return false
  }

  // Prefer the immutable analysis attached by the LosslessNumber constructor.
  const analysis = candidate[numberLexemeAnalysis] as NumberLexemeAnalysis | undefined
  if (analysis !== undefined) {
    return typeof candidate.value === 'string' && analysis.lexeme === candidate.value
  }

  // Backward-compatible path for an object carrying only the legacy brand:
  // still verify through the same lexeme analysis instead of trusting the brand.
  return typeof candidate.value === 'string' && analyzeNumberLexeme(candidate.value) !== undefined
}

/**
 * Convert a number into a LosslessNumber if this is possible in a safe way
 * If the value has too many digits, or is NaN or Infinity, an error will be thrown
 */
export function toLosslessNumber(value: number): LosslessNumber {
  const maxDigits = 15
  if (countSignificantDigits(String(value)) > maxDigits) {
    throw new Error(
      `Invalid number: contains more than 15 digits and is most likely truncated and unsafe by itself (value: ${value})`
    )
  }

  if (Number.isNaN(value)) {
    throw new Error('Invalid number: NaN')
  }

  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number: ${value}`)
  }

  return new LosslessNumber(String(value))
}

/**
 * Compare two lossless numbers.
 * Returns 1 when a is larger than b, 0 when they are equal,
 * and -1 when a is smaller than b.
 */
export function compareLosslessNumber(a: LosslessNumber, b: LosslessNumber): 1 | 0 | -1 {
  return compareNumber(a.value, b.value)
}
