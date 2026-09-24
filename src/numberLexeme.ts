import type { NumberSplit } from './types.js'

/**
 * Internal, shared lexical analysis of JSON number lexemes.
 *
 * This module is the single source of truth for classifying a number lexeme
 * (a string containing a JSON number) and for every decision derived from that
 * classification. It is deliberately NOT exported from the public entry
 * `index.ts`: the public utils in `utils.ts` (`isNumber`, `isInteger`,
 * `isSafeNumber`, `getUnsafeNumberReason`, `toSafeNumberOrThrow`, `splitNumber`,
 * `countSignificantDigits`, `extractSignificantDigits`), the `LosslessNumber`
 * class, the default number parser `parseLosslessNumber` (and hence `parse`),
 * and the number validation in `stringify` all delegate to the functions here,
 * so every conversion decision originates from the same immutable analysis.
 *
 * The analysis is purely lexical: it operates on the characters of the lexeme
 * and never routes the value through `Number` first, so no precision can be
 * lost before a conversion decision is made. It is also stateless: there is no
 * module level cache, counter, or mutable state, so a failed call cannot leak
 * any state into subsequent calls.
 */

/**
 * An immutable analysis of a valid JSON number lexeme.
 */
export interface NumberLexeme {
  // the analyzed lexeme, exactly as provided
  readonly value: string
  // whether the lexeme is an integer (no fraction and no exponent)
  readonly isInteger: boolean
  // whether the lexeme carries a minus sign
  readonly isNegative: boolean
  // whether the lexeme denotes a zero value (for example '0', '-0', '0e5')
  readonly isZero: boolean
  // sign, significant digits, and decimal exponent of the normalized value
  readonly split: Readonly<NumberSplit>
  // the significant digits of the lexeme ('' for a zero value)
  readonly significantDigits: string
  // the number of significant digits of the lexeme
  readonly significantDigitCount: number
}

const NUMBER_LEXEME_REGEX = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const INTEGER_LEXEME_REGEX = /^-?[0-9]+$/
const SPLIT_LEXEME_REGEX = /^(-?)(\d+\.?\d*)([eE]([+-]?\d+))?$/

/**
 * Test whether a string is a valid JSON number lexeme
 */
export function isNumberLexeme(value: string): boolean {
  return NUMBER_LEXEME_REGEX.test(value)
}

/**
 * Test whether a string is an integer JSON number lexeme
 */
export function isIntegerLexeme(value: string): boolean {
  return INTEGER_LEXEME_REGEX.test(value)
}

/**
 * Analyze a string as a JSON number lexeme.
 *
 * Returns an immutable NumberLexeme when the string is a valid JSON number,
 * and undefined otherwise. The analysis is a pure function of the input:
 * repeated calls return deep equal but independent results.
 */
export function analyzeNumberLexeme(value: string): NumberLexeme | undefined {
  if (!isNumberLexeme(value)) {
    return undefined
  }

  const split = splitNumberLexeme(value)
  if (split === undefined) {
    // unreachable: every valid number lexeme can be split
    throw new SyntaxError(`Invalid number: ${value}`)
  }

  const significantDigits = significantDigitsOf(value)

  return Object.freeze({
    value,
    isInteger: isIntegerLexeme(value),
    isNegative: value.charAt(0) === '-',
    isZero: split.digits === '0',
    split: Object.freeze(split),
    significantDigits,
    significantDigitCount: significantDigits.length
  })
}

/**
 * Split a number lexeme into sign, digits, and exponent.
 * Leading zeros and non-canonical zeros are normalized.
 *
 * Returns undefined when the value cannot be split.
 *
 * The value can be constructed again from a split number by inserting a dot
 * at the second character of the digits if there is more than one digit,
 * prepending it with the sign, and appending an "e" and the exponent as follows:
 *
 *     const reconstructed = `${sign}${digits[0]}.${digits.slice(1)}e${exponent}`
 *
 */
export function splitNumberLexeme(value: string): NumberSplit | undefined {
  const match = SPLIT_LEXEME_REGEX.exec(value)
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
  return digits.length > 0 ? { sign, digits, exponent } : { sign: '', digits: '0', exponent: 0 }
}

/**
 * Get the significant digits of a number lexeme as a string.
 *
 * For example:
 *   '2.34' returns '234'
 *   '-77' returns '77'
 *   '0.003400' returns '34'
 *   '120.5e+30' returns '1205'
 */
export function significantDigitsOf(value: string): string {
  const { start, end } = significantDigitRange(value)

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
 *     significantDigitRange('0.0325900') // { start: 3, end: 7 }
 *     significantDigitRange('2.0300')    // { start: 0, end: 3 }
 *     significantDigitRange('0.0')       // { start: 3, end: 3 }
 *
 */
export function significantDigitRange(value: string): { start: number; end: number } {
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
