import { LosslessNumber } from './LosslessNumber.js'
import { analyzeNumberLexeme } from './utils.js'

export function parseLosslessNumber(value: string): LosslessNumber {
  return new LosslessNumber(value)
}

export function parseNumberAndBigInt(value: string): number | bigint {
  return analyzeNumberLexeme(value).isInteger ? BigInt(value) : Number.parseFloat(value)
}
