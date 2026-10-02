import { parseRecords, parsePurchaseCsv, type PurchaseRow } from './purchaseCsv'
import type { SearchOptions } from './api'
import { parseBudget } from './presentation'

export interface LotItem { product_name: string; okpd2_code: string }
export interface PurchaseFile { name: string; arrayBuffer(): Promise<ArrayBuffer> }
export interface ImportedPurchases {
  headers: string[]; purchases: PurchaseRow[]; warnings: string[]; itemCount: number; files: string[]; provisionalOnly: boolean
}
const norm = (text: string) => text.toLowerCase().replace(/[\s_]/g, '')
const indexOf = (headers: string[], names: string[]) => headers.findIndex(h => names.some(n => norm(h) === norm(n)))
export async function importPurchaseFiles(files: PurchaseFile[]): Promise<ImportedPurchases> {
  if (!files.length) throw new Error('Выберите CSV-файлы.')
  if (files.length > 12) throw new Error('Выберите не больше 12 CSV-файлов за один раз.')
  const warnings: string[] = [], purchases: PurchaseRow[] = [], itemMap = new Map<string, LotItem[]>()
  const itemSources = new Map<string, { name: string; rowNumber: number }>()
  const sources: { headers: string[]; rows: string[][]; name: string }[] = []
  let itemCount = 0, totalBytes = 0
  for (const file of files) {
    const bytes = await file.arrayBuffer(); totalBytes += bytes.byteLength
    if (bytes.byteLength > 5 * 1024 * 1024 || totalBytes > 20 * 1024 * 1024) throw new Error('Лимит: 5 МБ на файл и 20 МБ на весь набор.')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { text = new TextDecoder('windows-1251').decode(bytes); warnings.push(file.name + ': прочитан в кодировке Windows-1251.') }
    const [rawHeaders = [], ...rows] = parseRecords(text)
    let headers = rawHeaders
    const broken = headers.findIndex(h => h === 'reqnum;procedure_name')
    if (broken >= 0 && rows.every(row => row.length === headers.length + 1)) {
      headers = [...headers.slice(0, broken), 'reqnum', 'procedure_name', ...headers.slice(broken + 1)]
      warnings.push(file.name + ': восстановлены две колонки заголовка reqnum и procedure_name; значения строк сохранены.')
    }
    const lot = indexOf(headers, ['lot_id', 'lotid', 'номерлота'])
    const product = indexOf(headers, ['product_name', 'наименованиетру'])
    const code = indexOf(headers, ['okpd2_code', 'кодокпд2', 'окпд2'])
    if (lot >= 0 && product >= 0) {
      for (const [i, row] of rows.entries()) {
        if (row.length !== headers.length) throw new Error(file.name + ': неверное число колонок в строке ТРУ.')
        const id = row[lot]?.trim()
        if (!id) { warnings.push(file.name + ': пропущена строка ТРУ без lot_id.'); continue }
        const item = { product_name: row[product] || '', okpd2_code: code >= 0 ? row[code] || '' : '' }
        if (!itemSources.has(id)) itemSources.set(id, { name: file.name, rowNumber: i + 2 })
        const items = itemMap.get(id)
        if (items) items.push(item); else itemMap.set(id, [item])
        itemCount++
      }
    } else sources.push({ headers, rows, name: file.name })
  }
  const provisionalOnly = !sources.length
  if (provisionalOnly && !itemMap.size) throw new Error('В ТРУ не найдено строк с lot_id и product_name.')
  const headers = provisionalOnly ? ['lot_id', 'subject', 'Файл-источник'] : [...new Set(sources.flatMap(source => source.headers))]
  if (!headers.includes('Файл-источник')) headers.push('Файл-источник')
  if (provisionalOnly) {
    warnings.push('Лоты собраны только из ТРУ. Добавьте CSV извещений, чтобы уточнить предмет, бюджет и заказчика.')
    for (const [id, items] of itemMap) {
      const names = [...new Set(items.map(item => item.product_name.trim()).filter(Boolean))].slice(0, 3)
      const query = names.join('; ') || ('ТРУ ОКПД2 ' + (items.find(item => item.okpd2_code)?.okpd2_code || 'не указан'))
      const source = itemSources.get(id)!
      purchases.push({ id, rowNumber: source.rowNumber, query: query.slice(0, 500), sourceFile: source.name,
        sourceValues: [id, query, source.name], options: { top_k: 5, structured_query: true }, provisional: true })
    }
  }
  for (const source of sources) {
    const lot = indexOf(source.headers, ['lot_id', 'lotid', 'id', 'purchaseid', 'номерлота'])
    const description = indexOf(source.headers, ['subject', 'description', 'query', 'предметзакупки', 'описание'])
    const procedure = indexOf(source.headers, ['procedure_name', 'названиезакупки', 'наименованиезакупки'])
    const priceIndex = indexOf(source.headers, ['start_price', 'нмцк', 'бюджет', 'цена'])
    const customerIndex = indexOf(source.headers, ['customer_inn', 'иннзаказчика'])
    const codeIndex = indexOf(source.headers, ['okpd2_code', 'окпд2'])
    const dateIndex = indexOf(source.headers, ['publish_date', 'датапубликации'])
    const reqIndex = indexOf(source.headers, ['reqnum'])
    if (lot < 0 || (description < 0 && procedure < 0)) {
      const generic = parsePurchaseCsv(source.headers.map(csvQuote).join(';') + '\n' + source.rows.map(row => row.map(csvQuote).join(';')).join('\n'))
      for (const purchase of generic.purchases) {
        const original = purchase.sourceValues
        purchase.sourceValues = headers.map(header => header === 'Файл-источник' ? source.name : original[source.headers.indexOf(header)] || '')
        purchase.sourceFile = source.name; purchases.push(purchase)
      }
      continue
    }
    for (const [i, row] of source.rows.entries()) {
      const id = row[lot] || ''
      const query = (description >= 0 ? row[description] : '') || (procedure >= 0 ? row[procedure] : '') || ''
      const options: SearchOptions = { top_k: 5, structured_query: true }
      let validationError = row.length === source.headers.length ? '' : 'Число колонок не совпадает с заголовком.'
      if (!id) validationError ||= 'Не указан lot_id.'
      if (!query.trim()) validationError ||= 'Не указан предмет закупки.'
      const customer = customerIndex < 0 ? '' : row[customerIndex]?.trim() || ''
      if (customer) {
        if (/^\d{10}(?:\d{2})?$/.test(customer)) options.customer_inn = customer
        else validationError ||= 'ИНН заказчика должен содержать 10 или 12 цифр.'
      }
      try { options.start_price = parseBudget(priceIndex < 0 ? '' : row[priceIndex] || '') }
      catch (error) { validationError ||= (error as Error).message }
      if (codeIndex >= 0 && row[codeIndex]) options.okpd2_code = row[codeIndex]
      purchases.push({ id: id || String(purchases.length + 1), rowNumber: i + 2, query: query.slice(0, 500), options,
        sourceValues: headers.map(header => header === 'Файл-источник' ? source.name : row[source.headers.indexOf(header)] || ''),
        sourceRecord: row, sourceFile: source.name, published: dateIndex < 0 ? '' : row[dateIndex],
        reqnum: reqIndex < 0 ? '' : row[reqIndex], ...(validationError ? { validationError } : {}) })
    }
  }
  if (purchases.length > 200) throw new Error('В одном наборе можно обработать до 200 извещений. Строки ТРУ в этот лимит не входят.')
  if (!purchases.length) throw new Error('В файлах нет извещений о закупках.')
  const notices = new Set(purchases.map(p => p.id))
  const unmatched = [...itemMap.keys()].filter(id => !notices.has(id))
  if (unmatched.length) warnings.push('ТРУ для ' + unmatched.length + ' лотов не связаны с загруженными извещениями.')
  const duplicates = purchases.length - notices.size
  if (duplicates) warnings.push('В извещениях повторяются ' + duplicates + ' lot_id. Строки сохранены отдельно с именами файлов.')
  for (const purchase of purchases) {
    purchase.items = itemMap.get(purchase.id) || []
    const counts = new Map<string, number>()
    for (const item of purchase.items) if (/^\d{2}(?:\.\d{1,3}){0,4}$/.test(item.okpd2_code)) counts.set(item.okpd2_code, (counts.get(item.okpd2_code) || 0) + 1)
    const divisions = new Set([...counts.keys()].map(code => code.slice(0, 2)))
    if (!purchase.options.okpd2_code && divisions.size === 1) purchase.options.okpd2_code = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (divisions.size > 1) purchase.multiCategory = true
    const itemText = [...new Set(purchase.items.map(item => item.product_name))].slice(0, 3).join('; ')
    purchase.searchQuery = (purchase.provisional ? purchase.query : purchase.query + (itemText ? ' ' + itemText : '')).slice(0, 500)
  }
  return { headers, purchases, warnings: [...new Set(warnings)], itemCount, files: files.map(file => file.name), provisionalOnly }
}
function csvQuote(value: string) { return '"' + value.replace(/"/g, '""') + '"' }
