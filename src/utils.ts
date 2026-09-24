import {
  analyzeNumberLexeme,
  isIntegerLexeme,
  isNumberLexeme,
  significantDigitRange,
  significantDigitsOf,
  splitNumberLexeme
} from './numberLexeme.js'
import type { NumberSplit } from './types'

/**
 * Test whether a string contains an integer number
 */
export function isInteger(value: string): boolean {
  return isIntegerLexeme(value)
}

/**
 * Test whether a string contains a number
 * http://stackoverflow.com/questions/13340717/json-numbers-regular-expression
 */
export function isNumber(value: string): boolean {
  return isNumberLexeme(value)
}

/**
 * Test whether a string can be safely represented with a number
 * without information loss.
 *
 * When approx is true, floating point numbers that lose a few digits but
 * are still approximately equal in value are considered safe too.
 * Integer numbers must still be exactly equal.
 */
export function isSafeNumber(
  value: string,
  config?: {
    approx: boolean
  }
): boolean {
  const lexeme = analyzeNumberLexeme(value)
  if (lexeme === undefined) {
    return false
  }

  if (lexeme.isInteger) {
    return Number.isSafeInteger(Number.parseInt(value, 10))
  }

  const num = Number.parseFloat(value)
  const parsed = String(num)

  if (value === parsed) {
    return true
  }

  const parsedDigits = significantDigitsOf(parsed)

  if (lexeme.significantDigits === parsedDigits) {
    return true
  }

  if (config?.approx === true) {
    // A value is approximately equal when:
    // 1. it is a floating point number, not an integer
    // 2. it has at least 14 digits
    // 3. the first 14 digits are equal
    const requiredDigits = 14
    if (
      parsedDigits.length >= requiredDigits &&
      lexeme.significantDigits.startsWith(parsedDigits.substring(0, requiredDigits))
    ) {
      return true
    }
  }

  return false
}

export enum UnsafeNumberReason {
  underflow = 'underflow',
  overflow = 'overflow',
  truncate_integer = 'truncate_integer',
  truncate_float = 'truncate_float'
}

/**
 * When the provided value is an unsafe number, describe what the reason is:
 * overflow, underflow, truncate_integer, or truncate_float.
 * Returns undefined when the value is safe.
 */
export function getUnsafeNumberReason(value: string): UnsafeNumberReason | undefined {
  if (isSafeNumber(value, { approx: false })) {
    return undefined
  }

  if (isInteger(value)) {
    return UnsafeNumberReason.truncate_integer
  }

  const num = Number.parseFloat(value)
  if (!Number.isFinite(num)) {
    return UnsafeNumberReason.overflow
  }

  if (num === 0) {
    return UnsafeNumberReason.underflow
  }

  return UnsafeNumberReason.truncate_float
}

/**
 * Convert a string into a number when it is safe to do so.
 * Throws an error otherwise, explaining the reason.
 */
export function toSafeNumberOrThrow(
  value: string,
  config?: {
    approx: boolean
  }
): number {
  const number = Number.parseFloat(value)

  const unsafeReason = getUnsafeNumberReason(value)
  if (
    config?.approx === true
      ? unsafeReason && unsafeReason !== UnsafeNumberReason.truncate_float
      : unsafeReason
  ) {
    const unsafeReasonText = unsafeReason?.replace(/_\w+$/, '')
    throw new Error(
      `Cannot safely convert to number: the value '${value}' would ${unsafeReasonText} and become ${number}`
    )
  }

  return number
}

/**
 * Split a number into sign, digits, and exponent.
 * Leading zeros and non-canonical zeros are normalized.
 *
 * The value can be constructed again from a split number by inserting a dot
 * at the second character of the digits if there is more than one digit,
 * prepending it with the sign, and appending an "e" and the exponent as follows:
 *
 *     const reconstructed = `${sign}${digits[0]}.${digits.slice(1)}e${exponent}`
 *
 */
export function splitNumber(value: string): NumberSplit {
  const split = splitNumberLexeme(value)
  if (split === undefined) {
    throw new SyntaxError(`Invalid number: ${value}`)
  }

  return split
}

/**
 * Compare two strings containing a numeric value
 * Returns 1 when a is larger than b, 0 when they are equal,
 * and -1 when a is smaller than b.
 */
export function compareNumber(a: string, b: string): 1 | 0 | -1 {
  if (a === b) {
    return 0
  }

  const aa = splitNumber(a)
  const bb = splitNumber(b)

  type Sign = -1 | 1

  const sign: Sign = aa.sign === '-' ? -1 : 1

  if (aa.sign !== bb.sign) {
    return sign
  }

  if (aa.exponent !== bb.exponent) {
    return aa.exponent > bb.exponent ? sign : aa.exponent < bb.exponent ? (-sign as Sign) : 0
  }

  return aa.digits > bb.digits ? sign : aa.digits < bb.digits ? (-sign as Sign) : 0
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
  const { start, end } = significantDigitRange(value)

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
  return significantDigitsOf(value)
}
