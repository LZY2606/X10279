/**
 * Unified number lexeme classification and conversion decision.
 *
 * This module is the single source of truth shared by `parse`,
 * `parseLosslessNumber`, `LosslessNumber`, `isLosslessNumber`, `stringify`
 * and the number utility functions. Every numeric lexeme is analyzed once,
 * purely from its textual form: the structural classification is derived
 * lexically (with bigint arithmetic for exponents and integer magnitudes) so
 * that a decision is never based on a precision-losing `Number` intermediate.
 * A `Number` is only produced for the final, explicitly requested float
 * conversion of values that the decision already classified as safe to
 * represent as a float.
 *
 * Analysis results are frozen, stateless value objects: there is no module
 * level cache, counter, or other mutable state, so retries are idempotent and
 * concurrent/sequential calls are fully isolated.
 */
import type { UnsafeNumberReason } from './utils.js'

/**
 * Structural kind of a JSON number lexeme.
 */
export type NumberLexemeKind =
  | 'safe_integer' // lexical integer exactly representable as a safe number
  | 'big_integer' // lexical integer outside the safe integer range
  | 'safe_float' // representable as a Number without information loss
  | 'truncate_float' // finite, non-zero, but digits are truncated as a Number
  | 'overflow' // too large in magnitude to be a finite Number
  | 'underflow' // too small in magnitude to stay a non-zero Number
  | 'invalid' // not a JSON number lexeme

/**
 * The conversion strategy selected once for a lexeme. All public entry points
 * derive their behavior from this strategy, so the decision can never diverge
 * between parsing and serializing.
 */
export enum NumberConversion {
  number = 'number',
  bigint = 'bigint',
  lossless = 'lossless',
  invalid = 'invalid'
}

/**
 * Immutable result of analyzing a number lexeme.
 */
export interface NumberLexemeAnalysis {
  /** The exact lexeme as it occurred in the original input (never reformatted). */
  readonly lexeme: string
  readonly valid: boolean
  readonly kind: NumberLexemeKind
  /** The single conversion decision derived from the lexical classification. */
  readonly conversion: NumberConversion
  /** Undefined when valid; mirrors the historical UnsafeNumberReason otherwise. */
  readonly unsafeReason: `${UnsafeNumberReason}` | undefined
  readonly isIntegerLexeme: boolean
  readonly sign: '-' | ''
  /** Significant decimal digits without sign, dot, exponent or redundant zeros. */
  readonly significantDigits: string
  /** Signed decimal exponent of the canonicalized mantissa (bigint-safe). */
  readonly decimalExponent: bigint
  readonly isZero: boolean
  /** Result of the Number round-trip check; only meaningful for finite floats. */
  readonly roundTrip: boolean
}

const INVALID_ANALYSIS = Object.freeze({
  valid: false,
  kind: 'invalid',
  conversion: NumberConversion.invalid,
  unsafeReason: undefined,
  isIntegerLexeme: false,
  sign: '' as const,
  significantDigits: '',
  decimalExponent: 0n,
  isZero: false,
  roundTrip: false
})

/**
 * Strict JSON number grammar. Equivalent to the historical NUMBER_REGEX, but
 * captures the structural parts needed for a purely lexical decision.
 */
const NUMBER_LEXEME_REGEX = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/

const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER)
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * Analyze a number lexeme and return an immutable decision.
 * Never throws: invalid input is reported via `valid === false`.
 */
export function analyzeNumberLexeme(lexeme: string): NumberLexemeAnalysis {
  const match = NUMBER_LEXEME_REGEX.exec(lexeme)
  if (!match) {
    return freezeInvalid(lexeme)
  }

  const sign = (match[1] ?? '') as '-' | ''
  const integerDigits = match[2] ?? ''
  const fractionDigits = match[3] ?? ''
  const exponentDigits = match[4]

  const isIntegerLexeme = fractionDigits === '' && exponentDigits === undefined

  // Plain integer: decide purely by bigint magnitude, without Number().
  if (isIntegerLexeme) {
    const magnitude = BigInt((sign === '-' ? '-' : '') + integerDigits)
    const isZero = magnitude === 0n
    const safe = magnitude >= MIN_SAFE_INTEGER && magnitude <= MAX_SAFE_INTEGER
    return freeze({
      lexeme,
      valid: true,
      kind: safe ? 'safe_integer' : 'big_integer',
      conversion: safe ? NumberConversion.number : NumberConversion.bigint,
      unsafeReason: undefined,
      isIntegerLexeme: true,
      sign,
      significantDigits: trimDigits(integerDigits),
      decimalExponent: BigInt(integerDigits.length - 1),
      isZero,
      roundTrip: safe
    })
  }

  const significantDigits = trimDigits(integerDigits + fractionDigits)

  // Decimal position of the most significant digit relative to the units.
  let decimalExponent = BigInt(integerDigits.length - 1)
  if (exponentDigits !== undefined) {
    decimalExponent += BigInt(exponentDigits)
  }

  // Zero is recognized lexically (e.g. "0", "-0", "0.0", "0e999999..."):
  // the lexeme never passes through Number to reach this conclusion.
  const isZero = significantDigits === '0' || significantDigits === ''
  if (isZero) {
    return freeze({
      lexeme,
      valid: true,
      kind: 'safe_float',
      conversion: NumberConversion.number,
      unsafeReason: undefined,
      isIntegerLexeme: false,
      sign,
      significantDigits: '0',
      decimalExponent: 0n,
      isZero: true,
      roundTrip: true
    })
  }

  // Float branch. Range is bounded lexically first so extreme exponents are
  // classified without relying on Number coercion of the raw lexeme.
  if (decimalExponent > 309n) {
    return freezeFloat(lexeme, {
      sign,
      significantDigits,
      decimalExponent,
      kind: 'overflow',
      conversion: NumberConversion.lossless,
      unsafeReason: 'overflow',
      roundTrip: false
    })
  }

  if (decimalExponent < -325n) {
    return freezeFloat(lexeme, {
      sign,
      significantDigits,
      decimalExponent,
      kind: 'underflow',
      conversion: NumberConversion.lossless,
      unsafeReason: 'underflow',
      roundTrip: false
    })
  }

  // Boundary exponents and the truncate/safe distinction use the exact
  // double round-trip of the original lexeme. The lexeme is unchanged by this
  // probe and it only runs for finite, non-boundary values.
  const num = Number.parseFloat(lexeme)
  if (!Number.isFinite(num)) {
    return freezeFloat(lexeme, {
      sign,
      significantDigits,
      decimalExponent,
      kind: 'overflow',
      conversion: NumberConversion.lossless,
      unsafeReason: 'overflow',
      roundTrip: false
    })
  }

  if (num === 0) {
    return freezeFloat(lexeme, {
      sign,
      significantDigits,
      decimalExponent,
      kind: 'underflow',
      conversion: NumberConversion.lossless,
      unsafeReason: 'underflow',
      roundTrip: false
    })
  }

  const roundTrip = String(num) === lexeme || significantDigits === trimDigits(String(num))
  if (roundTrip) {
    return freezeFloat(lexeme, {
      sign,
      significantDigits,
      decimalExponent,
      kind: 'safe_float',
      conversion: NumberConversion.number,
      unsafeReason: undefined,
      roundTrip: true
    })
  }

  return freezeFloat(lexeme, {
    sign,
    significantDigits,
    decimalExponent,
    kind: 'truncate_float',
    conversion: NumberConversion.lossless,
    unsafeReason: 'truncate_float',
    roundTrip: false
  })
}

