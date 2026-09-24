/**
 * Unified classification of JSON number lexemes and their conversion decisions.
 *
 * This module is the single source of truth shared by the public entry points
 * `parse`, `parseLosslessNumber`, `LosslessNumber`/`isLosslessNumber`, and
 * `stringify`:
 *
 *  1. `scanNumberLexeme` recognizes a JSON number lexeme straight from the
 *     raw input (no regex copy, no `Number` conversion of the verbatim text),
 *     so error positions keep pointing at offsets of the original input.
 *  2. `analyzeNumberLexeme` lexes a complete lexeme once and returns a
 *     *frozen* analysis result describing both the number lexeme
 *     (sign/digits/exponent parts) and the conversion strategy derived from
 *     it. Every later conversion decision (LosslessNumber#valueOf,
 *     parseNumberAndBigInt, isSafeNumber/getUnsafeNumberReason) reads that
 *     same result; nothing recomputes through an independent code path.
 *
 * Precision guarantee: the stored value is always the verbatim lexeme text.
 * Integer safety is decided with lexicographic digit comparison only (never
 * `parseInt`/`Number`, which can round long integers before the decision).
 * A floating point `Number` is computed only for non-integer lexemes and
 * only to decide whether a float conversion is exact or merely truncates
 * insignificant digits; the lexeme itself is never replaced by that number.
 */

// Lexical character codes, shared with the streaming parser so that lexeme
// recognition exists in exactly one place.
export const codeMinus = 0x2d // "-"
export const codePlus = 0x2b // "+"
export const codeDot = 0x2e // "."
export const codeZero = 0x30
export const codeOne = 0x31
export const codeNine = 0x39
export const codeUppercaseE = 0x45 // "E"
export const codeLowercaseE = 0x65 // "e"

export function isDigit(code: number | undefined): boolean {
  return code !== undefined && code >= codeZero && code <= codeNine
}

export function isNonZeroDigit(code: number | undefined): boolean {
  return code !== undefined && code >= codeOne && code <= codeNine
}

/**
 * Why a lexeme cannot be converted to a JavaScript number without loss.
 */
export enum UnsafeNumberReason {
  underflow = 'underflow',
  overflow = 'overflow',
  truncate_integer = 'truncate_integer',
  truncate_float = 'truncate_float'
}

/**
 * How a verbatim number lexeme is converted to a JavaScript value.
 */
export enum ConversionStrategy {
  /** `Number.parseFloat(lexeme)`: exact, or a decimal losing insignificant digits */
  float = 'float',
  /** `BigInt(lexeme)`: an integer outside the safe-integer range */
  bigint = 'bigint',
  /** float conversion would become Infinity */
  overflow = 'overflow',
  /** float conversion would become 0 */
  underflow = 'underflow'
}

/**
 * The result of classifying a single JSON number lexeme.
 * The object is frozen: all conversion decisions read exactly these values.
 */
export interface NumberLexeme {
  /** verbatim lexeme text, never normalized through Number */
  readonly text: string
  readonly sign: '-' | ''
  readonly integerDigits: string
  readonly fractionDigits: string | undefined
  readonly exponentPresent: boolean
  readonly exponentSign: '+' | '-' | ''
  readonly exponentDigits: string | undefined
  /** true for lexemes without a fraction or exponent part, e.g. "12" or "-0" */
  readonly integerLike: boolean
  /** lexical zero check, e.g. true for "0", "-0.0", "0e+2" */
  readonly isZero: boolean
  readonly isNegative: boolean
  /** integer-like lexeme whose magnitude is at most Number.MAX_SAFE_INTEGER */
  readonly isSafeInteger: boolean
  /** undefined when the lexeme converts without (significant) loss */
  readonly unsafeReason: UnsafeNumberReason | undefined
  readonly strategy: ConversionStrategy
}

/**
 * Brand under which the frozen analysis is stored on a LosslessNumber.
 * Non-enumerable so the public shape of LosslessNumber does not change.
 */
