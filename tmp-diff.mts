import { analyzeNumberLexeme } from './src/numberLexeme'

const cases = [
  '0','0.0','-0','-0.0','0e+2','2.3','23','-2','2300e3','2300e+3','2.3e100','42e+4','42E-4',
  '-42E-4','2.3e500','123456789012345678901234567890','2e500','-2e500','2e-500',
  '0.66666666666666666667','12345678901234567890','0.30000000000000000004',
  '10038000307000729','1.2345678901234567890','0.99999999999999999','2.300',
  '9007199254740991','9007199254740992','9007199254740993','-9007199254740991',
  '-9007199254740992','-9007199254740993','2.3e4','-2.3e4','1234567890',
  '0.30000000000000004','0.9999999999999999','1e500','1e-500','123',
  '0.666666667','23.4','23e4','0.66666666666666666666667','123456789012345678901234',
  '1e308','1e309','1e-323','1e-324','2e-324','5e-324','5e-325','1e100000','1e-100000',
  '9007199254740993e0','123e-2','123e-3','1.23e2','-1.23e2','0.0000000000000000000001',
  '100000000000000000000','100000000000000000000e0','0e99','-0e99','-0.0e-2'
]

// old semantics replica
function extractSignificantDigitsOld(value: string): string {
  let start = 0
  if (value[0] === '-') start++
  while (value[start] === '0' || value[start] === '.') start++
  let end = value.lastIndexOf('e')
  if (end === -1) end = value.lastIndexOf('E')
  if (end === -1) end = value.length
  while ((value[end - 1] === '0' || value[end - 1] === '.') && end > start) end--
  const d = value.substring(start, end)
  const dot = d.indexOf('.')
  return dot === -1 ? d : d.substring(0, dot) + d.substring(dot + 1)
}
const INTEGER = /^-?[0-9]+$/
function oldReason(v: string): string {
  const isInt = INTEGER.test(v)
  let safe: boolean
  if (isInt) {
    safe = Number.isSafeInteger(Number.parseInt(v, 10))
  } else {
    const num = Number.parseFloat(v)
    const parsed = String(num)
    if (v === parsed) safe = true
    else safe = extractSignificantDigitsOld(v) === extractSignificantDigitsOld(parsed)
  }
  if (safe) return 'safe'
  if (isInt) return 'truncate_integer'
  const num = Number.parseFloat(v)
  if (!Number.isFinite(num)) return 'overflow'
  if (num === 0) return 'underflow'
  return 'truncate_float'
}

const map: Record<string, string> = {
  number: 'safe', bigint: 'truncate_integer', overflow: 'overflow',
  underflow: 'underflow', truncate_float: 'truncate_float'
}

let diffs = 0
for (const c of cases) {
  const l = analyzeNumberLexeme(c)
  const got = map[l.conversion]
  const want = oldReason(c)
  if (got !== want) {
    diffs++
    console.log(`DIFF ${c}: got=${got} want=${want} decExp=${l.decimalExponent}`)
  }
}
console.log(diffs === 0 ? 'ALL MATCH' : `${diffs} diffs`)
