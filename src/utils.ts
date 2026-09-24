import {
  analyzeNumberLexeme,
  compareAnalyzedNumbers,
  countSignificantDigits as countSignificantDigitsFromLexeme,
  extractSignificantDigits as extractSignificantDigitsFromLexeme,
  getUnsafeReasonFromAnalysis,
  NUMBER_GRAMMAR,
  UnsafeNumberReason
} from './numberLexeme.js'
import type { NumberSplit } from './types'

// Re-export the shared enum so existing imports keep working.
export { UnsafeNumberReason }

/**
 * Test whether a string contains an integer number.
 *
 * Deliberately the purely structural, lenient test used historically (it
 * accepts leading zeros); strict conversion decisions come from
 * {@link analyzeNumberLexeme} in numberLexeme.ts.
 */
export function isInteger(value: string): boolean {
  return INTEGER_REGEX.test(value)
}

const INTEGER_REGEX = /^-?[0-9]+$/

/**
 * Test whether a string contains a number
 * http://stackoverflow.com/questions/13340717/json-numbers-regular-expression
 */
export function isNumber(value: string): boolean {
  return NUMBER_GRAMMAR.test(value)
}

/**
 * Test whether a string can be safely represented with a number
 * without information loss.
 *
 * When approx is true, floating point numbers that lose a few digits but
 * are still approximately equal in value are considered safe too.
 * Integer numbers must still be exactly equal.
 *
 * For valid JSON number lexemes the decision comes from the shared immutable
 * {@link analyzeNumberLexeme} result. Invalid input keeps the historical,
 * lenient `Number`-based fallback so the public contract does not change.
 */
export function isSafeNumber(
  value: string,
  config?: {
    approx: boolean
  }
): boolean {
  const analysis = analyzeNumberLexeme(value)

  if (!analysis.valid) {
    return isSafeNumberLegacy(value, config)
  }

  if (analysis.isStrictInteger) {
    return getUnsafeReasonFromAnalysis(analysis) === undefined
  }

  const reason = getUnsafeReasonFromAnalysis(analysis)
  if (reason === undefined) {
    return true
  }

  if (config?.approx === true && reason === UnsafeNumberReason.truncate_float) {
    // A value is approximately equal when:
    // 1. it is a floating point number, not an integer
    // 2. it has at least 14 digits
    // 3. the first 14 digits are equal
    const requiredDigits = 14
    const parsed = String(Number.parseFloat(value))
    const valueDigits = extractSignificantDigits(value)
    const parsedDigits = extractSignificantDigits(parsed)
    if (
      parsedDigits.length >= requiredDigits &&
      valueDigits.startsWith(parsedDigits.substring(0, requiredDigits))
    ) {
      return true
    }
  }

  return false
}

function isSafeNumberLegacy(
  value: string,
  config?: {
    approx: boolean
  }
): boolean {
  if (isInteger(value)) {
    return Number.isSafeInteger(Number.parseInt(value, 10))
  }

  const num = Number.parseFloat(value)
  const parsed = String(num)

  if (value === parsed) {
    return true
  }

  const valueDigits = extractSignificantDigits(value)
  const parsedDigits = extractSignificantDigits(parsed)

  if (valueDigits === parsedDigits) {
    return true
  }

  if (config?.approx === true) {
    const requiredDigits = 14
    if (
      !isInteger(value) &&
      parsedDigits.length >= requiredDigits &&
      valueDigits.startsWith(parsedDigits.substring(0, requiredDigits))
    ) {
      return true
    }
  }

  return false
}

/**
 * When the provided value is an unsafe number, describe what the reason is:
 * overflow, underflow, truncate_integer, or truncate_float.
 * Returns undefined when the value is safe.
 */
export function getUnsafeNumberReason(value: string): UnsafeNumberReason | undefined {
  const analysis = analyzeNumberLexeme(value)
  if (analysis.valid) {
    return getUnsafeReasonFromAnalysis(analysis)
  }

  // Legacy fallback for non-lexeme input, unchanged.
  if (isSafeNumberLegacy(value, { approx: false })) {
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
  const match = value.match(/^(-?)(\d+\.?\d*)([eE]([+-]?\d+))?$/)
  if (!match) {
    throw new SyntaxError(`Invalid number: ${value}`)
  }

  const sign = match[1] as '-' | ''
  const digitsStr = match[2]
  let exponent = match[4] !== undefined ? Number.parseInt(match[4], 10) : 0

  const dot = digitsStr.indexOf('.')
  exponent += dot !== -1 ? dot - 1 : digitsStr.length - 1

  const digits = digitsStr
    .replace('.', '') // remove the dot (must be removed before removing leading zeros)
    .replace(/^0*/, (zeros: string) => {
      // remove leading zeros, add their count to the exponent
      exponent -= zeros.length
      return ''
    })
    .replace(/0*$/, '') // remove trailing zeros

  // normalize zero, for example normalizes 0e5 or -0 into 0
  return digits.length > 0 ? { sign, digits, exponent } : { sign: '', digits: '0', exponent: 0 }
}

/**
 * Compare two strings containing a numeric value
 * Returns 1 when a is larger than b, 0 when they are equal,
 * and -1 when a is smaller than b.
 *
 * Valid JSON number lexemes are compared directly from the immutable
 * {@link analyzeNumberLexeme} result (exact, no `Number` rounding, safe for
 * extreme exponents). Lenient forms that are not strict JSON lexemes (such as
 * '02.3') fall back to the historical split-based comparison unchanged.
 */
export function compareNumber(a: string, b: string): 1 | 0 | -1 {
  if (a === b) {
    return 0
  }

  const left = analyzeNumberLexeme(a)
  const right = analyzeNumberLexeme(b)
  if (left.valid && right.valid) {
    return compareAnalyzedNumbers(left, right)
  }

  return compareNumberLegacy(a, b)
}

function compareNumberLegacy(a: string, b: string): 1 | 0 | -1 {
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

export function countSignificantDigits(value: string): number {
  return countSignificantDigitsFromLexeme(value)
}

export function extractSignificantDigits(value: string): string {
  return extractSignificantDigitsFromLexeme(value)
}
