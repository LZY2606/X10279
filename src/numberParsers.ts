import { LosslessNumber } from './LosslessNumber.js'
import { analyzeNumberLexeme } from './numberLexeme.js'
import { isInteger } from './utils.js'

/**
 * Default number parser for parse(): produces a LosslessNumber carrying the
 * immutable lexeme analysis shared with isLosslessNumber, valueOf and
 * stringify.
 */
export function parseLosslessNumber(value: string): LosslessNumber {
  return new LosslessNumber(value)
}

/**
 * Built-in alternative number parser: bigint for integer lexemes, JS number
 * otherwise. The integer/float classification comes from the same structural
 * lexeme analysis used everywhere else, and the analysis runs before any
 * Number coercion.
 */
export function parseNumberAndBigInt(value: string): number | bigint {
  if (isInteger(value)) {
    return BigInt(value)
  }

  analyzeNumberLexeme(value)
  return Number.parseFloat(value)
}