function freezeInvalid(lexeme: string): NumberLexemeAnalysis {
  return Object.freeze({ ...INVALID_ANALYSIS, lexeme }) as NumberLexemeAnalysis
}

interface FloatShape {
  sign: '-' | ''
  significantDigits: string
  decimalExponent: bigint
  kind: NumberLexemeKind
  conversion: NumberConversion
  unsafeReason: `${UnsafeNumberReason}`
  roundTrip: boolean
}

function freezeFloat(lexeme: string, shape: FloatShape): NumberLexemeAnalysis {
  return freeze({
    lexeme,
    valid: true,
    kind: shape.kind,
    conversion: shape.conversion,
    unsafeReason: shape.unsafeReason,
    isIntegerLexeme: false,
    sign: shape.sign,
    significantDigits: shape.significantDigits,
    decimalExponent: shape.decimalExponent,
    isZero: false,
    roundTrip: shape.roundTrip
  })
}

function freeze(analysis: NumberLexemeAnalysis): NumberLexemeAnalysis {
  return Object.freeze(analysis)
}

function trimDigits(digits: string): string {
  let start = 0
  while (start < digits.length && digits.charCodeAt(start) === 48) {
    start++
  }
  if (start === digits.length) {
    return '0'
  }
  let end = digits.length
  while (end > start && digits.charCodeAt(end - 1) === 48) {
    end--
  }
  return digits.slice(start, end)
}

/**
 * Result of scanning a JSON text for the next number lexeme.
 */
export interface ScannedNumberLexeme {
  /** Absolute start offset of the lexeme in the original input. */
  readonly start: number
  /** Exclusive end offset of the lexeme. */
  readonly end: number
  /** The exact slice of the original input. */
  readonly lexeme: string
  /** Offset where a required digit was missing, when the token is malformed. */
  readonly missingDigitAt: number | null
}

/**
 * Scan the JSON number lexeme beginning at `text[start]`, mirroring the JSON
 * grammar enforced by the parser. Returns null when the text does not start a
 * number. A malformed number (missing digit) is returned with
 * `missingDigitAt` so the caller can report the error at the original offset.
 */
export function scanNumberLexeme(text: string, start: number): ScannedNumberLexeme | null {
  let i = start
  const length = text.length
  if (text.charCodeAt(i) !== 45 /* - */ && !isDigitCode(text.charCodeAt(i))) {
    return null
  }

  if (text.charCodeAt(i) === 45) {
    i++
    if (!isDigitCode(text.charCodeAt(i))) {
      return {
        start,
        end: i,
        lexeme: text.slice(start, i),
        missingDigitAt: i
      }
    }
  }

  if (text.charCodeAt(i) === 48 /* 0 */) {
    i++
  } else {
    i++
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
  }

  if (text.charCodeAt(i) === 46 /* . */) {
    i++
    if (!isDigitCode(text.charCodeAt(i))) {
      return {
        start,
        end: i,
        lexeme: text.slice(start, i),
        missingDigitAt: i
      }
    }
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
  }

  if (text.charCodeAt(i) === 101 /* e */ || text.charCodeAt(i) === 69 /* E */) {
    i++
    if (text.charCodeAt(i) === 45 /* - */ || text.charCodeAt(i) === 43 /* + */) {
      i++
    }
    if (!isDigitCode(text.charCodeAt(i))) {
      return {
        start,
        end: i,
        lexeme: text.slice(start, i),
        missingDigitAt: i
      }
    }
    while (isDigitCode(text.charCodeAt(i))) {
      i++
    }
  }

  return {
    start,
    end: i,
    lexeme: text.slice(start, i),
    missingDigitAt: null
  }
}

function isDigitCode(code: number | undefined): boolean {
  return code !== undefined && code >= 48 && code <= 57
}
