import { compareNumber, countSignificantDigits } from './utils.js'
import { analyzeNumberLexeme, decideNumberConversion } from './numberLexeme.js'

/**
 * Per-instance immutable lexical analysis. The map is module-private and only
 * caches the frozen analysis of already-constructed numbers: it never carries
 * temporary state from failed calls (invalid values throw before an entry is
 * created) and it does not influence the result of any other entry point.
 */
const analysisByNumber = new WeakMap<LosslessNumber, Readonly<
  ReturnType<typeof analyzeNumberLexeme>
>>()

/**
 * Return (for internal callers in this package) the single immutable analysis
 * on which every conversion decision of a LosslessNumber is based.
 */
export function getNumberLexemeAnalysis(
  number: LosslessNumber
): Readonly<ReturnType<typeof analyzeNumberLexeme>> {
  return analysisByNumber.get(number) as ReturnType<typeof analyzeNumberLexeme>
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
    const analysis = analyzeNumberLexeme(value)
    if (!analysis.valid) {
      throw new Error(`Invalid number (value: "${value}")`)
    }

    this.value = value
    analysisByNumber.set(this, analysis)
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
    const analysis = getNumberLexemeAnalysis(this)
    const decision = decideNumberConversion(analysis, false)

    switch (decision.kind) {
      case 'number':
        return decision.value
      case 'bigint':
        return decision.value
      case 'error':
        throw new Error(
          `Cannot safely convert to number: the value '${this.value}' would ${decision.reason} and become ${decision.value}`
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
