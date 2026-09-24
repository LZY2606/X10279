import {
  analyzeNumber,
  convertLexeme,
  type NumberLexeme,
  numberLexemeSlot
} from './numberLexeme.js'
import { compareNumber, countSignificantDigits, isNumber } from './utils.js'

/**
 * A lossless number. Stores its numeric value as string
 */
export class LosslessNumber {
  // numeric value as string
  value: string

  // type information
  isLosslessNumber = true

  // Immutable lexical analysis backing every conversion decision.
  // Non-enumerable so it never changes the observable object shape, JSON
  // round trips or default output.
  declare readonly [numberLexemeSlot]: NumberLexeme

  constructor(value: string) {
    if (!isNumber(value)) {
      throw new Error(`Invalid number (value: "${value}")`)
    }

    this.value = value
    Object.defineProperty(this, numberLexemeSlot, {
      value: analyzeNumber(value),
      enumerable: false,
      writable: false,
      configurable: false
    })
  }

  /**
   * Internal factory used by the parser to build a LosslessNumber from the
   * lexeme analysis already produced during tokenization. It shares the exact
   * production path of the public constructor (same validation and the same
   * immutable analysis); it merely skips scanning the same text twice.
   */
  static fromLexeme(lexeme: NumberLexeme): LosslessNumber {
    const number = Object.create(LosslessNumber.prototype) as LosslessNumber
    number.value = lexeme.text
    number.isLosslessNumber = true
    Object.defineProperty(number, numberLexemeSlot, {
      value: lexeme,
      enumerable: false,
      writable: false,
      configurable: false
    })
    return number
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
    return convertLexeme(this[numberLexemeSlot])
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
