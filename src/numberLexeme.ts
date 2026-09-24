/**
 * Unified number lexeme classification and conversion decisions.
 *
 * This module is the single source of truth for what a JSON number lexeme is
 * and how it must be converted. It is intentionally stateless: every call to
 * {@link analyzeNumberLexeme} returns a fresh, frozen {@link NumberLexeme} and
 * no caches, counters or other mutable module state are kept. Every production
 * entry point (parse/parseLosslessNumber/LosslessNumber/isLosslessNumber and
 * the validation used by stringify) funnels its numeric decisions through
 * {@link analyzeNumberLexeme}, so the conversion strategy can never diverge
 * from the lexical classification.
 *
 * Classification itself is derived from the raw lexeme text (sign, digits,
 * decimal point and exponent) and never from a lossy `Number` first: structural
 * decisions (validity, integer-ness, safe integer boundaries, extreme exponent
 * overflow/underflow, zero) are computed with strings/integers only. A floating
 * point probe is used only for the in-range decimal truncation decision, which
 * is the step that is allowed to produce a `Number`.
 *
 * @internal Not re-exported from the package root; it is the shared backbone of
 * the production path and is imported directly by tests that guard its
 * invariants. It is not a separate, test-only algorithm.
 */

/** Why a lexeme cannot be represented losslessly as a JavaScript `number`. */
export enum UnsafeNumberReason {
  underflow = 'underflow',
  overflow = 'overflow',
  truncate_integer = 'truncate_integer',
  truncate_float = 'truncate_float'
}

/**
 * Immutable result of classifying a JSON number lexeme.
 */
export interface NumberLexeme {
  /** The exact lexeme as it occurred in the source JSON. */
  readonly lexeme: string
  /** Zero based offset of the lexeme in the source input. */
  readonly position: number
  /** Sign of the number: '' for non-negative, '-' for negative. */
  readonly sign: '' | '-'
  /** All significant digits with leading/trailing zero padding removed. */
  readonly significantDigits: string
  /**
   * Position of the decimal point relative to the significant digits:
   * `10 ** (decimalExponent - 1)` is the place value of the first digit.
   * May be `Number.POSITIVE_INFINITY` / `Number.NEGATIVE_INFINITY` for an
   * exponent that overflows integer parsing; such values are classified
   * structurally without ever being rounded first.
   */
  readonly decimalExponent: number
  /** Explicit exponent marker was present in the lexeme (e/E). */
  readonly hasExponentMarker: boolean
  /** A decimal point was present in the lexeme (e.g. `1.0`). */
  readonly hasFraction: boolean
  /** The lexeme denotes zero (`0`, `-0`, `0.000`, `0e99`, ...). */
  readonly isZero: boolean
  /**
   * Integer lexeme without an exponent marker, per the historical meaning of
   * {@link import('./utils.js').isInteger}.
   */
  readonly isPlainInteger: boolean
  /** The value is an integer and within the JavaScript safe integer range. */
  readonly isSafeInteger: boolean
  /** The raw text round-trips (or only differs in insignificant zero padding)
   * through a JavaScript `number` without changing the numeric value. */
  readonly roundsSafelyToNumber: boolean
  /** A `Number` probe of the lexeme, `Infinity`/`-Infinity` for overflow. */
  readonly floatValue: number
  /** The single conversion decision derived from this classification. */
  readonly conversion: NumberConversion
}

export enum NumberConversion {
  /** Convert to a normal JavaScript number without information loss. */
  number = 'number',
  /** Convert to a JavaScript `bigint` (integer beyond the safe range). */
  bigint = 'bigint',
  /** Numeric value rounds away (`Infinity`/`-Infinity`). */
  overflow = 'overflow',
  /** Numeric value rounds to a non-representable zero. */
  underflow = 'underflow',
  /** Decimal digits would be truncated (value stays approximately equal). */
  truncate_float = 'truncate_float'
}

/** Syntax error enriched with the offending lexeme and its source position. */
export class NumberLexemeSyntaxError extends SyntaxError {
  readonly lexeme: string
  readonly position: number

