import assert from 'node:assert'
import { Bench } from 'tinybench'
import { parse, stringify } from '../../lib/esm/index.js'

const text = generateText()
console.log(`Document size: ${Math.round(text.length / 1024)} kB`)

const json = JSON.parse(text)
const losslessJSON = parse(text)

assert.deepStrictEqual(JSON.parse(stringify(losslessJSON)), json)
assert.deepStrictEqual(parseWithBigInt(text), json)
assert.deepStrictEqual(parseWithBigInt('{"number":1.23,"int":42,"bigint":9123372036854000123}'), {
  number: 1.23,
  int: 42,
  bigint: 9123372036854000123n
})

const bench = new Bench({ time: 100 })
  .add('        JSON.parse    ', () => JSON.parse(text))
  .add('LosslessJSON.parse    ', () => parse(text))
  .add('parseWithBigInt       ', () => parseWithBigInt(text))
  .add('        JSON.stringify', () => JSON.stringify(json))
  .add('LosslessJSON.stringify', () => stringify(losslessJSON))

await bench.run()

console.table(bench.table())

/**
 * create a JSON document containing all different things that JSON can have:
 * - nested objects and arrays
 * - strings (with control chars and unicode)
 * - numbers (various notations)
 * - boolean
 * - null
 * - indentation and newlines
 */
function generateText(itemCount = 100) {
  const json = [...new Array(itemCount)].map((_value, index) => {
    return {
      id: index,
      name: `Item ${index}`,
      details: {
        description: 'Here we try out control characters and unicode',
        newline: 'Some text with a newline \n',
        tab: 'Some text with a tab \t',
        unicode: 'Test with unicode characters 😀,💩',
        'escaped double quote': '"abc"',
        'unicode double quote': '\u0022abc\u0022'
      },
      isTrue: true,
      isFalse: false,
      isNull: null,
      values: [1, 2.44481, 23.33e4, -5.71, 500023105]
    }
  })

  return JSON.stringify(json, null, 2)
}

function parseWithBigInt(text) {
  const intRegex = /^\d+$/

  return JSON.parse(text, (_key, value, context) => {
    const isBigInt =
      typeof value === 'number' &&
      (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) &&
      intRegex.test(context.source)

    return isBigInt ? BigInt(context.source) : value
  })
}
