/**
 * Unified analysis of a JSON number lexeme.
 *
 * This module is the single place that classifies a number lexeme and decides
 * how it may be converted. The parser (`parseNumeric`), `parseLosslessNumber`,
 * `LosslessNumber#valueOf`, `parseNumberAndBigInt` and the number validation
 * used by `stringify` all go through this code, so a given lexeme always
 * yields one and the same immutable analysis result. There is no per-call
 * caching, no counter and no mutable module state: every analysis is
 * independent, so retries, failures and interleaved executions cannot leak
 * state into each other.
 *
 * Structural classification is purely lexical. The analysis never routes an
 * integer or an extreme exponent through `Number` first; an IEEE-754 probe is
 * performed only for the already classified floating-point case.
 */

/** Shape of a JSON number token as recognized by the lexer. */
export type NumberKind = 'integer' | 'decimal'

/**
 * Conversion decision derived from an immutable number lexeme analysis.
 *
 * - `safe_number`: converts losslessly to a JS number
 * - `bigint`: converts to a bigint (plain integer outside the safe integer range)
 * - `truncate_float`: converts to a number that loses insignificant digits
 * - `overflow`: conversion becomes +/-Infinity
 * - `underflow`: conversion becomes 0
 */
export type NumberConversionStrategy =
  | 'safe_number'
  | 'bigint'
  | 'truncate_float'
  | 'overflow'
  | 'underflow'

/**
 * The immutable result of classifying one JSON number lexeme.
 *
 * Every field is primitive (or bigint) and the whole object is frozen. Callers
 * can keep a reference safely: the analysis can never be mutated or
 * invalidated by later parses, retries, failures or interleaved executions.
 */
export interface NumberLexeme {
  /** The exact source text of the lexeme. */
  readonly text: string
  readonly negative: boolean
  readonly kind: NumberKind
  /** Mantissa digits (integer and fraction concatenated), as in the source. */
  readonly mantissa: string
  /** Significant mantissa digits, with leading and trailing zeros removed. */
  readonly significantDigits: string
  /** Explicit exponent text when present (without the `e`/`E`). */
  readonly exponentText?: string
  /**
   * Decimal position of the units column: the value equals
   * `significantDigits * 10 ** exponent`. For a zero lexeme there are no
   * significant digits, so the exponent is just the structural value derived
   * from the spelling (e.g. `-0.0` -> -1, `-0e500` -> 500).
   * Stored as bigint so extreme exponents never overflow during analysis.
   */
  readonly exponent: bigint
  /** Whether the numeric value is zero, in any of its spellings. */
  readonly isZero: boolean
  /** The single, immutable conversion decision for this lexeme. */
  readonly conversion: NumberConversionStrategy
}

/** Outcome of lexically scanning a number prefix of an input. */
export interface NumberScan {
  /** The scanned text. Empty when no number starts at `start`. */
  readonly text: string
  readonly start: number
  /** Position right after the scanned lexeme. */
  readonly end: number
  /** True when a digit was expected but missing; scanning stops at that point. */
  readonly invalid: boolean
  /** The position where the missing digit was expected (when `invalid`). */
  readonly errorAt: number
}

// character codes shared with the parser: the lexer grammar lives in one place
export const codeMinus = 0x2d // "-"
export const codePlus = 0x2b // "+"
export const codeDot = 0x2e // "."
export const codeZero = 0x30
export const codeNine = 0x39
export const codeLowercaseE = 0x65 // "e"
export const codeUppercaseE = 0x45 // "E"

function isDigitCode(code: number | undefined): boolean {
  return code !== undefined && code >= codeZero && code <= codeNine
}

const MAX_SAFE_INTEGER = 9007199254740991n

/**
 * Scan a number lexeme starting at `text[start]` using exactly the grammar of
 * the JSON parser (including its historical behavior: after a leading `0`, no
 * further integer digits are consumed, so `01` stops right after the `0`).
 *
 * The scanner never throws. Malformed numbers are reported with
 * `invalid: true`; `errorAt` is the first position where a digit was expected,
 * and `end`/`text` stop there, which is exactly what the parser needs to
 * reproduce its established error messages and positions.
 */
export function scanNumberLexeme(text: string, start: number = 0): NumberScan {
  let i = start
  if (text.charCodeAt(i) === codeMinus) {
    i++
    if (!isDigitCode(text.charCodeAt(i))) {
      return { text: text.slice(start, i), start, end: i, invalid: true, errorAt: i }
    }
  }

  if (text.charCodeAt(i) === codeZero) {
    i++
  } else if (isDigitCode(text.charCodeAt(i))) {
    i++
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
  } else {
    return { text: '', start, end: i, invalid: false, errorAt: -1 }
  }

  if (text.charCodeAt(i) === codeDot) {
    i++
    if (!isDigitCode(text.charCodeAt(i))) {
      return { text: text.slice(start, i), start, end: i, invalid: true, errorAt: i }
    }
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
  }

  if (text.charCodeAt(i) === codeLowercaseE || text.charCodeAt(i) === codeUppercaseE) {
    i++
    if (text.charCodeAt(i) === codeMinus || text.charCodeAt(i) === codePlus) {
      i++
    }
    if (!isDigitCode(text.charCodeAt(i))) {
      return { text: text.slice(start, i), start, end: i, invalid: true, errorAt: i }
    }
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
  }

  return { text: text.slice(start, i), start, end: i, invalid: false, errorAt: -1 }
}

/**
 * Strict whole-string JSON number test, matching the documented JSON grammar
 * (a leading `0` must not be followed by more integer digits).
 */
export function isNumberLexeme(text: string): boolean {
  const scan = scanNumberLexeme(text, 0)
  return !scan.invalid && scan.end === text.length && scan.text.length > 0
}

