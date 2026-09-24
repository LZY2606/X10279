import {
  analyzeNumberLexeme,
  decideNumberConversion,
  getNumberLexeme,
  type NumberLexeme,
  NUMBER_LEXEME,
  UnsafeNumberReason
} from './numberLexeme.js'
import { compareNumber } from './utils.js'

/**
 * A lossless number. Stores its numeric value as string
 */
export class LosslessNumber {
  // numeric value as string
  value: string

  // type information
  isLosslessNumber = true

  constructor(value: string) {
    // Single immutable analysis shared by parseLosslessNumber, valueOf and
    // stringify. Validation never passes the value through Number, so invalid
    // lexemes are rejected without precision loss.
    try {
      const lexeme = analyzeNumberLexeme(value)
      Object.defineProperty(this, NUMBER_LEXEME, {
        value: lexeme,
        enumerable: false,
        configurable: false,
        writable: false
      })
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid number (value: "${value}")`)
      }
      throw error
    }

    this.value = value
  }

  /**
   * Internal, immutable lexical analysis backing this number. Not part of the
   * public API; it exposes the exact analysis object shared with parse and
   * stringify so conversion decisions cannot diverge.
   */
  get lexeme(): NumberLexeme {
    return (this as unknown as Record<symbol, NumberLexeme>)[NUMBER_LEXEME]
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
    // The decision comes from the same immutable analysis used by parse and
    // stringify; this method never re-classifies the lexeme independently.
    const { strategy, unsafeReason } = decideNumberConversion(getNumberLexeme(this))

    // safe or truncate_float
    if (
      strategy === 'safe_number' ||
      unsafeReason === UnsafeNumberReason.truncate_float
    ) {
      return Number.parseFloat(this.value)
    }

    // truncate_integer
    if (strategy === 'bigint') {
      return BigInt(this.value)
    }

    // overflow or underflow
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
  // Primary classification is the immutable lexeme analysis, which is what
  // parseLosslessNumber attaches. The legacy duck-type marker stays as a
  // fallback so external subclasses/brand copies keep being recognized.
  if (value && typeof value === 'object') {
    const holder = value as Record<symbol, unknown>
    if (NUMBER_LEXEME in holder && holder[NUMBER_LEXEME] !== undefined) {
      return true
    }
  }
  // @ts-expect-error legacy brand, kept for backward compatibility
  return (value && typeof value === 'object' && value.isLosslessNumber) || false
}

/**
 * Convert a number into a LosslessNumber if this is possible in a safe way
 * If the value has too many digits, or is NaN or Infinity, an error will be thrown
 */
export function toLosslessNumber(value: number): LosslessNumber {
  if (Number.isNaN(value)) {
    throw new Error('Invalid number: NaN')
  }

  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number: ${value}`)
  }

  const maxDigits = 15
  if (analyzeNumberLexeme(String(value)).significantDigitCount > maxDigits) {
    throw new Error(
      `Invalid number: contains more than 15 digits and is most likely truncated and unsafe by itself (value: ${value})`
    )
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
