import { LosslessNumber } from './LosslessNumber.js'
import { analyzeNumberLexeme } from './numberLexeme.js'
import { isInteger } from './utils.js'

export function parseLosslessNumber(value: string): LosslessNumber {
  return new LosslessNumber(value)
}

export function parseNumberAndBigInt(value: string): number | bigint {
  const analysis = analyzeNumberLexeme(value)
  const integer = analysis.valid ? analysis.isInteger : isInteger(value)

  return integer ? BigInt(value) : Number.parseFloat(value)
}
