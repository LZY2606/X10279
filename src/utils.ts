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

  if (config?.approx === true) {
    // A value is approximately equal when:
    // 1. it is a floating point number, not an integer
    // 2. it has at least 14 digits
    // 3. the first 14 digits are equal
    const requiredDigits = 14
    const parsedDigits = extractSignificantDigits(String(Number.parseFloat(value)))
    const valueDigits = extractSignificantDigits(value)
    if (
      !analysis.isInteger &&
      parsedDigits.length >= requiredDigits &&
      valueDigits.startsWith(parsedDigits.substring(0, requiredDigits))
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
 * The conversion strategy decided for a number lexeme:
 *
 * - `'number'`: the lexeme can be converted to a regular number, either exactly
 *   or (for `truncate_float`) losing only insignificant digits
 * - `'bigint'`: the lexeme is an integer that does not fit safely in a number
 *   and must be converted to a bigint to stay lossless
 * - `'never'`: the lexeme cannot be converted without unacceptable loss
 *   (overflow/underflow), or is not a valid number lexeme at all
 */
export type NumberConversion = 'number' | 'bigint' | 'never'

/**
 * An immutable analysis of a number lexeme. This is the single source from
 * which the classification (`isNumber`, `isInteger`, `isNegativeZero`) and the
 * conversion decision (`unsafeReason`, `conversion`) of a numeric lexeme are
 * derived. The decision is made from the lexeme string itself: it is never
 * routed through a lossy `Number` round-trip first.
 *
 * The analysis is pure and stateless: it keeps no cache, counter, or temporary
 * state between calls, so a failed conversion cannot influence later results.
 *
 * Note: this is an internal building block shared by the production code paths
 * (`LosslessNumber.valueOf`, `isSafeNumber`, `getUnsafeNumberReason`,
 * `toSafeNumberOrThrow`, `splitNumber`). It is deliberately not exported from
 * the package entry point.
 */
export interface NumberLexemeAnalysis {
  // the analyzed lexeme, exactly as provided
  readonly lexeme: string
  // whether the lexeme is a valid JSON number
  readonly isNumber: boolean
  // whether the lexeme is an integer number (no dot, no exponent)
  readonly isInteger: boolean
  // whether the lexeme is a negative zero like '-0', '-0.0', or '-0e3'
  readonly isNegativeZero: boolean
  // the lexeme split into sign, digits, and exponent (undefined when not splittable)
  readonly split: Readonly<NumberSplit> | undefined
  // why the lexeme is unsafe to convert to a number, undefined when safe
  readonly unsafeReason: UnsafeNumberReason | undefined
  // the conversion strategy decided for the lexeme
  readonly conversion: NumberConversion
}

/**
 * Analyze a number lexeme once, and return an immutable result describing the
 * classification of the lexeme and the decided conversion strategy.
 */
export function analyzeNumberLexeme(value: string): NumberLexemeAnalysis {
  const number = isNumber(value)
  const integer = isInteger(value)
  const split = splitNumberOrUndefined(value)
  const unsafeReason = computeUnsafeNumberReason(value, integer)

  const conversion: NumberConversion = !number
    ? 'never'
    : unsafeReason === undefined || unsafeReason === UnsafeNumberReason.truncate_float
      ? 'number'
      : integer
        ? 'bigint'
        : 'never'

  return Object.freeze({
    lexeme: value,
    isNumber: number,
    isInteger: integer,
    isNegativeZero: split !== undefined && value.charAt(0) === '-' && split.digits === '0',
    split,
    unsafeReason,
    conversion
  })
}

/**
 * Strict safety check (approx = false), shared by analyzeNumberLexeme
 */
function isSafeNumberStrict(value: string, integer: boolean): boolean {
  if (integer) {
    return Number.isSafeInteger(Number.parseInt(value, 10))
  }

  const num = Number.parseFloat(value)
  const parsed = String(num)

  if (value === parsed) {
    return true
  }

  return extractSignificantDigits(value) === extractSignificantDigits(parsed)
}

/**
 * Compute the reason why a lexeme is unsafe to convert to a number,
 * shared by analyzeNumberLexeme
 */
function computeUnsafeNumberReason(
  value: string,
  integer: boolean
): UnsafeNumberReason | undefined {
  if (isSafeNumberStrict(value, integer)) {
    return undefined
  }

  if (integer) {
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
  const number = Number.parseFloat(value)

  const unsafeReason = analyzeNumberLexeme(value).unsafeReason
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
  const split = splitNumberOrUndefined(value)
  if (split === undefined) {
    throw new SyntaxError(`Invalid number: ${value}`)
  }

  return split
}

/**
 * Split a number into sign, digits, and exponent, or return undefined
 * when the value cannot be split. Shared by analyzeNumberLexeme.
 */
function splitNumberOrUndefined(value: string): NumberSplit | undefined {
  const match = value.match(/^(-?)(\d+\.?\d*)([eE]([+-]?\d+))?$/)
  if (!match) {
    return undefined
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
  const split: NumberSplit =
    digits.length > 0 ? { sign, digits, exponent } : { sign: '', digits: '0', exponent: 0 }

  return Object.freeze(split)
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
