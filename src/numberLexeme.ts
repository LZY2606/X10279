/**
 * Unified classification of JSON number lexemes.
 *
 * Every public entry point that has to decide what a JSON number means
 * ({@link parse}, {@link parseLosslessNumber}, {@link isLosslessNumber}
 * via {@link LosslessNumber}, and {@link stringify} when validating custom
 * number stringifiers) derives its decision from a single
 * {@link NumberLexemeAnalysis} produced by {@link analyzeNumberLexeme}.
 *
 * The analysis is:
 * - lexically computed: the input string is never passed through `Number`
 *   while it is classified, so no precision can be lost before a decision
 * - immutable: every returned analysis is frozen
 * - stateless: the module keeps no counters, caches, or other shared state,
 *   so reordering or repeating calls cannot change the result
 */

export enum UnsafeNumberReason {
  underflow = 'underflow',
  overflow = 'overflow',
  truncate_integer = 'truncate_integer',
  truncate_float = 'truncate_float'
}

/**
 * Result of a greedy scan over the start of a string.
 *
 * `end` is the index right after the longest run of characters that can be
 * part of a JSON number token, matching the lexer used by {@link parse}.
 * `missingDigitAt` is the index where a mandatory digit was expected, or
 * `null` when the token is complete so far.
 */
export interface NumberLexemeScan {
  /** True when the scanner consumed at least a leading minus sign */
  consumed: boolean
  /** Index right after the last character that belongs to the number token */
  end: number
  /** Index of a missing mandatory digit, or null when none is missing */
  missingDigitAt: number | null
}

/**
 * Immutable lexical classification of a number lexeme.
 */
export interface NumberLexemeAnalysis {
  /** The exact input text, preserving formatting such as `-0` or `1.00` */
  readonly lexeme: string
  /** True when the whole string is one syntactically valid JSON number */
  readonly valid: boolean
  /** Index of the first offending character when valid is false */
  readonly invalidAt: number | null
  /** True for a syntactically valid integer without fraction or exponent */
  readonly isInteger: boolean
  /** True when the lexeme carries a leading minus sign */
  readonly negative: boolean
  /** True when the numeric value is zero (0, -0, 0.0, 0e12, ...) */
  readonly isZero: boolean
  /** True only for a negative zero such as -0 or -0.0e2 */
  readonly isNegativeZero: boolean
  /** Significant digits only, without sign, dot, exponent or redundant zeros */
  readonly significantDigits: string
  /** Signed exponent part found after e/E, or null when absent */
  readonly rawExponent: bigint | null
  /** Normalized exponent: power of ten of the first significant digit */
  readonly exponent: bigint
}

/**
 * The single conversion decision derived from an immutable analysis.
 */
export type NumberConversion =
  | { kind: 'number'; value: number; truncatesFloat: boolean }
  | { kind: 'bigint'; value: bigint }
  | { kind: 'error'; reason: UnsafeNumberReason; value: number }

const codePlus = 0x2b // "+"
const codeMinus = 0x2d // "-"
const codeZero = 0x30
const codeNine = 0x39
const codeDot = 0x2e // "."
const codeUppercaseE = 0x45 // "E"
const codeLowercaseE = 0x65 // "e"

function isDigit(code: number | undefined): boolean {
  return code !== undefined && code >= codeZero && code <= codeNine
}

/**
 * Scan a JSON number token starting at `start`, consuming characters exactly
 * like the recursive parser in parse.ts. The scan is purely lexical and does
 * not allocate any analysis result, so the parser can use it directly on
 * every numeric value in the input without duplicated work.
 */
