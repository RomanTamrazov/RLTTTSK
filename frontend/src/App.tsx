import { useEffect, useRef, useState } from 'react'
import { searchSuppliers, type SearchResult } from './api'
import { downloadPurchaseTemplate, downloadRecommendations, parsePurchaseCsv, type PurchaseRecommendations, type PurchaseRow } from './purchaseCsv'

const EXAMPLES = ['ремонт автоэвакуатора ОКПД2 45.20.2', 'медицинские изделия', 'рыбные консервы', 'ИНН 7805198740']
const title = (supplier: SearchResult['recommendations'][number]) => supplier.supplier_name || `Поставщик ИНН ${supplier.supplier_inn}`
const mspLabel: Record<string, string> = { '1': 'микропредприятие', '2': 'малое предприятие', '3': 'среднее предприятие' }
const companyLookupUrls = (inn: string) => ({
  fns: `https://egrul.nalog.ru/index.html?query=${encodeURIComponent(inn)}`,
  portal: `https://zakupki.mos.ru/organization/list?page=1&perPage=10&filter=${encodeURIComponent(JSON.stringify({ isSupplier: true, inn: { value: inn } }))}`,
})

export default function App() {
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [searchRun, setSearchRun] = useState(0)
  const [focused, setFocused] = useState(false)
  const [selectedInn, setSelectedInn] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [previewHeight, setPreviewHeight] = useState(360)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [purchases, setPurchases] = useState<PurchaseRow[]>([])
  const [bulkResults, setBulkResults] = useState<PurchaseRecommendations[]>([])
  const [bulkProgress, setBulkProgress] = useState(0)
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkError, setBulkError] = useState('')
  const bulkController = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const suppliers = result?.recommendations ?? []
  const pageCount = Math.max(1, Math.ceil(suppliers.length / 5))
  const pageSuppliers = suppliers.slice(page * 5, page * 5 + 5)
  const selected = focused ? suppliers.find(s => s.supplier_inn === selectedInn) : undefined
  const recommendedCount = bulkResults.reduce((sum, row) => sum + (row.result?.recommendations.length ?? 0), 0)

  function submitSearch(value = query) {
    const clean = value.trim()
    setFocused(true)
    if (clean.length < 2) return
    setQuery(clean); setSubmittedQuery(clean); setSearchRun(run => run + 1)
  }

  async function loadPurchaseCsv(file?: File) {
    setBulkError(''); setBulkResults([]); setBulkProgress(0); setPurchases([]); setCsvHeaders([])
    if (!file) return
    if (file.size > 5 * 1024 * 1024) { setBulkError('Файл больше 5 МБ. Разделите его на части.'); return }
    try {
      const parsed = parsePurchaseCsv(await file.text())
      setCsvHeaders(parsed.headers); setPurchases(parsed.purchases)
    } catch (err) { setBulkError(err instanceof Error ? err.message : 'Не удалось прочитать CSV.') }
  }

  async function recommendFromCsv() {
    if (!purchases.length) return
    const controller = new AbortController()
    bulkController.current = controller; setBulkRunning(true); setBulkError(''); setBulkResults([]); setBulkProgress(0)
    const rows: (PurchaseRecommendations | undefined)[] = Array(purchases.length)
    let cursor = 0, completed = 0
    const work = async () => {
      while (!controller.signal.aborted) {
        const index = cursor++
        if (index >= purchases.length) return
        const purchase = purchases[index]
        if (!purchase.query.trim()) rows[index] = { purchase, error: 'Укажите описание закупки или ОКПД2.' }
        else {
          try { rows[index] = { purchase, result: await searchSuppliers(purchase.query, controller.signal, purchase.options) } }
          catch (err) {
            if (controller.signal.aborted) return
            rows[index] = { purchase, error: err instanceof Error ? err.message : 'Не удалось получить рекомендации.' }
          }
        }
        completed += 1; setBulkProgress(completed); setBulkResults(rows.filter((row): row is PurchaseRecommendations => Boolean(row)))
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, purchases.length) }, () => work()))
    bulkController.current = null; setBulkRunning(false)
  }

  useEffect(() => {
    const controller = new AbortController()
    setResult(null); setError(''); setSelectedInn(null); setPage(0)
    if (query.trim().length < 2 || submittedQuery !== query.trim()) { setLoading(false); return }
    setLoading(true)
    searchSuppliers(submittedQuery, controller.signal)
      .then(data => { if (!controller.signal.aborted) setResult(data) })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Не удалось выполнить поиск.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [query, searchRun, submittedQuery])

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
          <form className={`search-shell${focused ? ' is-focused' : ''}`} onSubmit={event => { event.preventDefault(); submitSearch() }}>
            <input
              className="search-input" ref={inputRef} type="search" value={query} maxLength={500}
              aria-label="Предмет закупки, ИНН или ОКПД2" aria-controls="supplier-results" aria-expanded={focused}
              autoComplete="off" placeholder="Предмет закупки, ИНН или ОКПД2…"
              onChange={event => setQuery(event.target.value)} onFocus={() => setFocused(true)}
              onKeyDown={event => {
                if (event.key === 'Escape') { setFocused(false); setSelectedInn(null) }
                if (['ArrowDown', 'ArrowUp'].includes(event.key) && suppliers.length) {
                  event.preventDefault(); setFocused(true)
                  const index = suppliers.findIndex(s => s.supplier_inn === selectedInn)
                  const next = (index + (event.key === 'ArrowDown' ? 1 : suppliers.length - 1)) % suppliers.length
                  setSelectedInn(suppliers[next].supplier_inn)
                  setPage(Math.floor(next / 5))
                }
              }}
            />
            {query && <button type="button" className="clear-search" aria-label="Очистить поиск" onClick={() => { setQuery(''); setSubmittedQuery(''); inputRef.current?.focus() }}>×</button>}
            <button type="submit" className="search-submit" aria-label="Найти кандидатов" title="Найти кандидатов"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.4" /><path d="m15.5 15.5 5 5" /></svg></button>
          </form>
          {!focused && !query && <p className="search-hint">Найдите поставщиков для вашей закупки</p>}
          {focused && (
            <div id="supplier-results" className="search-dropdown" style={{ minHeight: suppliers.length ? previewHeight : undefined }}>
              {query.trim().length < 2 ? <div className="search-status">
                <p>Опишите закупку или введите ИНН / ОКПД2</p>
                {EXAMPLES.map(example => <button className="query-example" key={example} onClick={() => { setQuery(example); submitSearch(example) }}>{example}</button>)}
              </div> : submittedQuery !== query.trim() ? <p className="search-status">Нажмите кнопку поиска или Enter, чтобы подобрать кандидатов.</p>
                : loading ? <p className="search-status loading-status" role="status">Подбираем поставщиков<span className="loading-dots" aria-hidden="true">…</span></p>
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
        {!focused && <button type="button" className={`bulk-open${bulkOpen ? ' is-open' : ''}`} onClick={() => setBulkOpen(!bulkOpen)}>
          <span aria-hidden="true">▤</span>{bulkOpen ? 'Свернуть список закупок' : 'Загрузить список закупок CSV'}
        </button>}
        {bulkOpen && <section className="bulk-panel" aria-label="Пакетные рекомендации поставщиков">
          <header className="bulk-header">
            <div><span className="bulk-kicker">ПОДБОР ДЛЯ СПИСКА ЗАКУПОК</span><h2>Загрузите закупки — получите поставщиков</h2>
              <p>Для каждой строки подберём до пяти поставщиков, сохраним ваш ID и подготовим CSV с рекомендациями.</p></div>
            <button type="button" className="csv-template" onClick={downloadPurchaseTemplate}>Скачать шаблон</button>
          </header>
          <div className="bulk-controls">
            <label className="csv-upload">{purchases.length ? `Загружено закупок: ${purchases.length}` : 'Выбрать CSV-файл'}
              <input type="file" accept=".csv,text/csv" onChange={event => { void loadPurchaseCsv(event.target.files?.[0]); event.currentTarget.value = '' }} />
            </label>
            {purchases.length > 0 && <button type="button" className="csv-run" disabled={bulkRunning} onClick={() => void recommendFromCsv()}>{bulkRunning ? `Подбираем ${bulkProgress} из ${purchases.length}` : 'Получить рекомендации'}</button>}
            {bulkRunning && <button type="button" className="csv-cancel" onClick={() => bulkController.current?.abort()}>Остановить</button>}
            {bulkResults.length > 0 && !bulkRunning && <button type="button" className="csv-download" onClick={() => downloadRecommendations(csvHeaders, bulkResults)}>Скачать результат CSV</button>}
          </div>
          <p className="bulk-format">Поддерживаемые колонки: <code>id</code>, <code>description</code>, <code>okpd2_code</code>, <code>customer_inn</code>, <code>start_price</code>. Русские названия тоже распознаются. Максимум — 200 строк и 5 МБ.</p>
          {bulkError && <p className="csv-error" role="alert">{bulkError}</p>}
          {purchases.length > 0 && !bulkResults.length && !bulkRunning && <p className="bulk-ready">Файл готов: {purchases.length} закупок. Нажмите «Получить рекомендации».</p>}
          {bulkResults.length > 0 && <div className="bulk-summary" role="status"><strong>Готово {bulkResults.length} из {purchases.length}</strong><span>{recommendedCount} рекомендаций · для каждой закупки сохранён свой ID</span></div>}
          {bulkResults.length > 0 && <div className="bulk-result-list">
            {bulkResults.map((row, index) => {
              const top = row.result?.recommendations[0]
              return <details className="bulk-result" key={`${row.purchase.rowNumber}-${index}`} open={index === 0}>
                <summary><span className="bulk-id">{row.purchase.id}</span><span className="bulk-query">{row.purchase.query || 'Запрос не указан'}</span>
                  <span className="bulk-result-count">{row.error ? 'ошибка' : `${row.result?.recommendations.length ?? 0} поставщиков`}</span>
                  {top && <span className="bulk-top-supplier">№1 {top.supplier_name || `ИНН ${top.supplier_inn}`}</span>}
                </summary>
                {row.error ? <p className="bulk-row-error">{row.error}</p> : <div className="bulk-suppliers">
                  {(row.result?.recommendations ?? []).map(supplier => <article className="bulk-supplier" key={supplier.supplier_inn}>
                    <span className="bulk-rank">{supplier.rank}</span><div><strong>{supplier.supplier_name || 'Поставщик'}</strong><small>ИНН {supplier.supplier_inn} · ОКПД2 {supplier.category_division}</small>
                      {supplier.reasons[0] && <small>{supplier.reasons[0]}</small>}
                      <div className="bulk-links"><a href={companyLookupUrls(supplier.supplier_inn).fns} target="_blank" rel="noreferrer">ЕГРЮЛ ↗</a><a href={companyLookupUrls(supplier.supplier_inn).portal} target="_blank" rel="noreferrer">Портал ↗</a>
                        {supplier.enrichment?.phone && <a href={`tel:${supplier.enrichment.phone.replace(/[^+\d]/g, '')}`}>Позвонить</a>}
                        {supplier.enrichment?.email && <a href={`mailto:${supplier.enrichment.email}`}>Email</a>}
                      </div>
                    </div>
                  </article>)}
                  {!row.result?.recommendations.length && <p className="bulk-row-error">Подходящих кандидатов не найдено. Попробуйте уточнить описание или добавить ОКПД2.</p>}
                </div>}
              </details>
            })}
          </div>}
        </section>}
      </div>
    </main>
  )
}
