import { useEffect, useRef, useState } from 'react'
import { searchSuppliers, type SearchResult } from './api'
import { downloadResults, downloadTestTemplate, parseTestCsv, type TestCase, type TestResult } from './csvEvaluation'

const EXAMPLES = ['ремонт автоэвакуатора ОКПД2 45.20.2', 'медицинские изделия', 'рыбные консервы', 'ИНН 7805198740']
const title = (supplier: SearchResult['recommendations'][number]) => supplier.supplier_name || `Поставщик ИНН ${supplier.supplier_inn}`
const mspLabel: Record<string, string> = { '1': 'микропредприятие', '2': 'малое предприятие', '3': 'среднее предприятие' }
const companyLookupUrls = (inn: string) => ({
  fns: `https://egrul.nalog.ru/index.html?query=${encodeURIComponent(inn)}`,
  portal: `https://zakupki.mos.ru/organization/list?page=1&perPage=10&filter=${encodeURIComponent(JSON.stringify({ isSupplier: true, inn: { value: inn } }))}`,
})

export default function App() {
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [selectedInn, setSelectedInn] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [previewHeight, setPreviewHeight] = useState(360)
  const [testCases, setTestCases] = useState<TestCase[]>([])
  const [testResults, setTestResults] = useState<TestResult[]>([])
  const [testProgress, setTestProgress] = useState(0)
  const [testRunning, setTestRunning] = useState(false)
  const [testError, setTestError] = useState('')
  const testController = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const suppliers = result?.recommendations ?? []
  const pageCount = Math.max(1, Math.ceil(suppliers.length / 5))
  const pageSuppliers = suppliers.slice(page * 5, page * 5 + 5)
  const selected = focused ? suppliers.find(s => s.supplier_inn === selectedInn) : undefined
  const labeledResults = testResults.filter(item => item.testCase.expectedInn && item.result)
  const hitAt1 = labeledResults.filter(item => item.result?.recommendations[0]?.supplier_inn === item.testCase.expectedInn).length
  const hitAt5 = labeledResults.filter(item => item.result?.recommendations.slice(0, 5).some(candidate => candidate.supplier_inn === item.testCase.expectedInn)).length

  async function loadTestCsv(file?: File) {
    setTestError(''); setTestResults([]); setTestProgress(0); setTestCases([])
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { setTestError('Файл больше 2 МБ. Разделите его на части.'); return }
    try { setTestCases(parseTestCsv(await file.text())) }
    catch (err) { setTestError(err instanceof Error ? err.message : 'Не удалось прочитать CSV.') }
  }

  async function runCsvEvaluation() {
    if (!testCases.length) return
    const controller = new AbortController()
    testController.current = controller; setTestRunning(true); setTestError(''); setTestResults([]); setTestProgress(0)
    const completed: TestResult[] = []
    for (const testCase of testCases) {
      if (controller.signal.aborted) break
      try { completed.push({ testCase, result: await searchSuppliers(testCase.query, controller.signal, testCase.options) }) }
      catch (err) {
        if (controller.signal.aborted) break
        completed.push({ testCase, error: err instanceof Error ? err.message : 'Ошибка запроса' })
      }
      setTestResults([...completed]); setTestProgress(completed.length)
    }
    testController.current = null; setTestRunning(false)
  }

  useEffect(() => {
    const controller = new AbortController()
    setResult(null); setError(''); setSelectedInn(null); setPage(0)
    if (query.trim().length < 2) { setLoading(false); return }
    setLoading(true)
    const timer = setTimeout(() => {
      searchSuppliers(query.trim(), controller.signal)
        .then(data => { if (!controller.signal.aborted) setResult(data) })
        .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Не удалось выполнить поиск.') })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 450)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query])

  useEffect(() => {
    if (!previewRef.current) return
    const observer = new ResizeObserver(([entry]) => setPreviewHeight(Math.max(360, Math.ceil(entry.target.getBoundingClientRect().height))))
    observer.observe(previewRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) { setFocused(false); setSelectedInn(null) }
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [])

  return (
    <main className="app">
      <img className="city-background" src={`${import.meta.env.BASE_URL}images/petersburg-sketch.png`} alt="" aria-hidden="true" />
      <div className="app-content">
        <h1 className="company-title">RLTTTSK</h1>
        <div ref={wrapRef} className={`search-layout${focused ? ' is-open' : ''}${selected ? ' has-preview' : ''}`}>
          {selected && <div className="search-hover-area" aria-hidden="true" style={{ height: `calc(100% + ${previewHeight + 12}px)` }} />}
          <div className={`search-shell${focused ? ' is-focused' : ''}`}>
            <span className="search-icon" aria-hidden="true">⌕</span>
            <input
              className="search-input" ref={inputRef} type="search" value={query} maxLength={500}
              aria-label="Предмет закупки, ИНН или ОКПД2" aria-controls="supplier-results" aria-expanded={focused}
              autoComplete="off" placeholder="Предмет закупки, ИНН или ОКПД2…"
              onChange={event => setQuery(event.target.value)} onFocus={() => setFocused(true)}
              onKeyDown={event => {
                if (event.key === 'Escape') { setFocused(false); setSelectedInn(null) }
                if (event.key === 'Enter') setFocused(true)
                if (['ArrowDown', 'ArrowUp'].includes(event.key) && suppliers.length) {
                  event.preventDefault(); setFocused(true)
                  const index = suppliers.findIndex(s => s.supplier_inn === selectedInn)
                  const next = (index + (event.key === 'ArrowDown' ? 1 : suppliers.length - 1)) % suppliers.length
                  setSelectedInn(suppliers[next].supplier_inn)
                  setPage(Math.floor(next / 5))
                }
              }}
            />
            {query && <button className="clear-search" aria-label="Очистить поиск" onClick={() => { setQuery(''); inputRef.current?.focus() }}>×</button>}
          </div>
          {!focused && !query && <p className="search-hint">Найдите поставщиков для вашей закупки</p>}
          {!focused && <section className="csv-test-panel" aria-label="Тестирование модели по CSV">
            <div className="csv-test-heading"><strong>Проверить модель на CSV</strong><button type="button" className="csv-template" onClick={downloadTestTemplate}>Скачать шаблон</button></div>
            <p>Файл обрабатывается в браузере. Обязательная колонка — <code>query</code>; для Hit@1/Hit@5 добавьте <code>expected_inn</code>.</p>
            <label className="csv-upload">{testCases.length ? `Загружено строк: ${testCases.length}` : 'Выбрать CSV'}
              <input type="file" accept=".csv,text/csv" onChange={event => { void loadTestCsv(event.target.files?.[0]); event.currentTarget.value = '' }} />
            </label>
            {testCases.length > 0 && <button type="button" className="csv-run" disabled={testRunning} onClick={() => void runCsvEvaluation()}>{testRunning ? `Проверено ${testProgress} из ${testCases.length}` : 'Запустить проверку'}</button>}
            {testRunning && <button type="button" className="csv-cancel" onClick={() => testController.current?.abort()}>Остановить</button>}
            {testError && <p className="csv-error" role="alert">{testError}</p>}
            {testResults.length > 0 && <div className="csv-summary" role="status">
              <span>Готово: {testResults.length}/{testCases.length}</span>
              {labeledResults.length > 0 && <span>Размечено: {labeledResults.length} · Hit@1: {(100 * hitAt1 / labeledResults.length).toFixed(1)}% · Hit@5: {(100 * hitAt5 / labeledResults.length).toFixed(1)}%</span>}
              <button type="button" className="csv-template" onClick={() => downloadResults(testResults)}>Скачать результаты</button>
            </div>}
          </section>}
          {focused && (
            <div id="supplier-results" className="search-dropdown" style={{ minHeight: suppliers.length ? previewHeight : undefined }}>
              {query.trim().length < 2 ? <div className="search-status">
                <p>Опишите закупку или введите ИНН / ОКПД2</p>
                {EXAMPLES.map(example => <button className="query-example" key={example} onClick={() => setQuery(example)}>{example}</button>)}
              </div> : loading ? <p className="search-status loading-status" role="status">Подбираем поставщиков<span className="loading-dots" aria-hidden="true">…</span></p>
                : error ? <p className="search-status" role="alert">{error}</p>
                  : !suppliers.length ? <p className="search-status" role="status">Поставщики не найдены. Уточните предмет закупки или код ОКПД2.</p>
                    : <>
                      <div className="results-caption">{result?.mode === 'supplier_lookup' ? 'Найден поставщик' : `Кандидатов: ${result?.candidate_count} · ОКПД2 ${result?.category_division}`}{result?.search_fallback && ' · поиск расширен'}{result?.parsed_query.customer_inn && ' · учтён заказчик'}</div>
                      <div className="search-results">
                        {pageSuppliers.map((item, index) => (
                          <button key={item.supplier_inn} style={{ animationDelay: `${index * 35}ms` }} className={`search-result${selectedInn === item.supplier_inn ? ' is-active' : ''}`}
                            onMouseEnter={() => setSelectedInn(item.supplier_inn)} onFocus={() => setSelectedInn(item.supplier_inn)}
                            onClick={() => setSelectedInn(selectedInn === item.supplier_inn ? null : item.supplier_inn)}>
                            <span className="supplier-rank">{item.rank}</span>
                            <span className="result-text"><span className="result-title">{title(item)}</span><span className="result-description">{item.profile_excerpt || item.source}</span></span>
                          </button>
                        ))}
                      </div>
                      {suppliers.length > 5 && <nav className="candidate-pagination" aria-label="Страницы кандидатов">
                        <button type="button" aria-label="Предыдущие кандидаты" disabled={page === 0} onClick={() => { setPage(page - 1); setSelectedInn(null) }}>‹</button>
                        <span>{page + 1} / {pageCount}</span>
                        <button type="button" aria-label="Следующие кандидаты" disabled={page + 1 >= pageCount} onClick={() => { setPage(page + 1); setSelectedInn(null) }}>›</button>
                      </nav>}
                    </>}
            </div>
          )}
          <aside ref={previewRef} className={`supplier-preview${selected ? ' is-visible' : ''}`} aria-label="Опыт поставщика" aria-hidden={!selected}
            style={{ opacity: selected ? 1 : 0, pointerEvents: selected ? 'auto' : 'none' }}>
            {selected && <div key={selected.supplier_inn} className="supplier-preview-content">
              <h2 className="supplier-title">{title(selected)}</h2>
              <p className="supplier-meta">ИНН {selected.supplier_inn} · ОКПД2 {selected.category_division}</p>
              <p className="supplier-description">{selected.profile_excerpt}</p>
              <div className="supplier-history">
                <div><strong>{selected.history.participations}</strong><span>участий в ЭМ</span></div>
                <div><strong>{selected.history.wins}</strong><span>побед в ЭМ</span></div>
                <div><strong>{selected.history.category_wins}</strong><span>побед в категории</span></div>
              </div>
              {selected.enrichment && <div className="supplier-facts">
                <strong>Проверенные сведения</strong>
                {(selected.enrichment.region || selected.enrichment.city) && <span>{[selected.enrichment.region, selected.enrichment.city].filter(Boolean).join(', ')}</span>}
                {selected.enrichment.primary_okved && <span>ОКВЭД {selected.enrichment.primary_okved}</span>}
                {selected.enrichment.msp_category && <span>Реестр МСП: {mspLabel[selected.enrichment.msp_category] || selected.enrichment.msp_category}</span>}
                {selected.enrichment.staff_count && <span>Средняя численность работников за 2025 год: {selected.enrichment.staff_count}</span>}
                {selected.enrichment.last_activity && <span>Последняя активность в архиве: {selected.enrichment.last_activity}</span>}
                {selected.enrichment.observed_lots && <span>Лотов в архиве: {selected.enrichment.observed_lots}</span>}
                {selected.enrichment.snapshot_date && <small>ФНС: срез от {selected.enrichment.snapshot_date} · <a href={selected.enrichment.source_url} target="_blank" rel="noreferrer">источник ↗</a></small>}
                {selected.enrichment.activity_source && <small>{selected.enrichment.activity_source}</small>}
                {selected.enrichment.website_lookup_url && !selected.enrichment.website && <a href={selected.enrichment.website_lookup_url} target="_blank" rel="noreferrer">Найти сайт ↗</a>}
              </div>}
              <div className="supplier-discovery-links">
                <a href={companyLookupUrls(selected.supplier_inn).fns} target="_blank" rel="noreferrer">Проверить ЕГРЮЛ по ИНН ↗</a>
                <a href={companyLookupUrls(selected.supplier_inn).portal} target="_blank" rel="noreferrer">Найти компанию на Портале поставщиков ↗</a>
              </div>
              <div className="supplier-contact">
                <h3>Связаться с компанией</h3>
                {selected.enrichment?.phone && <a href={`tel:${selected.enrichment.phone.replace(/[^+\d]/g, '')}`}>Позвонить: {selected.enrichment.phone}</a>}
                {selected.enrichment?.email?.includes('@') && <a href={`mailto:${selected.enrichment.email}`}>Написать: {selected.enrichment.email}</a>}
                {selected.enrichment?.website?.startsWith('https://') && <a href={selected.enrichment.website} target="_blank" rel="noreferrer">Сайт компании ↗</a>}
                {selected.enrichment?.contact_url?.startsWith('https://') && <a href={selected.enrichment.contact_url} target="_blank" rel="noreferrer">Страница компании ↗</a>}
                {selected.enrichment?.contact_source?.startsWith('https://') && <small>Опубликованный контакт · проверено {selected.enrichment.contact_checked_date} · <a href={selected.enrichment.contact_source} target="_blank" rel="noreferrer">источник ↗</a></small>}
                {!selected.enrichment?.phone && !selected.enrichment?.email && !selected.enrichment?.website && !selected.enrichment?.contact_url &&
                  <a href={selected.enrichment?.contact_lookup_url || `https://yandex.ru/search/?text=${encodeURIComponent(`контакты компании ИНН ${selected.supplier_inn}`)}`} target="_blank" rel="noreferrer">Найти контакты по ИНН ↗</a>}
              </div>
              <h3>Почему в выдаче</h3>
              <ul className="supplier-reasons">{selected.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
              <p className="supplier-source">{selected.source}</p>
              {selected.source_url.startsWith('https://') && <a className="supplier-link" href={selected.source_url} target="_blank" rel="noreferrer">Профиль в источнике ↗</a>}
            </div>}
          </aside>
        </div>
      </div>
    </main>
  )
}
