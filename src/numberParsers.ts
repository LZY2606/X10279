import { LosslessNumber } from './LosslessNumber.js'
import { analyzeNumber, type NumberLexeme } from './numberLexeme.js'

export function parseLosslessNumber(value: string): LosslessNumber {
  return new LosslessNumber(value)
}

/**
 * Internal entry used by the parser: the parser has already scanned and
 * classified the lexeme while tokenizing the input, so it hands its immutable
 * analysis straight to the LosslessNumber instead of re-scanning the text.
 *
 * Not exported from the package index. The result is identical to
 * `parseLosslessNumber(lexeme.text)`; only the duplicate analysis is avoided.
 */
export function losslessNumberFromLexeme(lexeme: NumberLexeme): LosslessNumber {
  return LosslessNumber.fromLexeme(lexeme)
}

/**
 * Parse a number into a plain number or bigint. The choice comes from the same
 * immutable lexical analysis used everywhere else.
 */
export function parseNumberAndBigInt(value: string): number | bigint {
  const lexeme = analyzeNumber(value)
  // Documented behavior: every integer lexeme (even a safe one like `123`)
  // becomes a bigint, while decimal/exponent lexemes become a number.
  return lexeme.kind === 'integer' ? BigInt(lexeme.text) : Number.parseFloat(lexeme.text)
}
