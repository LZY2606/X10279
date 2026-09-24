import {
  analyzeNumberLexeme,
  type NumberLexemeAnalysis,
  numberLexemeAnalysisSymbol,
  NumberConversionStrategy,
  isValidNumberLexeme
} from './numberLexeme.js'
import {
  compareNumber,
  countSignificantDigits,
  isNumber,
  UnsafeNumberReason
} from './utils.js'

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

    // The single immutable analysis this number's conversion decisions are
    // based on. Attached via a non-enumerable symbol: it is internal shared
    // production state, not a public property, and leaves no enumerable
    // footprint on successful values.
    const analysis = analyzeNumberLexeme(value)
    Object.defineProperty(this, numberLexemeAnalysisSymbol, {
      value: analysis,
      enumerable: false,
      configurable: false,
      writable: false
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
    const analysis: NumberLexemeAnalysis = (this as Record<symbol, NumberLexemeAnalysis>)[
      numberLexemeAnalysisSymbol
    ]

    switch (analysis.strategy) {
      // safe or truncate_float
      case NumberConversionStrategy.safe_number:
      case NumberConversionStrategy.safe_integer:
      case NumberConversionStrategy.truncate_float:
        return Number.parseFloat(analysis.lexeme)

      // truncate_integer
      case NumberConversionStrategy.bigint:
        return BigInt(analysis.lexeme)

      // overflow or underflow
      case NumberConversionStrategy.overflow:
      case NumberConversionStrategy.underflow:
        throw new Error(
          `Cannot safely convert to number: the value '${this.value}' would ${analysis.strategy} and become ${Number.parseFloat(this.value)}`
        )
    }
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
 * Internal (non-exported in index.ts) read-only accessor for the shared,
 * immutable lexeme analysis attached to a LosslessNumber. It exposes the very
 * same object used by the production valueOf() conversion path; tests use it
 * only to assert invariants, never to drive behavior.
 */
export function getLosslessNumberLexemeAnalysis(
  value: LosslessNumber
): NumberLexemeAnalysis | undefined {
  return (value as unknown as Record<symbol, NumberLexemeAnalysis | undefined>)[
    numberLexemeAnalysisSymbol
  ]
}

export {
  analyzeNumberLexeme,
  isValidNumberLexeme,
  numberLexemeAnalysisSymbol,
  NumberConversionStrategy
}
export type { NumberLexemeAnalysis }

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
