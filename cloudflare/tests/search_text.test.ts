import assert from 'node:assert/strict'
import test from 'node:test'
import { lexicalRelevance, searchTerms } from '../src/model.ts'

test('corrects a common one-letter typo from the catalog vocabulary', () => {
  assert.deepEqual([...searchTerms('малоко')], ['молок'])
})

test('maps a Latin product query to the Russian catalog term', () => {
  assert.deepEqual([...searchTerms('iPhone')], ['смартфон'])
})

test('rare distinguishing words outweigh a shared generic word', () => {
  const query = new Set(['резинов', 'шин'])
  const weights = new Map([['резинов', 2], ['шин', 8]])
  const gloves = lexicalRelevance(query, new Set(['резинов', 'перчатк']), weights)
  const tires = lexicalRelevance(query, new Set(['резинов', 'шин']), weights)
  assert.ok(tires > gloves)
})
