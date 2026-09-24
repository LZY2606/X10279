import type { NumberSplit } from './types'

/**
 * Test whether a string contains an integer number
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
  return NUMBER_REGEX.test(value)
}

const NUMBER_REGEX = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

export enum UnsafeNumberReason {
  underflow = 'underflow',
  overflow = 'overflow',
  truncate_integer = 'truncate_integer',
  truncate_float = 'truncate_float'
}

/**
 * The immutable result of analyzing a number lexeme: the single source of
 * truth for classifying a numeric string and deciding how to convert it.
 *
 * This is an internal building block, shared by the production code paths of
 * `parse` (via `parseLosslessNumber` and the `LosslessNumber` constructor),
 * `LosslessNumber.valueOf`, `toLosslessNumber`, `parseNumberAndBigInt`,
 * `isSafeNumber`, `getUnsafeNumberReason`, `toSafeNumberOrThrow`, and the
 * number validation in `stringify`. It is deliberately not re-exported from
 * the public API in `index.ts`: only the existing derived public functions
 * are part of the API.
 *
 * The analysis itself is purely string based: the lexeme is never
 * round-tripped through `Number`, so no precision is lost. The floating
 * point approximation `floatValue` is only used to classify safety,
 * never to represent the value itself.
 */
export interface NumberLexemeAnalysis {
  /** the original lexeme, exactly as provided */
  readonly value: string
  /** whether the lexeme matches the JSON number grammar */
  readonly isNumber: boolean
  /** whether the lexeme is an integer (no decimal mark, no exponent) */
  readonly isInteger: boolean
  /** the significant digits of the lexeme */
  readonly significantDigits: string
  /** the number of significant digits of the lexeme */
  readonly significantDigitCount: number
  /** the floating point approximation of the lexeme, used for safety classification only */
  readonly floatValue: number
  /** the significant digits of the floating point approximation */
  readonly floatSignificantDigits: string
  /** the reason why the lexeme is unsafe as a number, or undefined when safe */
  readonly unsafeReason: UnsafeNumberReason | undefined
}

/**
 * Analyze a number lexeme once, and return an immutable analysis result
 * from which all classification and conversion decisions are derived.
 */
export function analyzeNumberLexeme(value: string): NumberLexemeAnalysis {
  const isNumberLexeme = NUMBER_REGEX.test(value)
  const integer = INTEGER_REGEX.test(value)
  const significantDigits = extractSignificantDigits(value)
  const significantDigitCount = countSignificantDigits(value)
  const floatValue = Number.parseFloat(value)
  const floatSignificantDigits = extractSignificantDigits(String(floatValue))

  let safe: boolean
  if (integer) {
    safe = Number.isSafeInteger(Number.parseInt(value, 10))
  } else {
    const parsed = String(floatValue)
    safe = value === parsed || significantDigits === floatSignificantDigits
  }

  let unsafeReason: UnsafeNumberReason | undefined
  if (!safe) {
    if (integer) {
      unsafeReason = UnsafeNumberReason.truncate_integer
    } else if (!Number.isFinite(floatValue)) {
      unsafeReason = UnsafeNumberReason.overflow
    } else if (floatValue === 0) {
      unsafeReason = UnsafeNumberReason.underflow
    } else {
      unsafeReason = UnsafeNumberReason.truncate_float
    }
  }

  return Object.freeze({
    value,
    isNumber: isNumberLexeme,
    isInteger: integer,
    significantDigits,
    significantDigitCount,
    floatValue,
    floatSignificantDigits,
    unsafeReason
  })
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
  const analysis = analyzeNumberLexeme(value)

  if (analysis.unsafeReason === undefined) {
    return true
  }

  if (config?.approx === true && analysis.unsafeReason === UnsafeNumberReason.truncate_float) {
    // A value is approximately equal when:
    // 1. it is a floating point number, not an integer
    // 2. it has at least 14 digits
    // 3. the first 14 digits are equal
    const requiredDigits = 14
    return (
      analysis.floatSignificantDigits.length >= requiredDigits &&
      analysis.significantDigits.startsWith(
        analysis.floatSignificantDigits.substring(0, requiredDigits)
      )
    )
  }

  return false
}

/**
 * When the provided value is an unsafe number, describe what the reason is:
 * overflow, underflow, truncate_integer, or truncate_float.
 * Returns undefined when the value is safe.
 */
export function getUnsafeNumberReason(value: string): UnsafeNumberReason | undefined {
  return analyzeNumberLexeme(value).unsafeReason
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
  const analysis = analyzeNumberLexeme(value)
  const unsafeReason = analysis.unsafeReason

  if (
    config?.approx === true
      ? unsafeReason && unsafeReason !== UnsafeNumberReason.truncate_float
      : unsafeReason
  ) {
    const unsafeReasonText = unsafeReason?.replace(/_\w+$/, '')
    throw new Error(
      `Cannot safely convert to number: the value '${value}' would ${unsafeReasonText} and become ${analysis.floatValue}`
    )
  }

  return analysis.floatValue
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
  const { start, end } = getSignificantDigitRange(value)

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
  const { start, end } = getSignificantDigitRange(value)

  const digits = value.substring(start, end)

  const dot = digits.indexOf('.')
  if (dot === -1) {
    return digits
  }

  return digits.substring(0, dot) + digits.substring(dot + 1)
}

/**
 * Returns the range (start to end) of the significant digits of a value.
 * Note that this range _may_ contain the decimal dot.
 *
 * For example:
 *
 *     getSignificantDigitRange('0.0325900') // { start: 3, end: 7 }
 *     getSignificantDigitRange('2.0300')    // { start: 0, end: 3 }
 *     getSignificantDigitRange('0.0')       // { start: 3, end: 3 }
 *
 */
function getSignificantDigitRange(value: string): { start: number; end: number } {
  let start = 0
  if (value[0] === '-') {
    start++
  }
  while (value[start] === '0' || value[start] === '.') {
    start++
  }

  let end = value.lastIndexOf('e')
  if (end === -1) {
    end = value.lastIndexOf('E')
  }
  if (end === -1) {
    end = value.length
  }
  while ((value[end - 1] === '0' || value[end - 1] === '.') && end > start) {
    end--
  }

  return { start, end }
}
