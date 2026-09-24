import { LosslessNumber } from './LosslessNumber.js'
import { isValidNumberLexeme, analyzeNumberLexeme, NumberConversionStrategy } from './numberLexeme.js'
import { isInteger } from './utils.js'

export function parseLosslessNumber(value: string): LosslessNumber {
  return new LosslessNumber(value)
}

export function parseNumberAndBigInt(value: string): number | bigint {
  if (!isValidNumberLexeme(value)) {
    // Preserve the historical lenient behavior for direct calls with strings
    // that did not originate from the JSON parser.
    return isInteger(value) ? BigInt(value) : Number.parseFloat(value)
  }

  const analysis = analyzeNumberLexeme(value)
  return analysis.isInteger && analysis.strategy === NumberConversionStrategy.bigint
    ? BigInt(value)
    : Number.parseFloat(value)
}
