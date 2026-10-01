import type { SearchOptions, SearchResult } from './api'

export interface TestCase {
  line: number
  query: string
  expectedInn?: string
  options: SearchOptions
}

export interface TestResult {
  testCase: TestCase
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
const HEADER_ALIASES: Record<string, string[]> = {
  query: ['query', 'purchase_text', 'purchase_description', 'description', 'запрос', 'описаниезакупки', 'предметзакупки', 'закупка'],
  okpd2: ['okpd2', 'окпд2', 'кодокпд2'],
  customerInn: ['customerinn', 'иннзаказчика', 'заказчикinn'],
  startPrice: ['startprice', 'начальнаяцена', 'нмцк', 'цена'],
  expectedInn: ['expectedinn', 'expected_supplier_inn', 'expected_winner_inn', 'winner_inn', 'ожидаемыйинн', 'иннпобедителя', 'победительинн'],
}

export function parseTestCsv(text: string): TestCase[] {
  const [headers, ...records] = parseRecords(text)
  if (!headers?.length) throw new Error('В CSV нет строки с названиями колонок.')
  const normalized = headers.map(normalize)
  const find = (key: keyof typeof HEADER_ALIASES) => normalized.findIndex(header => HEADER_ALIASES[key].some(alias => normalize(alias) === header))
  const queryIndex = find('query')
  if (queryIndex < 0) throw new Error('Добавьте обязательную колонку query (или «Запрос» / «Описание закупки»).')
  const okpdIndex = find('okpd2'), customerIndex = find('customerInn'), priceIndex = find('startPrice'), expectedIndex = find('expectedInn')
  const cases = records.map((record, index): TestCase => {
    const priceValue = priceIndex < 0 ? '' : record[priceIndex] ?? ''
    const price = Number(priceValue.replace(/[\s\u00a0₽]/g, '').replace(',', '.'))
    const inn = expectedIndex < 0 ? '' : (record[expectedIndex] ?? '').replace(/\D/g, '')
    return {
      line: index + 2,
      query: record[queryIndex] ?? '',
      expectedInn: inn || undefined,
      options: {
        ...(okpdIndex >= 0 && record[okpdIndex] ? { okpd2_code: record[okpdIndex] } : {}),
        ...(customerIndex >= 0 && record[customerIndex] ? { customer_inn: record[customerIndex].replace(/\D/g, '') } : {}),
        ...(Number.isFinite(price) && price > 0 ? { start_price: price } : {}),
      },
    }
  }).filter(testCase => testCase.query.length >= 2)
  if (!cases.length) throw new Error('Не нашёл строк с запросом длиной хотя бы 2 символа.')
  if (cases.length > 100) throw new Error('Для одного запуска доступно до 100 строк. Разделите большой CSV на части.')
  return cases
}

function csvCell(value: string | number | undefined): string {
  const text = String(value ?? '')
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function resultsCsv(results: TestResult[]): string {
  const header = ['Строка CSV', 'Запрос', 'Ожидаемый ИНН', 'ИНН на 1 месте', 'Поставщик на 1 месте', 'ИНН в топ-5', 'Место ожидаемого', 'Hit@1', 'Hit@5', 'Ошибка']
  const rows = results.map(({ testCase, result, error }) => {
    const candidates = result?.recommendations ?? []
    const expectedRank = testCase.expectedInn ? candidates.find(item => item.supplier_inn === testCase.expectedInn)?.rank : undefined
    return [testCase.line, testCase.query, testCase.expectedInn, candidates[0]?.supplier_inn, candidates[0]?.supplier_name,
      candidates.slice(0, 5).map(item => item.supplier_inn).join(' | '), expectedRank, testCase.expectedInn && expectedRank === 1 ? 1 : '',
      testCase.expectedInn && expectedRank && expectedRank <= 5 ? 1 : '', error]
  })
  return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(';')).join('\r\n')
}

export function downloadTestTemplate() {
  const content = '\uFEFFquery;okpd2_code;customer_inn;start_price;expected_inn\r\n"Ремонт зданий и помещений";41.20.40;7707083893;1500000;\r\n'
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = 'supplier-model-test-template.csv'; link.click()
  URL.revokeObjectURL(url)
}

export function downloadResults(results: TestResult[]) {
  const url = URL.createObjectURL(new Blob([resultsCsv(results)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = 'supplier-model-test-results.csv'; link.click()
  URL.revokeObjectURL(url)
}
