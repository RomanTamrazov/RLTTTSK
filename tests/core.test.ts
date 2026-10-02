import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePurchaseCsv, parseRecords, csvCell, recommendationsCsv } from '../frontend/src/purchaseCsv'
import { parseBudget, safeUrl, contactLinks } from '../frontend/src/presentation'
import { ApiError, type SearchResult, type Supplier } from '../frontend/src/api'
import { initialRows, runPurchaseBatch } from '../frontend/src/batch'
import worker from '../cloudflare/src/index'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { importPurchaseFiles } from '../frontend/src/importPurchases'
const empty: SearchResult = { mode: 'recommendations', candidate_count: 0, category_division: null, recommendations: [],
  parsed_query: { purchase_text: '', okpd2_code: null, customer_inn: null, supplier_inn: null } }
const supplier = { supplier_inn: '7801314509', supplier_name: 'Компания', rank: 1, category_division: '10',
  reasons: ['Профиль'], source: 'Архив', source_url: '', profile_excerpt: 'Поставка рыбы', rank_score: 0,
  history: { participations: 1, wins: 1, category_participations: 1, category_wins: 1, buyer_participations: 0, buyer_wins: 0, buyer_category_wins: 0 },
  enrichment: { phone: '+78127140614', email: 'test@example.ru', website: 'javascript:alert(1)' } } satisfies Supplier