function parseExponentText(raw: string): bigint {
  let i = 0
  let negative = false
  if (raw.charCodeAt(0) === codeMinus) {
    negative = true
    i++
  } else if (raw.charCodeAt(0) === codePlus) {
    i++
  }

  let value = 0n
  for (; i < raw.length; i++) {
    value = value * 10n + BigInt(raw.charCodeAt(i) - codeZero)
  }
  return negative ? -value : value
}

/**
 * Extract the significant digits of a numeric string. This is the shared
 * implementation of the legacy text helpers in `utils.ts`.
 */
export function extractSignificantDigitsFromText(value: string): string {
  let start = value.charCodeAt(0) === codeMinus ? 1 : 0
  while (value[start] === '0' || value[start] === '.') {
    start++
  }

  let end = value.search(/[eE]/)
  if (end === -1) {
    end = value.length
  }
  while ((value[end - 1] === '0' || value[end - 1] === '.') && end > start) {
    end--
  }

  const digits = value.substring(start, end)
  const dot = digits.indexOf('.')
  return dot === -1 ? digits : digits.substring(0, dot) + digits.substring(dot + 1)
}

function decideConversion(lexeme: {
  text: string
  kind: NumberKind
  mantissa: string
  isZero: boolean
}): NumberConversionStrategy {
  if (lexeme.isZero) {
    // every spelling of zero converts losslessly, matching the legacy behavior
    return 'safe_number'
  }

  if (lexeme.kind === 'integer') {
    // purely textual safe-integer check; never goes through Number/parseInt
    const absolute = BigInt(lexeme.mantissa)
    const magnitude = absolute < 0n ? -absolute : absolute
    return magnitude <= MAX_SAFE_INTEGER ? 'safe_number' : 'bigint'
  }

  // Floating-point case. The IEEE-754 probe happens here only, after the
  // lexical classification decided this really is a decimal/exponent value.
  const num = Number.parseFloat(lexeme.text)
  if (!Number.isFinite(num)) {
    return 'overflow'
  }
  if (num === 0) {
    return 'underflow'
  }

  const reparsed = String(num)
  if (lexeme.text === reparsed) {
    return 'safe_number'
  }
  return extractSignificantDigitsFromText(lexeme.text) ===
    extractSignificantDigitsFromText(reparsed)
    ? 'safe_number'
    : 'truncate_float'
}

/**
 * Analyze a whole, standalone numeric string and produce its immutable
 * classification and conversion decision.
 *
 * Throws a `SyntaxError` (the same error layer the parser uses) when the
 * argument is not a complete JSON number.
 */
export function analyzeNumber(value: string): NumberLexeme {
  const scan = scanNumberLexeme(value, 0)
  if (scan.invalid || scan.end !== value.length || scan.text.length === 0) {
    throw new SyntaxError(`Invalid number: ${value}`)
  }

  const negative = value.charCodeAt(0) === codeMinus
  let cursor = negative ? 1 : 0

  const exponentMarkMatch = /[eE]/.exec(value)
  const exponentMark = exponentMarkMatch ? exponentMarkMatch.index : -1
  const tail = exponentMark === -1 ? value.length : exponentMark
  const dot = value.indexOf('.')

  const integerEnd = dot === -1 ? tail : dot
  const integerPart = value.slice(cursor, integerEnd)
  const fractionPart = dot === -1 ? '' : value.slice(dot + 1, tail)
  const exponentText = exponentMark === -1 ? undefined : value.slice(exponentMark + 1)

  const mantissa = integerPart + fractionPart
  const significantDigits = extractSignificantDigitsFromText(value.slice(0, tail))
  const isZero = significantDigits.length === 0
  // A token with an exponent (even an integer-valued one like `23e3`) takes
  // the exponent/float path; only a plain `-?digits` token is an integer.
  const kind: NumberKind =
    fractionPart.length > 0 || exponentText !== undefined ? 'decimal' : 'integer'

  // The value equals `significantDigits * 10 ** exponent`.
  let exponent = exponentText !== undefined ? parseExponentText(exponentText) : 0n
  exponent -= BigInt(fractionPart.length)
  if (!isZero) {
    const trailingZeros = /0+$/.exec(mantissa)?.[0].length ?? 0
    exponent += BigInt(trailingZeros)
  }

  const lexeme: NumberLexeme = {
    text: value,
    negative,
    kind,
    mantissa,
    significantDigits,
    exponentText,
    exponent,
    isZero,
    conversion: 'safe_number' // replaced immediately below
  }

  const conversion = decideConversion(lexeme)
  const finalized: NumberLexeme = { ...lexeme, conversion }
  return Object.freeze(finalized)
}

/**
 * Apply the immutable conversion decision of an analyzed lexeme.
 *
 * Mirrors the documented `LosslessNumber#valueOf` contract: safe numbers and
 * truncating floats become a number, plain big integers become a bigint,
 * overflow and underflow throw an Error.
 */
export function convertLexeme(lexeme: NumberLexeme): number | bigint {
  switch (lexeme.conversion) {
    case 'safe_number':
    case 'truncate_float':
      return Number.parseFloat(lexeme.text)
    case 'bigint':
      return BigInt(lexeme.text)
    case 'overflow':
    case 'underflow': {
      const num = Number.parseFloat(lexeme.text)
      throw new Error(
        `Cannot safely convert to number: the value '${lexeme.text}' would ${lexeme.conversion} and become ${num}`
      )
    }
  }
}

/**
 * Symbol holding the immutable analysis of a LosslessNumber. Internal only:
 * it is deliberately NOT exported from the package index. Tests that read it
 * observe the exact same object the production `valueOf` conversion uses;
 * there is no separate test-only algorithm.
 */
export const numberLexemeSlot: unique symbol = Symbol('lossless-json/number-lexeme')
