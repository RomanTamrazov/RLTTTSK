import type { SearchOptions, SearchResult, Supplier } from './api'
import { companyLinks, contactLinks, parseBudget, supplierTitle } from './presentation'

export interface PurchaseRow {
  rowNumber: number
  id: string
  query: string
  searchQuery?: string
  sourceFile?: string
  published?: string
  reqnum?: string
  multiCategory?: boolean
  provisional?: boolean
  items?: { product_name: string; okpd2_code: string }[]
  sourceValues: string[]
  sourceRecord?: string[]
  options: SearchOptions
  validationError?: string
}
export type RowStatus = 'pending' | 'running' | 'done' | 'empty' | 'error' | 'cancelled'
export interface PurchaseRecommendations {
  purchase: PurchaseRow
  status: RowStatus
  result?: SearchResult
  error?: string
  recommendedAt?: string
}
export function parseRecords(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '')
  let inQuote = false, semicolons = 0, commas = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') { if (inQuote && text[i + 1] === '"') i++; else inQuote = !inQuote }
    else if (!inQuote && /[\r\n]/.test(text[i])) break
    else if (!inQuote && text[i] === ';') semicolons++
    else if (!inQuote && text[i] === ',') commas++
  }
  const delimiter = semicolons > commas ? ';' : ','
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false, closedQuote = false
  const pushField = () => { row.push(field.trim()); field = ''; closedQuote = false }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++ }
      else if (quoted) { quoted = false; closedQuote = true }
      else if (!field.trim() && !closedQuote) quoted = true
      else throw new Error('Некорректные кавычки в CSV. Сохраните файл в формате CSV UTF-8.')
    } else if (!quoted && char === delimiter) pushField()
    else if (!quoted && (char === '\r' || char === '\n')) {
      if (char === '\r' && text[i + 1] === '\n') i++
      pushField(); if (row.some(Boolean)) rows.push(row); row = []
    } else {
      if (closedQuote && char.trim()) throw new Error('После закрывающей кавычки ожидается разделитель CSV.')
      if (!closedQuote) field += char
    }
  }
  if (quoted) throw new Error('В CSV есть незакрытая кавычка.')
  pushField(); if (row.some(Boolean)) rows.push(row)
  return rows
}
const normalize = (value: string) => value.toLocaleLowerCase('ru').replace(/[\s\u00a0_./()-]/g, '')
const ALIASES = {
  id: ['id', 'purchaseid', 'lotid', 'requestid', 'номерзакупки', 'реестровыйномер', 'идентификатор', 'номерлота'],
  query: ['query', 'purchase', 'purchasetext', 'purchasedescription', 'purchasename', 'description', 'subject', 'title', 'lotname', 'названиезакупки', 'описаниезакупки', 'предметзакупки', 'наименованиезакупки', 'предмет', 'описание', 'закупка'],
  okpd2: ['okpd2', 'окпд2', 'кодокпд2'],
  customerInn: ['customerinn', 'иннзаказчика', 'заказчикinn'],
  startPrice: ['startprice', 'начальнаяцена', 'бюджет', 'нмцк', 'цена'],
}
function columnIndex(headers: string[], field: keyof typeof ALIASES) {
  const matches = headers.map((header, index) => ALIASES[field].some(alias => normalize(alias) === normalize(header)) ? index : -1).filter(index => index >= 0)
  if (matches.length > 1) throw new Error('Для поля «' + field + '» найдены несколько колонок. Оставьте одну.')
  return matches[0] ?? -1
}
export function parsePurchaseCsv(text: string): { headers: string[]; purchases: PurchaseRow[] } {
  const [headers = [], ...records] = parseRecords(text)
  if (!headers.length || headers.some(header => !header)) throw new Error('Все колонки CSV должны иметь название.')
  if (new Set(headers.map(normalize)).size !== headers.length) throw new Error('Названия колонок в CSV повторяются.')
  const queryIndex = columnIndex(headers, 'query'), codeIndex = columnIndex(headers, 'okpd2')
  if (queryIndex < 0 && codeIndex < 0) throw new Error('Нужна колонка с описанием закупки или кодом ОКПД2.')
  const idIndex = columnIndex(headers, 'id'), customerIndex = columnIndex(headers, 'customerInn'), priceIndex = columnIndex(headers, 'startPrice')
  if (!records.length) throw new Error('В CSV нет строк закупок.')
  if (records.length > 200) throw new Error('В одном файле можно обработать до 200 закупок.')
  const purchases = records.map((values, index): PurchaseRow => {
    const code = codeIndex < 0 ? '' : values[codeIndex] ?? ''
    const description = queryIndex < 0 ? '' : values[queryIndex] ?? ''
    const customer = customerIndex < 0 ? '' : (values[customerIndex] ?? '').replace(/[\s\u00a0]/g, '')
    const options: SearchOptions = { top_k: 5 }
    let validationError = ''
    if (values.length !== headers.length) validationError = 'Число полей в строке не совпадает с числом колонок.'
    if (code) {
      if (!/^\d{2}(?:\.\d{1,3}){0,4}$/.test(code)) validationError ||= 'Некорректный код ОКПД2.'
      else options.okpd2_code = code
    }
    if (customer) {
      if (!/^\d{10}(?:\d{2})?$/.test(customer)) validationError ||= 'ИНН заказчика должен содержать 10 или 12 цифр.'
      else options.customer_inn = customer
    }
    try {
      const price = parseBudget(priceIndex < 0 ? '' : values[priceIndex] ?? '')
      if (price !== undefined) options.start_price = price
    } catch (error) { validationError ||= (error as Error).message }
    const query = description || (code ? 'ОКПД2 ' + code : '')
    if (query.length < 2) validationError ||= 'Укажите описание закупки или ОКПД2.'
    if (query.length > 500) validationError ||= 'Описание закупки длиннее 500 символов.'
    return { rowNumber: index + 2, id: (idIndex >= 0 ? values[idIndex] : '') || String(index + 1), query,
      sourceValues: headers.map((_, column) => values[column] ?? ''), sourceRecord: values, options, ...(validationError ? { validationError } : {}) }
  })
  return { headers, purchases }
}
// Spreadsheet applications can interpret a leading "=" as a formula even in quotes.
export function csvCell(value: string | number | undefined | null) {
  let text = String(value ?? '')
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text
  return /[",\r\n;]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
}
export const statusLabel: Record<RowStatus, string> = {
  pending: 'Не обработано', running: 'В обработке', done: 'Рекомендации готовы',
  empty: 'Кандидаты не найдены', error: 'Ошибка', cancelled: 'Обработка остановлена',
}
export function recommendationsCsv(headers: string[], rows: PurchaseRecommendations[]) {
  const extra = ['Основа лота', 'Строка CSV', 'Статус обработки', 'Ошибка', 'Исходные поля строки JSON', 'ТРУ лота JSON', 'Бюджет закупки ₽', 'Ранг рекомендации',
    'ИНН поставщика', 'Поставщик', 'ОКПД2 раздел', 'Почему рекомендован', 'Телефон', 'Email', 'Сайт',
    'Источник контактов', 'Дата проверки контактов', 'Цена поставщика', 'Бюджет похожей закупки ₽',
    'Дата похожей закупки', 'ID похожего лота', 'Предмет похожей закупки', 'ЕГРЮЛ', 'Портал поставщиков']
  const output: (string | number | undefined | null)[][] = [[...headers, ...extra]]
  for (const row of rows) {
    const candidates: (Supplier | undefined)[] = row.result?.recommendations.length ? row.result.recommendations : [undefined]
    for (const candidate of candidates) {
      const urls = candidate ? companyLinks(candidate.supplier_inn) : { fns: '', portal: '' }
      const contacts = candidate ? contactLinks(candidate) : null
      const historical = candidate?.pricing?.historical_purchase
      output.push([...row.purchase.sourceValues, row.purchase.provisional ? 'Только ТРУ; извещение не загружено' : 'Извещение', row.purchase.rowNumber, statusLabel[row.status], row.error, row.purchase.sourceRecord ? JSON.stringify(row.purchase.sourceRecord) : '', row.purchase.items ? JSON.stringify(row.purchase.items) : '',
        row.purchase.options.start_price, candidate?.rank, candidate?.supplier_inn, candidate ? supplierTitle(candidate) : '',
        candidate?.category_division, candidate?.reasons.join(' · '), contacts?.phone?.label, contacts?.email?.label,
        contacts?.website, contacts?.source, candidate?.enrichment?.contact_checked_date,
        candidate ? 'По запросу; подтверждённого предложения нет' : '', historical?.start_price,
        historical?.publish_date, historical?.lot_id, historical?.purchase_text, urls.fns, urls.portal])
    }
  }
  return '\uFEFF' + output.map(row => row.map(csvCell).join(';')).join('\r\n')
}
export function downloadCsv(content: string, name: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = name
  document.body.appendChild(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function downloadPurchaseTemplate() {
  downloadCsv('\uFEFFid;description;okpd2_code;customer_inn;start_price\r\nZ-001;Ремонт автоэвакуатора;45.20.2;;450000\r\nZ-002;Поставка медицинских перчаток;22.19.60;;300000\r\n', 'список-закупок-шаблон.csv')
}
export const downloadRecommendations = (headers: string[], rows: PurchaseRecommendations[]) => downloadCsv(recommendationsCsv(headers, rows), 'закупки-с-рекомендациями.csv')