export function scanNumberLexeme(text: string, start: number): NumberLexemeScan {
  let i = start

  if (text.charCodeAt(i) === codeMinus) {
    i++
  }

  if (!isDigit(text.charCodeAt(i))) {
    return {
      consumed: i > start,
      end: i,
      missingDigitAt: i > start ? i : null
    }
  }

  if (text.charCodeAt(i) === codeZero) {
    // a leading zero must stand on its own; stop so trailing input (e.g. '01')
    // is reported at its original position by the surrounding parser
    i++
  } else {
    i++
    while (isDigit(text.charCodeAt(i))) {
      i++
    }
  }

  let missingDigitAt: number | null = null

  if (text.charCodeAt(i) === codeDot) {
    i++
    if (!isDigit(text.charCodeAt(i))) {
      missingDigitAt = i
    } else {
      while (isDigit(text.charCodeAt(i))) {
        i++
      }
    }
  }

  if (missingDigitAt === null) {
    const code = text.charCodeAt(i)
    if (code === codeLowercaseE || code === codeUppercaseE) {
      i++
      if (text.charCodeAt(i) === codeMinus || text.charCodeAt(i) === codePlus) {
        i++
      }
      if (!isDigit(text.charCodeAt(i))) {
        missingDigitAt = i
      } else {
        while (isDigit(text.charCodeAt(i))) {
          i++
        }
      }
    }
  }

  return { consumed: true, end: i, missingDigitAt }
}

/**
 * Analyze a complete number lexeme and return its frozen classification.
 * The function never throws: an invalid lexeme is reported via
 * `valid`/`invalidAt` so callers can keep existing error layers and point at
 * the first offending position of the original input.
 */
export function analyzeNumberLexeme(lexeme: string): NumberLexemeAnalysis {
  const scan = scanNumberLexeme(lexeme, 0)
  const valid =
    scan.consumed && scan.missingDigitAt === null && scan.end === lexeme.length && lexeme.length > 0

  if (!valid) {
    return freeze({
      lexeme,
      valid: false,
      invalidAt: scan.missingDigitAt ?? (scan.consumed ? scan.end : 0),
      isInteger: false,
      negative: false,
      isZero: false,
      isNegativeZero: false,
      significantDigits: '',
      rawExponent: null,
      exponent: 0n
    })
  }

  const negative = lexeme.charCodeAt(0) === codeMinus
  const signOffset = negative ? 1 : 0

  const eIndex = findExponentMark(lexeme, signOffset)
  const mantissa = eIndex === -1 ? lexeme.slice(signOffset) : lexeme.slice(signOffset, eIndex)

  const dotIndex = mantissa.indexOf('.')
  const mantissaDigits = dotIndex === -1 ? mantissa : mantissa.replace('.', '')
  const significantDigits = mantissaDigits.replace(/^0+/, '').replace(/0+$/, '')
  const isZero = significantDigits.length === 0

  let rawExponent: bigint | null = null
  if (eIndex !== -1) {
    rawExponent = parseExponentDigits(lexeme.slice(eIndex + 1))
  }

  const mantissaExponent = BigInt(dotIndex === -1 ? mantissaDigits.length - 1 : dotIndex - 1)
  const exponent = isZero ? 0n : mantissaExponent + (rawExponent ?? 0n)

  return freeze({
    lexeme,
    valid: true,
    invalidAt: null,
    isInteger: dotIndex === -1 && eIndex === -1,
    negative,
    isZero,
    isNegativeZero: negative && isZero,
    significantDigits,
    rawExponent,
    exponent
  })
}

function findExponentMark(lexeme: string, from: number): number {
  const lower = lexeme.indexOf('e', from)
  const upper = lexeme.indexOf('E', from)
  if (lower === -1) {
    return upper
  }
  return upper === -1 ? lower : Math.min(lower, upper)
}

function parseExponentDigits(text: string): bigint {
  let i = 0
  let negative = false
  if (text.charCodeAt(0) === codeMinus) {
    negative = true
    i++
  } else if (text.charCodeAt(0) === codePlus) {
    i++
  }

  let magnitude = 0n
  for (; i < text.length; i++) {
    magnitude = magnitude * 10n + BigInt(text.charCodeAt(i) - codeZero)
  }

  return negative ? -magnitude : magnitude
}

