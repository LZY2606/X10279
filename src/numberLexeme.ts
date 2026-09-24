/**
 * Unified classification and conversion decision for JSON number lexemes.
 *
 * This module is the single source of truth shared by the public entry points
 * `parse`, `parseLosslessNumber`, `LosslessNumber`/`isLosslessNumber` and
 * `stringify`:
 *
 * - `scanNumberLexeme` reads a number lexeme straight from the raw input
 *   without ever routing it through a JavaScript `Number`.
 * - `analyzeNumberLexeme` turns a lexeme string into one frozen, immutable
 *   analysis result describing its lexical form and conversion strategy.
 *
 * Structural classification (integer/exponent/sign/zero) is derived from the
 * raw text only. `Number` is used solely to compute the actual IEEE 754
 * conversion output, never to decide the lexical shape or to compare integer
 * magnitude, so analysis cannot silently lose precision first.
 */

export enum UnsafeNumberReason {
  underflow = 'underflow',
  overflow = 'overflow',
  truncate_integer = 'truncate_integer',
  truncate_float = 'truncate_float'
}

const NUMBER_LEXEME_PARTS = /^(-?)(0|[1-9]\d*)?(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/
const INTEGER_DIGITS = /^-?\d+$/

export type NumberForm = 'integer' | 'decimal' | 'exponential'

/**
 * The decision that a consumer should take when converting a number lexeme.
 * The decision is derived from the immutable analysis result and is shared by
 * all public entry points.
 */
export type NumberConversionStrategy =
  | 'safe_number' // can be represented exactly (or exactly-ish for floats)
  | 'bigint' // integer outside the safe integer range
  | 'truncate_float' // float loses insignificant digits
  | 'overflow' // magnitude exceeds Number.MAX_VALUE
  | 'underflow' // nonzero magnitude rounds to zero

export interface NumberLexeme {
  /** Raw lexeme as it occurred in the source text (never normalized). */
  readonly source: string
  readonly sign: '' | '-'
  /** Digits of the integer part, without sign. */
  readonly integerPart: string
  /** Fraction digits, or an empty string when there is no fraction. */
  readonly fractionPart: string
  /** Exponent digits as text, or undefined when no exponent is present. */
  readonly exponentDigits: string | undefined
  /** Parsed decimal exponent (undefined when no exponent is present). */
  readonly exponent: number | undefined
  readonly form: NumberForm
  readonly hasExponent: boolean
  readonly isNegative: boolean
  readonly isZero: boolean
  readonly isNegativeZero: boolean
  /** Whether the lexeme has an integer form (no fraction, no exponent). */
  readonly isIntegerLexeme: boolean
  /** All significant digits, text based (no Number conversion). */
  readonly significantDigits: string
  /** Conversion decision shared by parse/valueOf/stringify consumers. */
  readonly strategy: NumberConversionStrategy
  readonly unsafeReason: UnsafeNumberReason | undefined
}

/**
 * Internal brand linking a LosslessNumber instance to the exact immutable
 * lexeme analysis it was created from. Not part of the public API.
 */
export const LEXEME_BRAND: unique symbol = Symbol('lossless-json.number-lexeme')

const MAX_SAFE_INTEGER_DIGITS = '9007199254740991'
const MIN_SAFE_INTEGER_DIGITS = '9007199254740991' // magnitude of MIN_SAFE_INTEGER

/**
 * Text based safe integer test: compares digit strings instead of passing the
 * value through `Number`/`parseInt`, so integers beyond the safe range are not
 * rounded before the decision is made.
 */
function isSafeIntegerDigits(isNegative: boolean, digits: string): boolean {
  if (digits.length < MAX_SAFE_INTEGER_DIGITS.length) {
    return true
  }

  if (digits.length > MAX_SAFE_INTEGER_DIGITS.length) {
    return false
  }

  const boundary = isNegative ? MIN_SAFE_INTEGER_DIGITS : MAX_SAFE_INTEGER_DIGITS

  return digits <= boundary
}

interface NumberParts {
  sign: '' | '-'
  integerPart: string
  fractionPart: string
  exponentDigits: string | undefined
}

function parseParts(lexeme: string): NumberParts | undefined {
  const match = NUMBER_LEXEME_PARTS.exec(lexeme)
  if (!match) {
    return undefined
  }

  // The regex matches a lone '-' too; require at least one digit.
  if (match[2] === undefined && match[3] === undefined) {
    return undefined
  }

  return {
    sign: match[1] as '' | '-',
    integerPart: match[2] ?? '',
    fractionPart: match[3] ?? '',
    exponentDigits: match[4]
  }
}

/**
 * Strip leading and trailing zeros from a digit string.
 * Returns '0' for all-zero input.
 */
function stripInsignificantZeros(digits: string): string {
  const withoutLeading = digits.replace(/^0+/, '')
  const core = withoutLeading === '' ? '0' : withoutLeading
  if (core === '0') {
    return '0'
  }
  return core.replace(/0+$/, '')
}

/**
 * Get the significant digits of arbitrary numeric text (lenient: accepts
 * leading zeros and a leading dot). Text based, no `Number` conversion.
 *
 * For example:
 *   '2.34' returns '234'
 *   '0.003400' returns '34'
 *   '.2' returns '2'
 */
export function extractSignificantDigits(value: string): string {
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

  const range = value.substring(start, end)
  const dot = range.indexOf('.')
  return dot === -1 ? range : range.substring(0, dot) + range.substring(dot + 1)
}

/**
 * Count the significant digits of a number.
 */
export function countSignificantDigits(value: string): number {
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

  const dot = value.indexOf('.')
  if (dot === -1 || dot < start || dot > end) {
    return end - start
  }

  return end - start - 1
}

function composeLexeme(parts: NumberParts): string {
  let text = `${parts.sign}${parts.integerPart === '' ? '0' : parts.integerPart}`
  if (parts.fractionPart !== '') {
    text += `.${parts.fractionPart}`
  }
  if (parts.exponentDigits !== undefined) {
    text += `e${parts.exponentDigits}`
  }
  return text
}

function significantDigitsOfParts(parts: NumberParts): string {
  return stripInsignificantZeros(`${parts.integerPart}${parts.fractionPart}`)
}

/**
 * Whether a lexeme with a fraction or exponent stays safe as a float.
 * Mirrors the historical behavior: exact round-trip or identical significant
 * digits. The `Number` conversion only computes the IEEE 754 output, it does
 * not classify the lexeme.
 */
function isSafeFloatLexeme(parts: NumberParts, source: string): boolean {
  const number = Number.parseFloat(source)
  const parsed = String(number)

  if (source === parsed) {
    return true
  }

  return significantDigitsOfParts(parts) === extractSignificantDigits(parsed)
}

function decideStrategy(
  parts: NumberParts,
  source: string
): {
  strategy: NumberConversionStrategy
  unsafeReason: UnsafeNumberReason | undefined
} {
  const isNegative = parts.sign === '-'
  const hasFraction = parts.fractionPart !== ''
  const hasExponent = parts.exponentDigits !== undefined

  if (!hasFraction && !hasExponent) {
    return isSafeIntegerDigits(isNegative, parts.integerPart)
      ? { strategy: 'safe_number', unsafeReason: undefined }
      : { strategy: 'bigint', unsafeReason: UnsafeNumberReason.truncate_integer }
  }

  if (isSafeFloatLexeme(parts, source)) {
    return { strategy: 'safe_number', unsafeReason: undefined }
  }

  const number = Number.parseFloat(source)
  if (!Number.isFinite(number)) {
    return { strategy: 'overflow', unsafeReason: UnsafeNumberReason.overflow }
  }

  if (number === 0) {
    return { strategy: 'underflow', unsafeReason: UnsafeNumberReason.underflow }
  }

  return {
    strategy: 'truncate_float',
    unsafeReason: UnsafeNumberReason.truncate_float
  }
}

/**
 * Analyze a JSON number lexeme into a frozen, immutable result.
 *
 * Throws a `SyntaxError` for a lexeme that is not a valid JSON number,
 * including leading zeros (`01`) and surrounding whitespace.
 */
export function analyzeNumberLexeme(lexeme: string): NumberLexeme {
  const parts = parseParts(lexeme)
  if (parts === undefined) {
    throw new SyntaxError(`Invalid number lexeme: ${lexeme}`)
  }

  const hasFraction = parts.fractionPart !== ''
  const hasExponent = parts.exponentDigits !== undefined
  const exponent = hasExponent ? Number.parseInt(parts.exponentDigits as string, 10) : undefined

  const form: NumberForm = hasExponent ? 'exponential' : hasFraction ? 'decimal' : 'integer'

  const significantDigits = significantDigitsOfParts(parts)
  const isZero = significantDigits === '0'
  const isNegative = parts.sign === '-'
  const { strategy, unsafeReason } = decideStrategy(parts, lexeme)

  return Object.freeze({
    source: lexeme,
    sign: parts.sign,
    integerPart: parts.integerPart,
    fractionPart: parts.fractionPart,
    exponentDigits: parts.exponentDigits,
    exponent,
    form,
    hasExponent,
    isNegative,
    isZero,
    isNegativeZero: isNegative && isZero,
    isIntegerLexeme: !hasFraction && !hasExponent,
    significantDigits,
    strategy,
    unsafeReason
  })
}

/**
 * Analyze a lexeme without throwing, returning undefined for invalid input.
 * Used for validating free-form strings where a rejection already has a
 * different error layer.
 */
export function tryAnalyzeNumberLexeme(lexeme: string): NumberLexeme | undefined {
  try {
    return analyzeNumberLexeme(lexeme)
  } catch {
    return undefined
  }
}

/**
 * Whether a whole string is a syntactically valid JSON number lexeme.
 * Shared by `isNumber` and `stringify`'s number-stringifier validation.
 */
export function isValidNumberLexeme(lexeme: string): boolean {
  return parseParts(lexeme) !== undefined
}

/**
 * Whether a string has the textual form of an integer (optional minus and
 * digits only). Kept deliberately lenient toward leading zeros, matching the
 * public `isInteger` contract used by `parseNumberAndBigInt`.
 */
export function isIntegerDigits(value: string): boolean {
  return INTEGER_DIGITS.test(value)
}

/**
 * Approximate safety test for non-integer lexemes: safe when at least 14
 * significant digits share their prefix with the IEEE 754 representation.
 */
export function isApproximatelySafeFloatLexeme(lexeme: NumberLexeme): boolean {
  if (lexeme.isIntegerLexeme) {
    return false
  }

  const requiredDigits = 14
  const parsedDigits = extractSignificantDigits(String(Number.parseFloat(lexeme.source)))

  return (
    parsedDigits.length >= requiredDigits &&
    lexeme.significantDigits.startsWith(parsedDigits.substring(0, requiredDigits))
  )
}

export interface ScannedNumberLexeme {
  /** Index of the first character of the lexeme in the source text. */
  readonly start: number
  /** Index just past the last character of the lexeme. */
  readonly end: number
  /** The raw lexeme text. */
  readonly lexeme: string
  /** Immutable analysis of the scanned lexeme. */
  readonly analysis: NumberLexeme
}

const CHAR_MINUS = 0x2d
const CHAR_PLUS = 0x2b
const CHAR_DOT = 0x2e
const CHAR_ZERO = 0x30
const CHAR_NINE = 0x39
const CHAR_LOWER_E = 0x65
const CHAR_UPPER_E = 0x45

function isDigitCode(code: number | undefined): boolean {
  return code !== undefined && code >= CHAR_ZERO && code <= CHAR_NINE
}

/**
 * Scan a number lexeme directly from raw JSON text starting at `start`.
 *
 * Returns undefined when the text at `start` cannot begin a number.
 * Throws a SyntaxError pointing at the raw input (including its index) for a
 * malformed number prefix such as `2e`, `2.` or `2..3`.
 *
 * The scan is purely text based: the lexeme is never passed through `Number`
 * before it reaches the number parser, so no precision is lost in analysis.
 * A lexeme produced by this scanner is always a syntactically valid JSON
 * number, so its analysis uses the exact same code path as `parseLosslessNumber`.
 */
export function scanNumberLexeme(text: string, start: number): ScannedNumberLexeme | undefined {
  let i = start

  if (text.charCodeAt(i) === CHAR_MINUS) {
    i++
    if (!isDigitCode(text.charCodeAt(i))) {
      throw invalidNumber(text, start, i)
    }
  } else if (!isDigitCode(text.charCodeAt(i))) {
    return undefined
  }

  if (text.charCodeAt(i) === CHAR_ZERO) {
    i++
  } else {
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
  }

  if (text.charCodeAt(i) === CHAR_DOT) {
    i++
    if (!isDigitCode(text.charCodeAt(i))) {
      throw invalidNumber(text, start, i)
    }
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
  }

  if (text.charCodeAt(i) === CHAR_LOWER_E || text.charCodeAt(i) === CHAR_UPPER_E) {
    i++
    if (text.charCodeAt(i) === CHAR_MINUS || text.charCodeAt(i) === CHAR_PLUS) {
      i++
    }
    if (!isDigitCode(text.charCodeAt(i))) {
      throw invalidNumber(text, start, i)
    }
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
  }

  const rawLexeme = text.slice(start, i)

  return { start, end: i, lexeme: rawLexeme, analysis: analyzeNumberLexeme(rawLexeme) }
}

function invalidNumber(text: string, start: number, position: number): SyntaxError {
  const numSoFar = text.slice(start, position)
  const got =
    position < text.length ? `but got '${text[position]}'` : 'but reached end of input'

  return new SyntaxError(
    `Invalid number '${numSoFar}', expecting a digit ${got} at position ${position}`
  )
}