  constructor(message: string, lexeme: string, position: number) {
    super(message)
    this.name = 'SyntaxError'
    this.lexeme = lexeme
    this.position = position
  }
}

interface ScanResult {
  end: number
  sign: '' | '-'
  hasFraction: boolean
  hasExponentMarker: boolean
  intDigits: string
  fracDigits: string
  expSign: '' | '+' | '-'
  expDigits: string
}

const DIGIT_ZERO = 48
const DIGIT_NINE = 57
const CODE_DOT = 46
const CODE_PLUS = 43
const CODE_MINUS = 45
const CODE_E_LOWER = 101
const CODE_E_UPPER = 69

function isDigitCode(code: number | undefined): boolean {
  return code !== undefined && code >= DIGIT_ZERO && code <= DIGIT_NINE
}

/**
 * Scan one complete JSON number lexeme strictly following the JSON grammar.
 * Returns the end offset and the captured lexeme parts.
 */
function scanNumber(text: string, start: number): ScanResult {
  let i = start

  let sign: '' | '-' = ''
  if (text.charCodeAt(i) === CODE_MINUS) {
    sign = '-'
    i++
    if (!isDigitCode(text.charCodeAt(i))) {
      fail(text, start, i)
    }
  }

  let intDigits = ''
  if (text.charCodeAt(i) === DIGIT_ZERO) {
    intDigits = '0'
    i++
  } else if (isDigitCode(text.charCodeAt(i))) {
    const first = i
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
    intDigits = text.slice(first, i)
  } else {
    fail(text, start, i)
  }

  let hasFraction = false
  let fracDigits = ''
  if (text.charCodeAt(i) === CODE_DOT) {
    hasFraction = true
    i++
    const first = i
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
    if (i === first) {
      fail(text, start, i)
    }
    fracDigits = text.slice(first, i)
  }

  let hasExponentMarker = false
  let expSign: '' | '+' | '-' = ''
  let expDigits = ''
  const eCode = text.charCodeAt(i)
  if (eCode === CODE_E_LOWER || eCode === CODE_E_UPPER) {
    hasExponentMarker = true
    i++
    if (text.charCodeAt(i) === CODE_MINUS || text.charCodeAt(i) === CODE_PLUS) {
      expSign = text[i] as '+' | '-'
      i++
    }
    const first = i
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
    if (i === first) {
      fail(text, start, i)
    }
    expDigits = text.slice(first, i)
  }

  return { end: i, sign, hasFraction, hasExponentMarker, intDigits, fracDigits, expSign, expDigits }
}

function fail(text: string, start: number, at: number): never {
  throw new NumberLexemeSyntaxError(
    `Invalid number '${text.slice(start, at)}' at position ${at}`,
    text.slice(start, at),
    at
  )
}

/**
 * Parse an exponent text without any precision loss: exponents that overflow
 * the safe integer range collapse to the matching signed infinity, so callers
 * can classify overflow/underflow structurally instead of via a rounded value.
 */
function parseCappedExponent(sign: '' | '+' | '-', digits: string): number {
  const trimmed = digits.replace(/^0+/, '') || '0'
  // 2 ** 53 - 1 has 16 digits; anything at least that magnitude is far beyond
  // the representable decimal range of a JavaScript number either way.
  if (trimmed.length > 16) {
    return sign === '-' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  }
  const value = Number.parseInt(trimmed, 10)
  if (value > Number.MAX_SAFE_INTEGER) {
    return sign === '-' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  }
  return sign === '-' ? -value : value
}

const MAX_SAFE_INTEGER_DIGITS = '9007199254740991'
const MIN_SAFE_INTEGER_DIGITS = '9007199254740991' // compared without the sign

function withinSafeIntegerRange(sign: '' | '-', digitString: string): boolean {
  if (digitString.length < MAX_SAFE_INTEGER_DIGITS.length) {
    return true
  }
  if (digitString.length > MAX_SAFE_INTEGER_DIGITS.length) {
    return false
  }
  const bound = sign === '-' ? MIN_SAFE_INTEGER_DIGITS : MAX_SAFE_INTEGER_DIGITS
  return digitString <= bound
}