function freeze(analysis: NumberLexemeAnalysis): NumberLexemeAnalysis {
  return Object.freeze(analysis)
}

/**
 * Digits of Number.MAX_SAFE_INTEGER (9007199254740991). Integer safety is
 * decided lexically (length first, lexicographic tie-break) so values outside
 * the safe range are never rounded through Number first.
 */
const MAX_SAFE_INTEGER_DIGITS = '9007199254740991'

/**
 * Test whether a valid integer lexeme is exactly representable as a safe
 * JavaScript integer, using only its decimal text.
 */
export function isSafeIntegerLexeme(analysis: NumberLexemeAnalysis): boolean {
  const digits = analysis.significantDigits
  if (digits.length === 0) {
    return true
  }

  if (digits.length < MAX_SAFE_INTEGER_DIGITS.length) {
    return true
  }

  if (digits.length > MAX_SAFE_INTEGER_DIGITS.length) {
    return false
  }

  return digits <= MAX_SAFE_INTEGER_DIGITS
}

/**
 * Describe why a valid lexeme cannot be represented losslessly as a number,
 * or return undefined when it is safe. The float probe is only consulted for
 * non-integer lexemes; integer safety is already decided from the text.
 */
export function getUnsafeNumberReasonForAnalysis(
  analysis: NumberLexemeAnalysis,
  approx: boolean
): UnsafeNumberReason | undefined {
  if (isSafeNumberAnalysis(analysis, approx)) {
    return undefined
  }

  if (analysis.isInteger) {
    return UnsafeNumberReason.truncate_integer
  }

  const num = Number.parseFloat(analysis.lexeme)
  if (!Number.isFinite(num)) {
    return UnsafeNumberReason.overflow
  }

  if (num === 0) {
    return UnsafeNumberReason.underflow
  }

  return UnsafeNumberReason.truncate_float
}

/**
 * Decide whether a valid lexeme converts to a number without information
 * loss. The decision is a pure function of the immutable analysis.
 */
export function isSafeNumberAnalysis(
  analysis: NumberLexemeAnalysis,
  approx: boolean
): boolean {
  if (analysis.isInteger) {
    return isSafeIntegerLexeme(analysis)
  }

  const num = Number.parseFloat(analysis.lexeme)
  if (!Number.isFinite(num) || num === 0) {
    return false
  }

  if (analysis.lexeme === String(num)) {
    return true
  }

  const parsed = analyzeNumberLexeme(String(num))
  if (analysis.significantDigits === parsed.significantDigits) {
    return true
  }

  if (approx) {
    const requiredDigits = 14
    if (
      parsed.significantDigits.length >= requiredDigits &&
      analysis.significantDigits.startsWith(
        parsed.significantDigits.substring(0, requiredDigits)
      )
    ) {
      return true
    }
  }

  return false
}

/**
 * Map an immutable analysis to the conversion strategy used by
 * {@link LosslessNumber.valueOf}: a plain number, a bigint, or an error with
 * the existing {@link UnsafeNumberReason} classification.
 */
export function decideNumberConversion(
  analysis: NumberLexemeAnalysis,
  approx: boolean
): NumberConversion {
  if (analysis.isInteger) {
    if (isSafeIntegerLexeme(analysis)) {
      return { kind: 'number', value: Number.parseFloat(analysis.lexeme), truncatesFloat: false }
    }

    return { kind: 'bigint', value: BigInt(analysis.lexeme) }
  }

  const value = Number.parseFloat(analysis.lexeme)
  const reason = getUnsafeNumberReasonForAnalysis(analysis, approx)

  if (reason === undefined) {
    return { kind: 'number', value, truncatesFloat: false }
  }

  if (reason === UnsafeNumberReason.truncate_float) {
    return { kind: 'number', value, truncatesFloat: true }
  }

  return { kind: 'error', reason, value }
}
