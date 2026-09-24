import {
  analyzeNumberLexeme,
  compareAnalyzedNumbers,
  conversionStrategyFromAnalysis,
  countSignificantDigits,
  type NumberLexemeAnalysis
} from './numberLexeme.js'

/**
 * A lossless number. Stores its numeric value as string.
 *
 * The conversion strategy for the stored token is decided once, at
 * construction time, by the shared {@link analyzeNumberLexeme} result. The
 * analysis is immutable and is the exact same piece of logic used by
 * `parse`, `parseLosslessNumber`, `isLosslessNumber` and `stringify`.
 */
export class LosslessNumber {
  // numeric value as string
  value: string

  // type information
  isLosslessNumber = true

  // Shared, immutable lexeme analysis backing every conversion decision.
  // Held in a private field: it is observable only through the library-level
  // helper `getNumberLexemeAnalysis`, never as enumerable object state.
  readonly #analysis: NumberLexemeAnalysis

  constructor(value: string) {
    const analysis = analyzeNumberLexeme(value)
    if (!analysis.valid) {
      throw new Error(`Invalid number (value: "${value}")`)
    }

    this.value = value
    this.#analysis = analysis
  }

  /**
   * Internal-only accessor used by the library itself (comparison) and by
   * the behavior-guard tests to assert on JSON number lexeme / conversion
   * strategy invariants. It does not expose an alternative construction path:
   * it returns the same frozen analysis produced on the production path.
   * @internal
   */
  get analysis(): NumberLexemeAnalysis {
    return this.#analysis
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
    const strategy = conversionStrategyFromAnalysis(this.#analysis)

    // safe or truncate_float
    if (strategy === 'number' || strategy === 'truncate_float') {
      return Number.parseFloat(this.value)
    }

    // truncate_integer
    if (strategy === 'bigint') {
      return BigInt(this.value)
    }

    // overflow or underflow
    throw new Error(
      `Cannot safely convert to number: the value '${this.value}' would ${strategy} and become ${Number.parseFloat(this.value)}`
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
 * This is the single brand check shared by the parser, reviver and stringifier
 * so that every entry point classifies lossless numbers identically.
 */
export function isLosslessNumber(value: unknown): value is LosslessNumber {
  return (value && typeof value === 'object' && value.isLosslessNumber === true) || false
}

/**
 * Internal-only: return the immutable lexeme analysis attached to a
 * LosslessNumber created through the public API, or undefined for other
 * values. The returned object is frozen and shared with the production
 * conversion path (no test-only recomputation).
 * @internal
 */
export function getNumberLexemeAnalysis(value: unknown): NumberLexemeAnalysis | undefined {
  if (isLosslessNumber(value)) {
    return value.analysis
  }
  return undefined
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
  return compareAnalyzedNumbers(a.analysis, b.analysis)
}
