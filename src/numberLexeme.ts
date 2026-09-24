/**
 * Classification describing why a number cannot be represented as a safe JS
 * number. Defined here (the classification home) and re-exported by utils
 * and the package entry point for backward compatibility.
 */
export enum UnsafeNumberReason {
  underflow = 'underflow',
  overflow = 'overflow',
  truncate_integer = 'truncate_integer',
  truncate_float = 'truncate_float'
}

/**
 * INTERNAL MODULE - not exported from the package entry point.
 *
 * Single source of truth for classifying a JSON number lexeme and deciding how
 * it may be converted (lossless LosslessNumber, JS number, bigint, or reject).
 *
 * Shared by the production paths of all public number-related entry points:
 * - parse()            : scanNumberLexeme() is the ONLY number tokenizer
 * - parseLosslessNumber / LosslessNumber : analyzeNumberLexeme() validates the
 *                         lexeme and decideNumberConversion() decides valueOf()
 * - isLosslessNumber() : recognizes values carrying an immutable analysis
 * - stringify()        : analyzeNumberLexeme() validates custom-stringifier
 *                         output and LosslessNumber output
 *
 * Classification is derived from the raw lexeme string using character and
 * bigint arithmetic only: the analysis never passes the value through Number()
 * or Number.parseInt(), so no precision can be lost before the decision. The
 * single conversion policy lives in decideNumberConversion(); every public
 * entry consumes the same immutable NumberLexeme instead of re-deriving shape
 * with its own regex or coercion.
 */

export type NumberConversionStrategy =
  | 'lossless'
  | 'safe_number'
  | 'bigint'
  | 'truncate_float'
  | 'overflow'
  | 'underflow'

/**
 * Immutable structural analysis of a JSON number lexeme.
 * All fields are derived from the raw text without Number coercion.
 */
export interface NumberLexeme {
  /** original lexeme text, exactly as encountered in the JSON input */
  readonly raw: string
  readonly negative: boolean
  /** true when the lexeme has no fraction and no exponent part */
  readonly isIntegerForm: boolean
  /** true when the lexical form carries an exponent (`e`/`E`) */
  readonly hasExponent: boolean
  /** true when the lexeme has a fractional part */
  readonly hasFraction: boolean
  /** true when the numeric value is zero (0, -0, 0.0, 0e5, ...) */
  readonly isZero: boolean
  /** true when the lexical value is negative zero ("-0", "-0.0", "-0e3") */
  readonly isNegativeZero: boolean
  /** significant digits with leading/trailing zeros removed ("00.50" -> "5") */
  readonly significantDigits: string
  /** count of significant digits */
  readonly significantDigitCount: number
  /**
   * Decimal position of the most significant digit relative to the units
   * place: value ≈ digits[0] * 10**adjustedExponent. Derived with bigint so
   * extreme exponents cannot lose precision.
   */
  readonly adjustedExponent: bigint
}

/** Result of the single conversion policy for an analyzed lexeme. */
export interface NumberConversion {
  readonly strategy: NumberConversionStrategy
  /** legacy classification aligned with UnsafeNumberReason; undefined = safe */
  readonly unsafeReason: UnsafeNumberReason | undefined
  readonly approximateSafe: boolean
}

/** Raw token boundaries produced by the single mechanical scanner. */
export interface ScannedNumber {
  readonly text: string
  /** absolute index of the first lexeme character in the source text */
  readonly offset: number
  /** absolute index just past the last lexeme character */
  readonly end: number
}

/**
 * Syntax error thrown by the shared scanner/analyzer. `offset` points at the
 * first offending character in the ORIGINAL source text (never at a
 * reformatted copy); `partial` is the lexeme text scanned up to the failure.
 */
export class NumberLexemeSyntaxError extends SyntaxError {
  readonly offset: number
  readonly partial: string

  constructor(message: string, offset: number, partial: string) {
    super(message)
    this.name = 'SyntaxError'
    this.offset = offset
    this.partial = Object.freeze(partial)
  }
}

const codeZero = 0x30
const codeNine = 0x39
const codeDot = 0x2e // "."
const codeLowercaseE = 0x65 // "e"
const codeUppercaseE = 0x45 // "E"
const codeMinus = 0x2d // "-"
const codePlus = 0x2b // "+"

function isDigitCode(code: number | undefined): boolean {
  return code !== undefined && code >= codeZero && code <= codeNine
}

function isNumberStartCode(code: number | undefined): boolean {
  return isDigitCode(code) || code === codeMinus
}

/**
 * Scan a JSON number token starting at position `start` in `text`.
 *
 * Returns undefined when the position cannot start a number. This is the ONLY
 * number tokenizer of the parser: its acceptance and error positions must
 * match the JSON grammar enforced by parse() (leading zero not followed by
 * `.`/`e` is an invalid number, etc.).
 *
 * Throws NumberLexemeSyntaxError (with the offset in the original `text`)
 * when a number was started but a required digit is missing.
 */