test('CSV: BOM, quoted separators, multiline description and decimal comma', () => {
  const parsed = parsePurchaseCsv('\uFEFFid;description;start_price\r\nA;"Ремонт; техники\nс диагностикой";"450 000,50"\r\n')
  assert.equal(parsed.purchases[0].query, 'Ремонт; техники\nс диагностикой')
  assert.equal(parsed.purchases[0].options.start_price, 450000.5)
  assert.equal(parsed.purchases[0].validationError, undefined)
})
test('CSV: delimiter detection ignores commas inside quoted headers', () => {
  assert.deepEqual(parseRecords('description;"Комментарий, для, нас"\nРемонт;Заметка'), [['description', 'Комментарий, для, нас'], ['Ремонт', 'Заметка']])
})
test('CSV: broken quotes and duplicate aliases are explicit errors', () => {
  assert.throws(() => parsePurchaseCsv('description\n"Ремонт'), /незакрытая/)
  assert.throws(() => parsePurchaseCsv('description;query\nРемонт;Ремонт'), /несколько колонок/)
  assert.throws(() => parsePurchaseCsv('description;description\nРемонт;Ремонт'), /повторяются/)
})
test('CSV: invalid price, INN and row length preserved as row errors', () => {
  const rows = parsePurchaseCsv('id;description;customer_inn;start_price\nA;Ремонт;abc;500\nB;Ремонт;;ошибка\nC;Ремонт;;;лишнее').purchases
  assert.match(rows[0].validationError!, /ИНН/)
  assert.match(rows[1].validationError!, /бюджет/i)
  assert.match(rows[2].validationError!, /Число полей/)
  const csv = recommendationsCsv(['id', 'description', 'customer_inn', 'start_price'], initialRows(rows))
  const records = parseRecords(csv)
  assert.equal(records.length, 4)
  assert.ok(records.every(row => row.length === records[0].length))
  assert.ok(csv.includes('лишнее'))
})
test('CSV: all 200 rows accepted, 201 explicitly rejected', () => {
  const text = 'description\n' + Array(200).fill('Ремонт техники').join('\n')
  assert.equal(parsePurchaseCsv(text).purchases.length, 200)
  assert.throws(() => parsePurchaseCsv(text + '\nРемонт'), /200/)
})
test('CSV export neutralizes spreadsheet formulas and preserves phone text', () => {
  assert.equal(csvCell('=1+2'), "'=1+2")
  assert.equal(csvCell('+78127140614'), "'+78127140614")
  assert.equal(csvCell('  @SUM(A1)'), "'  @SUM(A1)")
})
test('Budget and link validation avoids invented prices or unsafe links', () => {
  assert.equal(parseBudget('450 000,55 ₽'), 450000.55)
  assert.equal(parseBudget(''), undefined)
  assert.throws(() => parseBudget('-10'))
  assert.throws(() => parseBudget('500 тыс'))
  assert.equal(safeUrl('javascript:alert(1)'), undefined)
  assert.equal(contactLinks(supplier).website, undefined)
  assert.equal(contactLinks(supplier).phone?.href, 'tel:+78127140614')
})
test('Batch cancellation retains every purchase and exports its explicit status', async () => {
  const rows = initialRows(parsePurchaseCsv('id;description\nA;Ремонт\nB;Ремонт\nC;Ремонт\nD;Ремонт\nE;Ремонт').purchases)
  const controller = new AbortController()
  const promise = runPurchaseBatch(rows, controller.signal, () => {}, async (_query, signal) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })))
  controller.abort()
  const results = await promise
  assert.equal(results.length, 5)
  assert.ok(results.every(row => row.status === 'cancelled'))
  assert.equal(parseRecords(recommendationsCsv(['id', 'description'], results)).length, 6)
})
test('Batch retries temporary errors; successful rows are retained on resume', async () => {
  const rows = initialRows(parsePurchaseCsv('id;description\nA;Ремонт\nB;Перчатки').purchases)
  let calls = 0
  const results = await runPurchaseBatch(rows, new AbortController().signal, () => {}, async () => {
    calls++
    if (calls === 1) throw new ApiError('Temporary', 503, 1)
    return empty
  })
  assert.equal(calls, 3)
  assert.ok(results.every(row => row.status === 'empty'))
  const resumed = await runPurchaseBatch(results, new AbortController().signal, () => {}, async () => ({ ...empty, recommendations: [supplier] }), [1])
  assert.equal(resumed[0].status, 'empty')
  assert.equal(resumed[1].status, 'done')
  assert.equal(resumed[1].purchase.id, 'B')
})
test('Invalid CSV rows do not send API requests', async () => {
  const rows = initialRows(parsePurchaseCsv('description;start_price\nРемонт;xxx').purchases)
  let calls = 0
  const result = await runPurchaseBatch(rows, new AbortController().signal, () => {}, async () => { calls++; return empty })
  assert.equal(calls, 0); assert.equal(result[0].status, 'error')
})
const DB = { prepare() { return { bind() { return { async all() { return { results: [] } } } } } } }
const env = { DB, ALLOWED_ORIGINS: 'http://localhost:8765' } as never
test('Worker rejects malformed requests and invalid budget before DB work', async () => {
  for (const input of [null, [], { query: 7 }, { query: 'Ремонт', start_price: -1 }, { query: 'Ремонт', start_price: '500' }]) {
    const result = await worker.fetch(new Request('http://localhost/api/search', { method: 'POST', body: JSON.stringify(input) }), env)
    assert.equal(result.status, 422)
  }
})
test('Worker preserves actual budget even with an empty candidate list', async () => {
  const result = await worker.fetch(new Request('http://localhost/api/search', { method: 'POST', body: JSON.stringify({ query: 'Ремонт', start_price: 123456.78 }) }), env)
  const body = await result.json() as SearchResult
  assert.equal(result.status, 200); assert.equal(body.purchase_budget, 123456.78); assert.deepEqual(body.recommendations, [])
})
test('Structured notice text never treats dates or notebook sizes as OKPD2', async () => {
  for (const query of ['Поставка питания с 12.01.26 по 31.01.26', 'Ремонт ноутбука 15.6 дюйма']) {
    const response = await worker.fetch(new Request('http://localhost/api/search', { method: 'POST', body: JSON.stringify({ query, okpd2_code: '10.20.14.120', structured_query: true }) }), env)
    assert.equal(response.status, 200)
    const body = await response.json() as SearchResult
    assert.equal(body.parsed_query.okpd2_code, '10.20.14.120')
    assert.equal(body.parsed_query.purchase_text, query)
  }
})
const inputFile = async (name: string) => {
  const buffer = await readFile('input_samples/' + name)
  return { name, async arrayBuffer() { return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer } }
}
test('Actual test archive imports 38 notices and 670 TRU records by lot_id', { skip: !existsSync('input_samples/test/purchases_1.csv') }, async () => {
  const result = await importPurchaseFiles(await Promise.all(['test/purchases_1.csv', 'test/purchases_2.csv'].map(inputFile)))
  assert.equal(result.purchases.length, 38); assert.equal(result.itemCount, 670)
  assert.ok(result.purchases.every(row => !row.validationError))
  const first = result.purchases.find(row => row.id === '5968880')!
  assert.equal(first.options.start_price, 105188.82)
  assert.ok(first.items!.some(item => item.okpd2_code === '32.50.50.190'))
  assert.equal(first.options.customer_inn, '7808046224')
})
test('Actual final archive imports all 99 notices and repairs its malformed header', { skip: !existsSync('input_samples/final/purchases_1.csv') }, async () => {
  const result = await importPurchaseFiles(await Promise.all(Array.from({ length: 8 }, (_, i) => 'final/purchases_' + (i + 1) + '.csv').map(inputFile)))
  assert.equal(result.purchases.length, 99); assert.equal(result.itemCount, 1468)
  assert.ok(result.purchases.every(row => !row.validationError))
  assert.ok(result.warnings.some(warning => warning.includes('восстановлены')))
  const first = result.purchases.find(row => row.id === '6041774')!
  assert.equal(first.options.customer_inn, '7813131108')
  assert.equal(first.options.start_price, 63600)
  assert.match(first.query, /противодымной/)
  assert.ok(first.items!.length > 0)
})
test('Four TRU CSVs alone group 1468 rows into 99 provisional lots', { skip: !existsSync('input_samples/final/purchases_5.csv') }, async () => {
  const files = await Promise.all(Array.from({ length: 4 }, (_, i) => 'final/purchases_' + (i + 5) + '.csv').map(inputFile))
  const result = await importPurchaseFiles(files)
  assert.equal(result.provisionalOnly, true)
  assert.equal(result.purchases.length, 99)
  assert.equal(result.itemCount, 1468)
  assert.ok(result.purchases.every(row => row.provisional && row.items?.length && !row.validationError))
  assert.equal(result.purchases.find(row => row.id === '6041774')?.options.start_price, undefined)
})
test('TRU alone forms one provisional lot, then a notice supplies verified fields', async () => {
  const provisional = await importPurchaseFiles([awaitableFile])
  assert.equal(provisional.purchases.length, 1)
  assert.equal(provisional.provisionalOnly, true)
  assert.equal(provisional.purchases[0].id, 'A')
  assert.equal(provisional.purchases[0].items?.length, 1)
  assert.equal(provisional.purchases[0].options.okpd2_code, '45.20.2')
  assert.equal(provisional.purchases[0].options.start_price, undefined)
  const notice = { name: 'notices.csv', async arrayBuffer() { return new TextEncoder().encode('lot_id;subject;customer_inn;start_price\nA;Ремонт автоэвакуатора;7801314509;450000').buffer } }
  const merged = await importPurchaseFiles([awaitableFile, notice])
  assert.equal(merged.provisionalOnly, false)
  assert.equal(merged.purchases.length, 1)
  assert.equal(merged.purchases[0].provisional, undefined)
  assert.equal(merged.purchases[0].options.start_price, 450000)
  assert.equal(merged.purchases[0].options.customer_inn, '7801314509')
  assert.equal(merged.purchases[0].items?.length, 1)
})
const awaitableFile = { name: 'tru.csv', async arrayBuffer() { return new TextEncoder().encode('lot_id;product_name;okpd2_code\nA;Ремонт;45.20.2').buffer } }
