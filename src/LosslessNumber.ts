import { analyzeNumberLexeme, LEXEME_BRAND, type NumberLexeme } from './numberLexeme.js'
import { compareNumber, countSignificantDigits } from './utils.js'

/**
 * A lossless number. Stores its numeric value as string.
 *
 * The conversion decision of `valueOf()` is derived from the immutable
 * {@link NumberLexeme} analysis produced at construction time. That analysis
 * is the exact same one used by `parse`, `parseLosslessNumber` and
 * `stringify`, so every entry point agrees on classification and strategy.
 */
export class LosslessNumber {
  // numeric value as string
  value: string

  // type information
  isLosslessNumber = true

  // Immutable lexical analysis backing the conversion decision.
  // Non-enumerable so it neither changes the public shape nor serializes.
  declare readonly [LEXEME_BRAND]: NumberLexeme

  constructor(value: string) {
    let lexeme: NumberLexeme
    try {
      lexeme = analyzeNumberLexeme(value)
    } catch {
      // Preserve the historical plain Error layer and message for callers.
      throw new Error(`Invalid number (value: "${value}")`)
    }

    this.value = value
    Object.defineProperty(this, LEXEME_BRAND, {
      value: lexeme,
      enumerable: false,
      writable: false,
      configurable: false
    })
  }

  /**
   * Get the value of the LosslessNumber as number or bigint.
   *
   * - a number is returned for safe numbers and decimal values that only lose some insignificant digits
   * - a bigint is returned for big integer number tokens
   * - an Error is thrown for values that will overflow or underflow
   *
   * Note that you can implement your own strategy for conversion by just getting the value as string
   * via .toString(), and using util functions like isInteger, isSafeNumber, getUnsafeNumberReason,
   * and toSafeNumberOrThrow to convert it to a numeric value.
   */
  valueOf(): number | bigint {
    const lexeme = this[LEXEME_BRAND]

    // safe or truncate_float
    if (lexeme.strategy === 'safe_number' || lexeme.strategy === 'truncate_float') {
      return Number.parseFloat(this.value)
    }

    // truncate_integer
    if (lexeme.strategy === 'bigint') {
      return BigInt(this.value)
    }

    // overflow or underflow
    throw new Error(
      `Cannot safely convert to number: the value '${this.value}' would ${lexeme.unsafeReason} and become ${Number.parseFloat(this.value)}`
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
  // stringified JSON since it has to parse the number into a number first.
}

/**
 * Test whether a value is a LosslessNumber.
 *
 * Prefers the internal immutable-lexeme brand (proving the value went through
 * the unified analysis) and falls back to the historical duck-type brand for
 * values produced by older/duplicated module copies.
 */
export function isLosslessNumber(value: unknown): value is LosslessNumber {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const branded = value as Record<PropertyKey, unknown>

  return LEXEME_BRAND in branded || branded.isLosslessNumber === true
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
