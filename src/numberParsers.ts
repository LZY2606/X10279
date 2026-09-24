import { LosslessNumber } from './LosslessNumber.js'
import { analyzeNumberLexeme } from './utils.js'

export function parseLosslessNumber(value: string): LosslessNumber {
  return new LosslessNumber(value)
}

export function parseNumberAndBigInt(value: string): number | bigint {
  const analysis = analyzeNumberLexeme(value)
  return analysis.isInteger ? BigInt(value) : analysis.floatValue
}