export function scanNumberLexeme(text: string, start: number): ScannedNumber | undefined {
  if (!isNumberStartCode(text.charCodeAt(start))) {
    return undefined
  }

  const sourceStart = start
  let i = start

  if (text.charCodeAt(i) === codeMinus) {
    i++
    if (!isDigitCode(text.charCodeAt(i))) {
      throw new NumberLexemeSyntaxError('expecting a digit', i, text.slice(sourceStart, i))
    }
  }

  // integer part: a single leading zero stops tokenization, exactly enforcing
  // the JSON grammar (no multi-digit integer starting with zero)
  if (text.charCodeAt(i) === codeZero) {
    i++
  } else if (isDigitCode(text.charCodeAt(i))) {
    i++
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
  }

  if (text.charCodeAt(i) === codeDot) {
    i++
    if (!isDigitCode(text.charCodeAt(i))) {
      throw new NumberLexemeSyntaxError('expecting a digit', i, text.slice(sourceStart, i))
    }
    i++
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
      throw new NumberLexemeSyntaxError('expecting a digit', i, text.slice(sourceStart, i))
    }
    i++
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
  }

  return Object.freeze({
    text: text.slice(sourceStart, i),
    offset: sourceStart,
    end: i
  })
}

const INTEGER_FORM_REGEX = /^-?[0-9]+$/
const JSON_NUMBER_REGEX = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/** Structural test: optional sign followed by digits (allows leading zeros). */
export function hasIntegerForm(lexeme: string): boolean {
  return INTEGER_FORM_REGEX.test(lexeme)
}

/** Structural test: strict JSON number grammar. */
export function isValidNumberLexeme(lexeme: string): boolean {
  return JSON_NUMBER_REGEX.test(lexeme)
}

/**
 * Fully consume `scanned` through the immutable structural analysis.
 * Throws NumberLexemeSyntaxError when the lexeme is not a complete, strict
 * JSON number (trailing characters, leading zeros like "01", ...).
 */
export function analyzeScannedNumber(scanned: ScannedNumber): NumberLexeme {
  const { text, offset } = scanned
  return analyzeLexemeText(text, offset)
}

/**
 * Analyze a complete JSON number lexeme. The lexeme is analyzed in isolation,
 * so the error offset equals the index of the offending character within the
 * lexeme (0 based).
 */
export function analyzeNumberLexeme(raw: string): NumberLexeme {
  return analyzeLexemeText(raw, 0)
}

