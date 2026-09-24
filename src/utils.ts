import type { NumberSplit } from './types'

/**
 * Immutable analysis of a number lexeme.
 *
 * This is the single source of truth for the classification of a number
 * lexeme and the resulting conversion decision. All public entry points
 * that have to classify or convert a number lexeme (parse,
 * parseLosslessNumber, isLosslessNumber, stringify, isSafeNumber,
 * getUnsafeNumberReason, toSafeNumberOrThrow, LosslessNumber) derive their
 * decision from this shared analysis, so they can never disagree.
 *
 * The returned object is frozen: it is a pure function of the lexeme and
 * carries no cache, counter, or other mutable state between calls.
 */
export interface NumberLexemeAnalysis {
  // the analyzed number lexeme, exactly as found in the input
  readonly lexeme: string

  // whether the lexeme is a valid JSON number
  readonly isNumber: boolean

  // whether the lexeme is an integer number (only meaningful when isNumber)
  readonly isInteger: boolean

  // the reason why converting the lexeme to a number is unsafe,
  // or undefined when the conversion is safe (only meaningful when isNumber)
  readonly unsafeReason: UnsafeNumberReason | undefined
}

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

/**
 * Analyze a number lexeme once and return an immutable classification.
 *
 * The analysis is purely lexical: the lexeme itself is never converted via
 * Number before the classification is fixed, so no precision can be lost
 * ahead of the conversion decision.
 */
export function analyzeNumberLexeme(value: string): NumberLexemeAnalysis {
  if (!NUMBER_REGEX.test(value)) {
    return Object.freeze({
      lexeme: value,
      isNumber: false,
      isInteger: false,
      unsafeReason: undefined
    })
  }

  const integer = INTEGER_REGEX.test(value)
  let unsafeReason: UnsafeNumberReason | undefined

  if (integer) {
    unsafeReason = Number.isSafeInteger(Number.parseInt(value, 10))
      ? undefined
      : UnsafeNumberReason.truncate_integer
  } else {
    const num = Number.parseFloat(value)

    if (!Number.isFinite(num)) {
      unsafeReason = UnsafeNumberReason.overflow
    } else if (num === 0) {
      // a zero is only exact when the lexeme has no significant digits,
      // otherwise the value underflows to zero
      unsafeReason =
        extractSignificantDigits(value) === '' ? undefined : UnsafeNumberReason.underflow
    } else {
      const parsed = String(num)
      unsafeReason =
        value === parsed || extractSignificantDigits(value) === extractSignificantDigits(parsed)
          ? undefined
          : UnsafeNumberReason.truncate_float
    }
  }

  return Object.freeze({
    lexeme: value,
    isNumber: true,
    isInteger: integer,
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

  if (!analysis.isNumber) {
    return false
  }

  if (analysis.unsafeReason === undefined) {
    return true
  }

  if (config?.approx === true && analysis.unsafeReason === UnsafeNumberReason.truncate_float) {
    // A value is approximately equal when:
    // 1. it is a floating point number, not an integer
    // 2. it has at least 14 digits
    // 3. the first 14 digits are equal
    const requiredDigits = 14
    const valueDigits = extractSignificantDigits(value)
    const parsedDigits = extractSignificantDigits(String(Number.parseFloat(value)))

    return (
      parsedDigits.length >= requiredDigits &&
      valueDigits.startsWith(parsedDigits.substring(0, requiredDigits))
    )
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
  const analysis = analyzeNumberLexeme(value)

  // for historic reasons, a value that is not a valid number at all is
  // reported as overflow: Number.parseFloat returns NaN, which is not finite
  return analysis.isNumber ? analysis.unsafeReason : UnsafeNumberReason.overflow
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