export const LOSSLESS_NUMBER_BRAND: unique symbol = Symbol('lossless-number-lexeme')

/**
 * Result of streaming a potential number lexeme from raw input:
 * - `null`: no number lexeme starts at `start`
 * - `{ ok: true, end }`: a complete lexeme ending at `end`
 * - `{ ok: false, end }`: a lexeme started but a required digit is missing
 *   at `end` (caller reports a syntax error at that offset)
 */
export type NumberLexemeScan =
  | { readonly ok: true; readonly end: number }
  | { readonly ok: false; readonly end: number }
  | null

/**
 * Scan a single JSON number lexeme starting at `start`, following the strict
 * JSON grammar (no leading zeros). Never throws and never calls Number():
 * malformed lexemes are reported with `{ ok: false, end }` so that the
 * caller can point the error at the original input offset.
 */
export function scanNumberLexeme(text: string, start: number): NumberLexemeScan {
  let i = start

  if (text.charCodeAt(i) === codeMinus) {
    i++
  }

  if (text.charCodeAt(i) === codeZero) {
    i++
  } else if (isNonZeroDigit(text.charCodeAt(i))) {
    i++
    while (isDigit(text.charCodeAt(i))) {
      i++
    }
  } else {
    // No integer digit: either the lexeme did not start here, or it is a
    // dangling minus sign.
    return i > start ? { ok: false, end: i } : null
  }

  if (text.charCodeAt(i) === codeDot) {
    i++
    if (!isDigit(text.charCodeAt(i))) {
      return { ok: false, end: i }
    }
    while (isDigit(text.charCodeAt(i))) {
      i++
    }
  }

  const exponentCode = text.charCodeAt(i)
  if (exponentCode === codeLowercaseE || exponentCode === codeUppercaseE) {
    i++
    if (text.charCodeAt(i) === codeMinus || text.charCodeAt(i) === codePlus) {
      i++
    }
    if (!isDigit(text.charCodeAt(i))) {
      return { ok: false, end: i }
    }
    while (isDigit(text.charCodeAt(i))) {
      i++
    }
  }

  return { ok: true, end: i }
}

/**
 * Test whether a whole string is one valid JSON number lexeme.
 */
export function isNumberLexeme(value: string): boolean {
  const scanned = scanNumberLexeme(value, 0)
  return scanned !== null && scanned.ok && scanned.end === value.length
}

/**
 * Compare the magnitude of an unsigned integer digit string against
 * Number.MAX_SAFE_INTEGER (9007199254740991) using digit comparison only,
 * so no precision is lost through Number before the decision is made.
 */
export function isSafeIntegerMagnitude(integerDigits: string): boolean {
  const digits = integerDigits.replace(/^0+/, '')
  if (digits === '') {
    return true // zero
  }
  if (digits.length !== MAX_SAFE_INTEGER_DIGITS.length) {
    return digits.length < MAX_SAFE_INTEGER_DIGITS.length
  }
  return digits <= MAX_SAFE_INTEGER_DIGITS
}

const MAX_SAFE_INTEGER_DIGITS = '9007199254740991'

/**
 * Count the significant digits of a number lexeme.
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
 * Get the significant digits of a number lexeme.
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

/**
 * Decide whether a non-integer lexeme maps to a float Number without losing
 * significant digits. The verbatim lexeme has already been captured before
 * the Number conversion is consulted; the Number is only used to test
 * round-trip equivalence, never as the stored value.
 */
function isExactFloatLexeme(value: string, num: number = Number.parseFloat(value)): boolean {
  const parsed = String(num)

  if (value === parsed) {
    return true
  }

  return extractSignificantDigits(value) === extractSignificantDigits(parsed)
}

interface LexemeParts {
  sign: '-' | ''
  integerDigits: string
  fractionDigits: string | undefined
  exponentPresent: boolean
  exponentSign: '+' | '-' | ''
  exponentDigits: string | undefined
}