function analyzeLexemeText(raw: string, baseOffset: number): NumberLexeme {
  const match = raw.match(/^(-)?(?:(0|[1-9][0-9]*))(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/)
  if (!match || raw.length === 0) {
    const badOffset = firstIllegalCharacterOffset(raw)
    throw new NumberLexemeSyntaxError('invalid number lexeme', baseOffset + badOffset, raw)
  }

  const negative = match[1] === '-'
  const integerDigits = match[2]
  const fractionDigits = match[3] ?? ''
  const exponentText = match[4]
  const hasFraction = fractionDigits.length > 0
  const hasExponent = exponentText !== undefined

  const digitsNoDot = integerDigits + fractionDigits
  let isZero = false
  let significantDigits = digitsNoDot.replace(/^0+/, '').replace(/0+$/, '')
  if (significantDigits.length === 0) {
    significantDigits = '0'
    isZero = true
  }

  // Position of the first significant digit relative to the units place,
  // computed entirely with bigint to survive extreme exponents:
  //   123.45    -> 2, 0.0023 -> -3, 2.3e-3 -> -2, 2300 -> 3
  const exponentMagnitude = hasExponent ? BigInt(exponentText as string) : 0n
  const leadingZeros = digitsNoDot.length - digitsNoDot.replace(/^0+/, '').length
  const adjustedExponent = BigInt(integerDigits.length) - 1n + exponentMagnitude - BigInt(leadingZeros)

  const isNegativeZero =
    negative && isZero

  return Object.freeze({
    raw,
    negative,
    isIntegerForm: !hasFraction && !hasExponent,
    hasExponent,
    hasFraction,
    isZero,
    isNegativeZero,
    significantDigits,
    significantDigitCount: significantDigits.length,
    adjustedExponent
  })
}

/** Index of the first character that breaks strict JSON number grammar. */
function firstIllegalCharacterOffset(raw: string): number {
  // mirror the scanner acceptance, then detect where divergence starts
  let i = 0
  if (raw.charCodeAt(i) === codeMinus) {
    i++
  }
  if (raw.charCodeAt(i) === codeZero) {
    i++
  } else if (isDigitCode(raw.charCodeAt(i))) {
    i++
    while (isDigitCode(raw.charCodeAt(i))) {
      i++
    }
  } else {
    return i
  }
  if (raw.charCodeAt(i) === codeDot) {
    i++
    if (!isDigitCode(raw.charCodeAt(i))) {
      return i
    }
    while (isDigitCode(raw.charCodeAt(i))) {
      i++
    }
  } else if (isDigitCode(raw.charCodeAt(i))) {
    // leading zero followed by more digits, e.g. "01"
    return i
  }
  if (raw.charCodeAt(i) === codeLowercaseE || raw.charCodeAt(i) === codeUppercaseE) {
    i++
    if (raw.charCodeAt(i) === codeMinus || raw.charCodeAt(i) === codePlus) {
      i++
    }
    if (!isDigitCode(raw.charCodeAt(i))) {
      return i
    }
    while (isDigitCode(raw.charCodeAt(i))) {
      i++
    }
  }
  return i
}

const MAX_SAFE_INTEGER_DIGITS = '9007199254740991' // Number.MAX_SAFE_INTEGER

/**
 * Structural safe-integer test for an integer-form lexeme. Pure string
 * comparison: never coerces through Number, so precision is preserved.
 * Leading zeros are tolerated for compatibility with utility callers.
 */
export function isSafeIntegerLexeme(lexeme: string): boolean {
  const match = lexeme.match(/^(-)?([0-9]+)$/)
  if (!match) {
    return false
  }

  const digits = match[2].replace(/^0+/, '') || '0'
  if (digits.length < MAX_SAFE_INTEGER_DIGITS.length) {
    return true
  }
  if (digits.length > MAX_SAFE_INTEGER_DIGITS.length) {
    return false
  }

  return digits <= MAX_SAFE_INTEGER_DIGITS
}

/**
 * The single conversion policy. Given the immutable analysis of a lexeme,
 * decide whether the value converts losslessly, to a safe number, to a
 * bigint, or must be rejected/rounded. Classification of magnitude for the
 * extreme ranges (overflow/underflow) is decided structurally from the lexeme
 * before any Number coercion is attempted.
 *
 * `approx` mirrors isSafeNumber({ approx: true }): floats losing only far
 * trailing digits are considered approximately safe.
 */
export function decideNumberConversion(
  lexeme: NumberLexeme,
  config?: { approx?: boolean }
): NumberConversion {
  if (lexeme.isIntegerForm) {
    if (isSafeIntegerLexeme(lexeme.raw)) {
      return frozenDecision('safe_number', undefined, false)
    }
    return frozenDecision('bigint', UnsafeNumberReason.truncate_integer, false)
  }

  if (lexeme.isZero) {
    // "-0" can only be an integer form; decimal/exponent zeros always map to
    // a plain number safely
    return frozenDecision('safe_number', undefined, false)
  }

  const magnitudeExponent = lexeme.adjustedExponent

  // Structural guards for extreme exponents, derived without Number coercion
  if (magnitudeExponent >= 309n) {
    return frozenDecision('overflow', UnsafeNumberReason.overflow, false)
  }
  if (magnitudeExponent < -324n) {
    return frozenDecision('underflow', UnsafeNumberReason.underflow, false)
  }

  const num = Number.parseFloat(lexeme.raw)
  if (!Number.isFinite(num)) {
    return frozenDecision('overflow', UnsafeNumberReason.overflow, false)
  }
  if (num === 0) {
    return frozenDecision('underflow', UnsafeNumberReason.underflow, false)
  }

  if (lexeme.raw === String(num)) {
    return frozenDecision('safe_number', undefined, false)
  }

  const lexemeDigits = lexeme.significantDigits
  const parsedDigits = extractSignificantDigits(String(num))

  if (lexemeDigits === parsedDigits) {
    return frozenDecision('safe_number', undefined, false)
  }

  if (config?.approx === true) {
    const requiredDigits = 14
    if (
      parsedDigits.length >= requiredDigits &&
      lexemeDigits.startsWith(parsedDigits.substring(0, requiredDigits))
    ) {
      return frozenDecision('truncate_float', UnsafeNumberReason.truncate_float, true)
    }
  }

  return frozenDecision('truncate_float', UnsafeNumberReason.truncate_float, false)
}

function frozenDecision(
  strategy: NumberConversionStrategy,
  unsafeReason: UnsafeNumberReason | undefined,
  approximateSafe: boolean
): NumberConversion {
  return Object.freeze({ strategy, unsafeReason, approximateSafe })
}

/**
 * Significant digits of a decimal/float text, shared structural helper
 * (mirrors utils.extractSignificantDigits without a regex split dependency).
 */
function extractSignificantDigits(value: string): string {
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

  const part = value.substring(start, end)
  const dot = part.indexOf('.')
  return dot === -1 ? part : part.substring(0, dot) + part.substring(dot + 1)
}

/** Symbol under which the immutable analysis is stored on a LosslessNumber. */
export const NUMBER_LEXEME = Symbol('lossless-json.number-lexeme')

/**
 * Read the immutable lexical analysis attached to a value produced via
 * parseLosslessNumber. Returns undefined for unbranded values. This is the
 * single accessor used by isLosslessNumber and valueOf, so all entries see
 * the same frozen analysis object.
 */
export function getNumberLexeme(value: unknown): NumberLexeme {
  const holder = (value ?? null) as Record<symbol, NumberLexeme | undefined> | null
  const lexeme = holder?.[NUMBER_LEXEME]
  if (!lexeme) {
    throw new Error('Value is not a lossless number backed by a number lexeme')
  }
  return lexeme
}
