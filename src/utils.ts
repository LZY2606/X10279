import {
  extractSignificantDigits,
  isApproximatelySafeFloatLexeme,
  isIntegerDigits,
  isValidNumberLexeme,
  tryAnalyzeNumberLexeme,
  UnsafeNumberReason
} from './numberLexeme.js'
import type { NumberSplit } from './types.js'

export {
  UnsafeNumberReason,
  countSignificantDigits,
  extractSignificantDigits
} from './numberLexeme.js'

const INTEGER_REGEX = /^-?[0-9]+$/

/**
 * Test whether a string contains an integer number
 */
export function isInteger(value: string): boolean {
  return isIntegerDigits(value)
}

/**
 * Test whether a string contains a number
 * http://stackoverflow.com/questions/13340717/json-numbers-regular-expression
 */
export function isNumber(value: string): boolean {
  return isValidNumberLexeme(value)
}

/**
 * Test whether a string can be safely represented with a number
 * without information loss.
 *
 * When approx is true, floating point numbers that lose a few digits but
 * are still approximately equal in value are considered safe too.
 * Integer numbers must still be exactly equal.
 *
 * For a valid JSON number lexeme the decision comes from the same immutable
 * lexeme analysis used by parse/valueOf/stringify. Free-form numeric text
 * that is not a strict lexeme keeps the historical lenient behavior.
 */
export function isSafeNumber(
  value: string,
  config?: {
    approx: boolean
  }
): boolean {
  const lexeme = tryAnalyzeNumberLexeme(value)

  if (lexeme !== undefined) {
    if (lexeme.isIntegerLexeme) {
      return lexeme.strategy === 'safe_number'
    }

    if (lexeme.strategy === 'safe_number') {
      return true
    }

    return config?.approx === true ? isApproximatelySafeFloatLexeme(lexeme) : false
  }

  return isSafeNumberFallback(value, config)
}

/**
 * Historical lenient behavior for text that is not a strict JSON number
 * lexeme (for example leading zeros or a leading dot). Composed from the
 * same shared text primitives; the strict lexeme path does not use it.
 */
function isSafeNumberFallback(
  value: string,
  config?: {
    approx: boolean
  }
): boolean {
  if (INTEGER_REGEX.test(value)) {
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
      !INTEGER_REGEX.test(value) &&
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
 *
 * Valid JSON number lexemes get their reason from the shared immutable lexeme
 * analysis; other numeric text keeps the historical derived behavior.
 */
export function getUnsafeNumberReason(value: string): UnsafeNumberReason | undefined {
  const lexeme = tryAnalyzeNumberLexeme(value)
  if (lexeme !== undefined) {
    return lexeme.unsafeReason
  }

  if (isSafeNumberFallback(value)) {
    return undefined
  }

  if (INTEGER_REGEX.test(value)) {
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