function extractParts(value: string): LexemeParts {
  let rest = value
  const sign: '-' | '' = rest.startsWith('-') ? '-' : ''
  if (sign === '-') {
    rest = rest.slice(1)
  }

  let exponentPresent = false
  let exponentSign: '+' | '-' | '' = ''
  let exponentDigits: string | undefined

  const exponentMark = rest.search(/[eE]/)
  if (exponentMark !== -1) {
    exponentPresent = true
    rest = rest.slice(0, exponentMark)
    let exponentPart = value.slice(sign.length + exponentMark + 1)
    if (exponentPart.startsWith('+') || exponentPart.startsWith('-')) {
      exponentSign = exponentPart[0] as '+' | '-'
      exponentPart = exponentPart.slice(1)
    }
    exponentDigits = exponentPart
  }

  let integerDigits = rest
  let fractionDigits: string | undefined

  const dot = rest.indexOf('.')
  if (dot !== -1) {
    integerDigits = rest.slice(0, dot)
    fractionDigits = rest.slice(dot + 1)
  }

  return {
    sign,
    integerDigits,
    fractionDigits,
    exponentPresent,
    exponentSign,
    exponentDigits
  }
}

/**
 * Analyze a complete, validated JSON number lexeme and return the immutable
 * classification shared by all conversion entry points.
 *
 * @throws Error with the stable `Invalid number` message for an illegal token
 */
export function analyzeNumberLexeme(value: string): NumberLexeme {
  if (!isNumberLexeme(value)) {
    throw new Error(`Invalid number (value: "${value}")`)
  }

  const parts = extractParts(value)
  const integerLike = parts.fractionDigits === undefined && !parts.exponentPresent
  const isNegative = parts.sign === '-'
  const isZero = `${parts.integerDigits}${parts.fractionDigits ?? ''}`
    .split('')
    .every((digit) => digit === '0')

  let isSafeInteger = false
  let unsafeReason: UnsafeNumberReason | undefined
  let strategy: ConversionStrategy

  if (integerLike) {
    isSafeInteger = isSafeIntegerMagnitude(parts.integerDigits)
    if (isSafeInteger) {
      strategy = ConversionStrategy.float
    } else {
      unsafeReason = UnsafeNumberReason.truncate_integer
      strategy = ConversionStrategy.bigint
    }
  } else {
    const num = Number.parseFloat(value)
    if (!Number.isFinite(num)) {
      unsafeReason = UnsafeNumberReason.overflow
      strategy = ConversionStrategy.overflow
    } else if (isExactFloatLexeme(value, num)) {
      strategy = ConversionStrategy.float
    } else if (num === 0) {
      unsafeReason = UnsafeNumberReason.underflow
      strategy = ConversionStrategy.underflow
    } else {
      unsafeReason = UnsafeNumberReason.truncate_float
      strategy = ConversionStrategy.float
    }
  }

  return Object.freeze({
    text: value,
    sign: parts.sign,
    integerDigits: parts.integerDigits,
    fractionDigits: parts.fractionDigits,
    exponentPresent: parts.exponentPresent,
    exponentSign: parts.exponentSign,
    exponentDigits: parts.exponentDigits,
    integerLike,
    isZero,
    isNegative,
    isSafeInteger,
    unsafeReason,
    strategy
  })
}

/**
 * Apply the conversion strategy of an analyzed lexeme. This is the one place
 * where the classification becomes an actual value, shared by
 * LosslessNumber#valueOf and the bundled number parsers.
 *
 * @throws Error for overflow/underflow, matching the public error contract
 */
export function convertLexeme(lexeme: NumberLexeme): number | bigint {
  switch (lexeme.strategy) {
    case ConversionStrategy.float:
      return Number.parseFloat(lexeme.text)

    case ConversionStrategy.bigint:
      return BigInt(lexeme.text)

    case ConversionStrategy.overflow:
    case ConversionStrategy.underflow:
      throw new Error(
        `Cannot safely convert to number: the value '${lexeme.text}' would ${
          lexeme.unsafeReason
        } and become ${Number.parseFloat(lexeme.text)}`
      )
  }
}
