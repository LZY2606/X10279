import {
  compareNumber,
  countSignificantDigits,
  getUnsafeNumberReason
} from './utils.js'
import {
  analyzeNumberLexeme,
  NumberConversion,
  type NumberLexemeAnalysis
} from './numberLexeme.js'

/**
 * A lossless number. Stores its numeric value as string
 */
export class LosslessNumber {
  // numeric value as string
  value: string

  // type information
  isLosslessNumber = true

  // Immutable lexical classification shared with parse/stringify. Held on the
  // instance (never on module state) so retries are isolated and idempotent.
  private readonly lexemeAnalysis: NumberLexemeAnalysis

  constructor(value: string) {
    const analysis = analyzeNumberLexeme(value)
    if (!analysis.valid) {
      throw new Error(`Invalid number (value: "${value}")`)
    }

    this.value = value
    this.lexemeAnalysis = analysis
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
    // safe integer, safe float or truncate_float become a Number
    if (
      this.lexemeAnalysis.conversion === NumberConversion.number ||
      this.lexemeAnalysis.kind === 'truncate_float'
    ) {
      return Number.parseFloat(this.value)
    }

    // truncate_integer
    if (this.lexemeAnalysis.conversion === NumberConversion.bigint) {
      return BigInt(this.value)
    }

    // overflow or underflow
    const unsafeReason = getUnsafeNumberReason(this.value)
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
 * Get the immutable lexical analysis of a LosslessNumber.
 *
 * INTERNAL: this is intentionally not exported from the package index. It is
 * shared by tests and production code alike — it exposes the exact same
 * frozen analysis instance that drives `valueOf()`, never a test-only copy of
 * the algorithm.
 */
export function getLosslessNumberAnalysis(value: LosslessNumber): NumberLexemeAnalysis {
  return (value as unknown as { lexemeAnalysis: NumberLexemeAnalysis }).lexemeAnalysis
}

/**
 * Test whether a value is a LosslessNumber
 */
export function isLosslessNumber(value: unknown): value is LosslessNumber {
  // @ts-expect-error
  return (value && typeof value === 'object' && value.isLosslessNumber) || false
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
