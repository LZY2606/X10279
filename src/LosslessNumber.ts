import {
  analyzeNumberLexeme,
  NumberConversion,
  type NumberLexeme,
  UnsafeNumberReason
} from './numberLexeme.js'
import {
  compareNumber,
  countSignificantDigits,
  getUnsafeNumberReason,
  isInteger,
  isNumber
} from './utils.js'

/**
 * Immutable per-instance lexeme analysis, stored outside the public instance
 * surface. This is the single analysis result that drives every conversion
 * decision of a LosslessNumber; failed constructions never register an entry,
 * so no temporary state can leak from a rejected call.
 */
const lexemes = new WeakMap<LosslessNumber, NumberLexeme>()

/** @internal Shared read access to the production analysis of a value. */
export function getLosslessNumberLexeme(value: LosslessNumber): NumberLexeme | undefined {
  return lexemes.get(value)
}

/**
 * A lossless number. Stores its numeric value as string
 */
export class LosslessNumber {
  // numeric value as string
  value: string

  // type information
  isLosslessNumber = true

  constructor(value: string) {
    if (!isNumber(value)) {
      throw new Error(`Invalid number (value: "${value}")`)
    }

    this.value = value
    lexemes.set(this, analyzeNumberLexeme(value))
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
    const lexeme = lexemes.get(this) ?? analyzeNumberLexeme(this.value)

    // safe or truncate_float
    if (
      lexeme.conversion === NumberConversion.number ||
      lexeme.conversion === NumberConversion.truncate_float
    ) {
      return Number.parseFloat(this.value)
    }

    // truncate_integer
    if (lexeme.conversion === NumberConversion.bigint) {
      return BigInt(this.value)
    }

    // overflow or underflow
    const unsafeReason =
      lexeme.conversion === NumberConversion.overflow
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
 * Test whether a value is a LosslessNumber.
 *
 * Besides the historical structural brand check, this confirms the value is
 * backed by a genuine immutable lexeme analysis: a plain object literal with an
 * `isLosslessNumber: true` flag alone is not a LosslessNumber.
 */
export function isLosslessNumber(value: unknown): value is LosslessNumber {
  // @ts-expect-error structural brand for backwards compatibility
  const hasBrand = (value && typeof value === 'object' && value.isLosslessNumber) || false
  return hasBrand && value instanceof LosslessNumber
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

export { getUnsafeNumberReason, isInteger }
