import assert from 'node:assert/strict'
import test from 'node:test'
import { parseQuery } from '../src/query.ts'

test('separates purchase quantity and package size from product words', () => {
  assert.deepEqual(parseQuery('закупить 10 000 ампул от гриппа 10мл'), {
    purchase_text: 'закупить ампул от гриппа', okpd2_code: '', customer_inn: '', supplier_inn: '',
    requested_quantity: 10000, quantity_unit: 'ампул', package_size: 10, package_unit: 'мл',
  })
})

test('continues to parse an INN and OKPD2 code', () => {
  assert.deepEqual(parseQuery('медицинские изделия ИНН 7805198740 ОКПД2 32.50.13'), {
    purchase_text: 'медицинские изделия', okpd2_code: '32.50.13', customer_inn: '', supplier_inn: '7805198740',
    requested_quantity: null, quantity_unit: null, package_size: null, package_unit: null,
  })
})

test('preserves decimal product volume and thousands separators', () => {
  const parsed = parseQuery('закупить 10 000 ампул вакцины 0,5 мл')
  assert.equal(parsed.requested_quantity, 10000)
  assert.equal(parsed.package_size, 0.5)
  assert.equal(parsed.package_unit, 'мл')
  assert.match(parsed.purchase_text, /вакцины/)
})
