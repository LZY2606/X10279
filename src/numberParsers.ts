import { LosslessNumber } from './LosslessNumber.js'
import { isInteger } from './utils.js'

/**
 * Default number parser used by `parse`. The lexeme handed over by the
 * parser has already been tokenized with the shared number-lexeme grammar;
 * the LosslessNumber constructor then classifies it once through the same
 * immutable analysis used by isLosslessNumber and stringify.
 */
export function parseLosslessNumber(value: string): LosslessNumber {
  return new LosslessNumber(value)
}

export function parseNumberAndBigInt(value: string): number | bigint {
  return isInteger(value) ? BigInt(value) : Number.parseFloat(value)
}
