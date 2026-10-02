import type { SearchOptions, SearchResult, Supplier } from './api'

export interface PurchaseRow {
  rowNumber: number
  id: string
  query: string
  sourceValues: string[]
  options: SearchOptions
}

export interface PurchaseRecommendations {
  purchase: PurchaseRow
  result?: SearchResult
  error?: string
}

function parseRecords(text: string): string[][] {
  text = text.replace(/^\uFEFF/, '')
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i += 1 }
      else quoted = !quoted
    } else if (!quoted && char === delimiter) { row.push(field.trim()); field = '' }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(field.trim()); field = ''
      if (row.some(value => value)) rows.push(row)
      row = []
    } else field += char
  }
  row.push(field.trim())
  if (row.some(value => value)) rows.push(row)
  return rows
}

const normalize = (value: string) => value.toLocaleLowerCase('ru').replace(/[\s\u00a0_./()-]/g, '')
const ALIASES: Record<string, string[]> = {
  id: ['id', 'purchaseid', 'lotid', 'requestid', 'номерзакупки', 'реестровыйномер', 'идентификатор', 'номерлота'],
  query: ['query', 'purchase', 'purchasetext', 'purchasedescription', 'purchasename', 'description', 'subject', 'title', 'lotname', 'названиезакупки', 'описаниезакупки', 'предметзакупки', 'наименованиезакупки', 'предмет', 'описание', 'закупка'],
  okpd2: ['okpd2', 'okpd2code', 'окпд2', 'кодокпд2', 'кодокпд2закупки'],
  customerInn: ['customerinn', 'иннзаказчика', 'заказчикinn'],
  startPrice: ['startprice', 'начальнаяцена', 'нмцк', 'цена'],
}

function columnIndex(headers: string[], field: keyof typeof ALIASES): number {
  return headers.findIndex(header => ALIASES[field].some(alias => normalize(alias) === normalize(header)))
}

export function parsePurchaseCsv(text: string): { headers: string[]; purchases: PurchaseRow[] } {
  const [headers = [], ...records] = parseRecords(text)
  if (!headers.length) throw new Error('В CSV не найдена строка с названиями колонок.')
  const queryIndex = columnIndex(headers, 'query'), codeIndex = columnIndex(headers, 'okpd2')
  if (queryIndex < 0 && codeIndex < 0) throw new Error('Нужна колонка с предметом/описанием закупки или кодом ОКПД2.')
  const idIndex = columnIndex(headers, 'id'), customerIndex = columnIndex(headers, 'customerInn'), priceIndex = columnIndex(headers, 'startPrice')
  const purchases = records.map((values, index): PurchaseRow => {
    const code = codeIndex < 0 ? '' : values[codeIndex] ?? ''
    const description = queryIndex < 0 ? '' : values[queryIndex] ?? ''
    const priceText = priceIndex < 0 ? '' : values[priceIndex] ?? ''
    const price = Number(priceText.replace(/[\s\u00a0₽]/g, '').replace(',', '.'))
    return {
      rowNumber: index + 2,
      id: (idIndex >= 0 ? values[idIndex] : '') || String(index + 1),
      query: description || (code ? `ОКПД2 ${code}` : ''),
      sourceValues: headers.map((_, column) => values[column] ?? ''),
      options: {
        ...(code ? { okpd2_code: code } : {}),
        ...(customerIndex >= 0 && values[customerIndex] ? { customer_inn: values[customerIndex].replace(/\D/g, '') } : {}),
        ...(Number.isFinite(price) && price > 0 ? { start_price: price } : {}),
        top_k: 5,
      },
    }
  })
  if (!purchases.length) throw new Error('В CSV нет строк закупок.')
  if (purchases.length > 200) throw new Error('В одном файле можно обработать до 200 закупок.')
  return { headers, purchases }
}

function csvCell(value: string | number | undefined): string {
  const text = String(value ?? '')
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const links = (inn: string) => ({
  egrul: `https://egrul.nalog.ru/index.html?query=${encodeURIComponent(inn)}`,
  portal: `https://zakupki.mos.ru/organization/list?page=1&perPage=10&filter=${encodeURIComponent(JSON.stringify({ isSupplier: true, inn: { value: inn } }))}`,
})

export function downloadPurchaseTemplate() {
  const content = '\uFEFFid;description;okpd2_code;customer_inn;start_price\r\nZ-001;Ремонт помещений;41.20.40;7707083893;1500000\r\nZ-002;Поставка медицинских перчаток;21.20.24;;450000\r\n'
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = 'список-закупок-шаблон.csv'; link.click()
  URL.revokeObjectURL(url)
}

export function downloadRecommendations(headers: string[], rows: PurchaseRecommendations[]) {
  const extraHeaders = ['Ранг рекомендации', 'ИНН поставщика', 'Поставщик', 'ОКПД2 раздел', 'Почему рекомендован', 'Телефон', 'Email', 'Сайт', 'ЕГРЮЛ', 'Портал поставщиков', 'Статус']
  const output: (string | number | undefined)[][] = [[...headers, ...extraHeaders]]
  for (const row of rows) {
    const candidates = row.result?.recommendations ?? []
    const recommendations: (Supplier | undefined)[] = candidates.length ? candidates : [undefined]
    for (const candidate of recommendations) {
      const inn = candidate?.supplier_inn ?? ''
      const urls = inn ? links(inn) : { egrul: '', portal: '' }
      output.push([
        ...row.purchase.sourceValues,
        candidate?.rank, inn, candidate?.supplier_name, candidate?.category_division,
        candidate?.reasons.join(' · '), candidate?.enrichment?.phone, candidate?.enrichment?.email,
        candidate?.enrichment?.website, urls.egrul, urls.portal,
        row.error || (candidates.length ? 'Рекомендация' : 'Кандидаты не найдены'),
      ])
    }
  }
  const csv = '\uFEFF' + output.map(row => row.map(csvCell).join(';')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = 'закупки-с-рекомендациями.csv'; link.click()
  URL.revokeObjectURL(url)
}
