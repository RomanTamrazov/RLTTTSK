import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parsePurchaseCsv } from '../src/purchaseCsv.ts'

test('template header is recognized, including okpd2_code', async () => {
  const source = await readFile(new URL('../src/purchaseCsv.ts', import.meta.url), 'utf8')
  const template = source.match(/const content = '([^']+)'/)?.[1]
  assert.ok(template)
  const csv = template.replaceAll('\\uFEFF', '\uFEFF').replaceAll('\\r\\n', '\r\n')
  const parsed = parsePurchaseCsv(csv)
  assert.equal(parsed.purchases.length, 2)
  assert.equal(parsed.purchases[0].options.okpd2_code, '41.20.40')
})

test('accepts a row with only an OKPD2 code', () => {
  const parsed = parsePurchaseCsv('okpd2_code\n41.20.40')
  assert.equal(parsed.purchases[0].query, 'ОКПД2 41.20.40')
  assert.equal(parsed.purchases[0].options.okpd2_code, '41.20.40')
})

test('recognizes Russian headers and preserves the purchase ID', () => {
  const parsed = parsePurchaseCsv('Номер закупки;Описание закупки;Код ОКПД2;ИНН заказчика;НМЦК\nA-17;Ремонт школы;41.20.40;7707083893;1500')
  assert.equal(parsed.purchases[0].id, 'A-17')
  assert.equal(parsed.purchases[0].query, 'Ремонт школы')
  assert.equal(parsed.purchases[0].options.customer_inn, '7707083893')
})

test('parses a quoted delimiter and embedded newline', () => {
  const parsed = parsePurchaseCsv('id;description\n1;"Поставка, монтаж;\nоборудования"')
  assert.equal(parsed.purchases.length, 1)
  assert.equal(parsed.purchases[0].query, 'Поставка, монтаж;\nоборудования')
})

test('parses a spaced price with a comma decimal separator', () => {
  const parsed = parsePurchaseCsv('description;start_price\nМолоко;"15 000,50"')
  assert.equal(parsed.purchases[0].options.start_price, 15000.5)
})

test('rejects an empty file and a header-only file clearly', () => {
  assert.throws(() => parsePurchaseCsv(''), /строка с названиями колонок/)
  assert.throws(() => parsePurchaseCsv('description\n'), /нет строк закупок/)
})

test('enforces the 200-row batch limit', () => {
  const csv = ['description', ...Array.from({ length: 201 }, (_, i) => `Закупка ${i + 1}`)].join('\n')
  assert.throws(() => parsePurchaseCsv(csv), /до 200 закупок/)
})
