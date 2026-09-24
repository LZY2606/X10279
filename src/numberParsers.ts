import { LosslessNumber } from './LosslessNumber.js'
import { analyzeNumberLexeme, NumberConversion, type NumberLexemeAnalysis } from './numberLexeme.js'

/**
 * Default number parser: keep the numeric value lossless as a LosslessNumber.
 *
 * The optional second argument is INTERNAL: the parser passes the immutable
 * `NumberLexemeAnalysis` it already produced while scanning the lexeme, so the
 * decision is computed exactly once per lexeme. It is not part of the public
 * `NumberParser` signature and cannot be forged into a LosslessNumber: callers
 * only ever get a real instance whose analysis matches its textual value.
 */
export function parseLosslessNumber(
  value: string,
  analysis?: NumberLexemeAnalysis
): LosslessNumber {
  const resolvedAnalysis = analysis ?? analyzeNumberLexeme(value)
  return new LosslessNumber(value, resolvedAnalysis)
}

export function parseNumberAndBigInt(value: string): number | bigint {
  const analysis = analyzeNumberLexeme(value)
  return analysis.isIntegerLexeme && analysis.conversion === NumberConversion.number
    ? Number.parseInt(value, 10)
    : analysis.isIntegerLexeme
      ? BigInt(value)
      : Number.parseFloat(value)
}
