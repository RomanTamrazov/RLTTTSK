import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import worker from '../.local-build/worker.mjs'
const db = new DatabaseSync(fileURLToPath(new URL('../cloudflare/generated/local.sqlite', import.meta.url)), { readOnly: true })
const DB = {
  prepare(sql) {
    return { bind(...values) { return { async all() { return { results: db.prepare(sql).all(...values) } } } } }
  }
}
const cases = ['ремонт автоэвакуатора ОКПД2 45.20.2', 'медицинские перчатки', 'рыбные консервы', 'ИНН 7801314509', 'ОКПД2 45.20.2', 'квантовый телепортатор', 'создание водородной бомбы']
const report = []
for (const query of cases) {
  const time = performance.now()
  const response = await worker.fetch(new Request('http://localhost/api/search', { method: 'POST', body: JSON.stringify({ query, start_price: 450000, top_k: 5 }) }), { DB, ALLOWED_ORIGINS: '' })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.purchase_budget, 450000)
  assert.ok(result.recommendations.length <= 5)
  if (query === 'квантовый телепортатор' || query === 'создание водородной бомбы') {
    assert.equal(result.recommendations.length, 0, `Unrelated query must not produce recommendations: ${query}`)
  }
  if (query.startsWith('ремонт автоэвакуатора')) {
    assert.ok(result.recommendations.length > 0)
    assert.ok(result.recommendations.every(s => /(?:авто)?эвакуатор/i.test(s.profile_excerpt)),
      'A specialist must not be lost to the truncated category posting and replaced with generic repair firms')
  }
  for (const supplier of result.recommendations) {
    assert.match(supplier.supplier_inn, /^\d{10}(?:\d{2})?$/)
    assert.equal(supplier.pricing.status, 'on_request')
    assert.ok(Array.isArray(supplier.history_examples))
    assert.ok(supplier.history_examples.length <= 6)
    for (const example of supplier.history_examples) {
      assert.match(example.lot_id, /^\d+$/)
      assert.match(example.publish_date, /^202[45]-\d\d-\d\d$/)
      assert.ok(example.channel === 'ЭМ' || example.channel === 'АИС ГЗ')
      if (example.channel === 'АИС ГЗ') assert.equal(example.em_winner, null)
      if (example.channel === 'ЭМ') assert.equal(typeof example.em_winner, 'boolean')
      if (example.customer_inn) assert.match(example.customer_inn, /^\d{10}(?:\d{2})?$/)
    }
    const historical = supplier.pricing.historical_purchase
    if (historical) {
      const rows = db.prepare('SELECT value FROM store WHERE key >= ? AND key < ? ORDER BY key').all('s:' + supplier.supplier_inn + ':', 's:' + supplier.supplier_inn + ';')
      const profile = JSON.parse(rows.map(row => row.value).join(''))
      assert.ok(profile.catalog[supplier.category_division].price_examples.some(row => row.lot_id === historical.lot_id && row.start_price === historical.start_price))
      assert.ok(historical.start_price > 0 && historical.start_price <= 1e9)
    }
  }
  report.push({ query, ms: Math.round(performance.now() - time), candidate_count: result.candidate_count,
    top: result.recommendations.map(s => ({ inn: s.supplier_inn, name: s.supplier_name, phone: s.enrichment?.phone,
      historical_budget: s.pricing.historical_purchase?.start_price, historical_lot: s.pricing.historical_purchase?.lot_id })) })
}
db.close()
await mkdir(new URL('../qa/', import.meta.url), { recursive: true })
await writeFile(new URL('../qa/integration.json', import.meta.url), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