/** Significant digits, ported from the pre-existing text-based extraction. */
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
 * Analyze a JSON number lexeme and produce the immutable classification and
 * conversion decision used by every public numeric entry point.
 *
 * @param lexeme the exact number text (must be a complete JSON number)
 * @param position zero based offset of the lexeme in the original input
 * @throws {@link NumberLexemeSyntaxError} (a `SyntaxError`) with the first
 * invalid position when the text is not a valid JSON number.
 */
export function analyzeNumberLexeme(lexeme: string, position = 0): NumberLexeme {
  const scan = scanNumber(lexeme, 0)
  if (scan.end !== lexeme.length) {
    fail(lexeme, 0, scan.end)
  }

  const { sign, hasFraction, hasExponentMarker, intDigits, fracDigits, expSign, expDigits } = scan

  const significantDigits = (intDigits + fracDigits).replace(/^0+/, '').replace(/0+$/, '')
  const isZero = significantDigits.length === 0
  const significant = isZero ? '0' : significantDigits

  const writtenExponent = hasExponentMarker ? parseCappedExponent(expSign, expDigits) : 0
  // decimal exponent of the first significant digit; mirrors splitNumber
  let decimalExponent: number
  if (isZero) {
    decimalExponent = 0
  } else {
    const firstSignificant = (intDigits + fracDigits).search(/[1-9]/)
    decimalExponent =
      firstSignificant < intDigits.length
        ? intDigits.length - 1 - firstSignificant
        : -(firstSignificant - intDigits.length + 1)
    if (Number.isFinite(writtenExponent)) {
      decimalExponent += writtenExponent
    } else {
      decimalExponent = writtenExponent
    }
  }

  const isPlainInteger =
    !hasFraction &&
    !hasExponentMarker &&
    /^0$|^[1-9]\d*$/.test(intDigits)

  let conversion: NumberConversion
  let isSafeInteger = false
  let roundsSafelyToNumber = false

  if (isZero) {
    conversion = NumberConversion.number
    roundsSafelyToNumber = true
    isSafeInteger = isPlainInteger
  } else if (isPlainInteger) {
    isSafeInteger = withinSafeIntegerRange(sign, intDigits)
    conversion = isSafeInteger ? NumberConversion.number : NumberConversion.bigint
  } else {
    // non-plain-integer: decimal or exponent notation. Structural extremes are
    // decided without touching Number; in-range values use one Number probe
    // only for the truncation decision (the conversion step).
    if (decimalExponent > 308) {
      conversion = NumberConversion.overflow
    } else if (decimalExponent < -324) {
      conversion = NumberConversion.underflow
    } else {
      const numericValue = Number.parseFloat(lexeme)
      const parsedDigits = extractSignificantDigits(String(numericValue))
      if (!Number.isFinite(numericValue)) {
        conversion = NumberConversion.overflow
      } else if (numericValue === 0) {
        conversion = NumberConversion.underflow
      } else if (lexeme === String(numericValue) || significant === parsedDigits) {
        conversion = NumberConversion.number
        roundsSafelyToNumber = true
      } else {
        conversion = NumberConversion.truncate_float
      }
    }
  }

  const floatValue = Number.parseFloat(lexeme)

  return Object.freeze({
    lexeme,
    position,
    sign,
    significantDigits: significant,
    decimalExponent,
    hasExponentMarker,
    hasFraction,
    isZero,
    isPlainInteger,
    isSafeInteger,
    roundsSafelyToNumber,
    floatValue,
    conversion
  })
}

/** Whether a lexeme is a valid complete JSON number. */
export function isValidNumberLexeme(lexeme: string): boolean {
  try {
    analyzeNumberLexeme(lexeme)
    return true
  } catch (error) {
    if (error instanceof SyntaxError) {
      return false
    }
    throw error
  }
}
