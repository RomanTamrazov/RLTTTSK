import { useEffect, useRef, useState } from 'react'
import { lookupEgrul, searchSuppliers, type SearchResult } from './api'

const EXAMPLES = ['ремонт автоэвакуатора ОКПД2 45.20.2', 'медицинские изделия', 'рыбные консервы', 'ИНН 7805198740']
const title = (supplier: SearchResult['recommendations'][number]) => supplier.supplier_name || `Поставщик ИНН ${supplier.supplier_inn}`
const companyLookupUrls = (inn: string) => ({
  fns: 'https://egrul.nalog.ru/index.html',
  saby: `https://saby.ru/profile/${encodeURIComponent(inn)}`,
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
  const [egrul, setEgrul] = useState<{ inn: string; loading: boolean; companies?: { name: string; ogrn: string; registered: string; kind: string }[]; error?: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const suppliers = result?.recommendations ?? []
  const pageCount = Math.max(1, Math.ceil(suppliers.length / 5))
  const pageSuppliers = suppliers.slice(page * 5, page * 5 + 5)
  const selected = focused ? suppliers.find(s => s.supplier_inn === selectedInn) : undefined

  function submitSearch(value = query) {
    const clean = value.trim()
    setFocused(true)
    if (clean.length < 2) return
    setQuery(clean); setSubmittedQuery(clean); setSearchRun(run => run + 1)
  }

  function verifyEgrul(inn: string) {
    setEgrul({ inn, loading: true })
    lookupEgrul(inn)
      .then(data => setEgrul({ inn, loading: false, companies: data.companies }))
      .catch(err => setEgrul({ inn, loading: false, error: err instanceof Error ? err.message : 'ФНС не ответила.' }))
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
    const closePanels = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setFocused(false)
      setSelectedInn(null)
    }
    document.addEventListener('keydown', closePanels)
    return () => document.removeEventListener('keydown', closePanels)
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
            <div id="supplier-results" className={`search-dropdown${selected ? ' has-preview' : ''}`}>
              {query.trim().length < 2 ? <div className="search-status">
                <p>Опишите закупку или введите ИНН / ОКПД2</p>
                {EXAMPLES.map(example => <button className="query-example" key={example} onClick={() => { setQuery(example); submitSearch(example) }}>{example}</button>)}
              </div> : submittedQuery !== query.trim() ? <p className="search-status">Нажмите кнопку поиска или Enter, чтобы подобрать кандидатов.</p>
                : loading ? <p className="search-status loading-status" role="status">Подбираем поставщиков<span className="loading-dots" aria-hidden="true">…</span></p>
                : error ? <p className="search-status" role="alert">{error}</p>
                  : !suppliers.length ? <p className="search-status" role="status">{result?.parsed_query.package_size
                    ? `Поставщики с фасовкой ${result.parsed_query.package_size} ${result.parsed_query.package_unit} не найдены. Проверьте фасовку или уберите её из запроса.`
                    : 'Поставщики не найдены. Уточните предмет закупки или код ОКПД2.'}</p>
                    : <>
                      <div className="results-caption">{result?.mode === 'supplier_lookup' ? 'Найден поставщик' : `Кандидатов: ${result?.candidate_count} · ${result?.category_division ? `ОКПД2 ${result.category_division}` : 'несколько разделов ОКПД2'}`}{result?.search_fallback && ' · поиск расширен'}{result?.parsed_query.customer_inn && ' · учтён заказчик'}</div>
                      {result?.parsed_query && (result.parsed_query.requested_quantity || result.parsed_query.package_size) && <div className="request-quantity">
                        Запрос: {result.parsed_query.purchase_text || 'закупка'}
                        {result.parsed_query.requested_quantity && <> · количество {result.parsed_query.requested_quantity.toLocaleString('ru-RU')} {result.parsed_query.quantity_unit}</>}
                        {result.parsed_query.package_size && <> · фасовка {result.parsed_query.package_size} {result.parsed_query.package_unit}</>}
                      </div>}
                      <div className="search-results">
                        {pageSuppliers.map((item, index) => (
                          <button key={item.supplier_inn} style={{ animationDelay: `${index * 35}ms` }} className={`search-result${selectedInn === item.supplier_inn ? ' is-active' : ''}`}
                            onMouseEnter={() => setSelectedInn(item.supplier_inn)} onFocus={() => setSelectedInn(item.supplier_inn)}
                            onClick={() => setSelectedInn(item.supplier_inn)}>
                            <span className="supplier-rank">{item.rank}</span>
                            <span className="result-text"><span className="result-title">{title(item)}</span><span className="result-description">ОКПД2 {item.category_division}</span></span>
                            <span className={`result-contact-status${item.has_contacts ? ' is-available' : ''}`}>{item.has_contacts ? 'Контакты есть' : 'Проверить'}</span>
                          </button>
                        ))}
                      </div>
                      {suppliers.length > 5 && <nav className="candidate-pagination" aria-label="Страницы кандидатов">
                        <button type="button" aria-label="Предыдущие кандидаты" disabled={page === 0} onClick={() => { setPage(page - 1); setSelectedInn(null) }}>‹</button>
                        <span>{page + 1} / {pageCount}</span>
                        <button type="button" aria-label="Следующие кандидаты" disabled={page + 1 >= pageCount} onClick={() => { setPage(page + 1); setSelectedInn(null) }}>›</button>
                      </nav>}
                    </>}
              {selected && <aside className="supplier-preview" aria-label="Подробности о поставщике">
                <div key={selected.supplier_inn} className="supplier-preview-content">
                  <h2 className="supplier-title">{title(selected)}</h2>
                  <p className="supplier-meta">ИНН {selected.supplier_inn} · ОКПД2 {selected.category_division}</p>
                  <div className="supplier-primary-details">
                  <section className="supplier-offer" aria-label="Цена поставщика">
                    <strong>Цена</strong>
                    <b>{selected.offer?.price || 'Цена по запросу'}</b>
                    {selected.offer?.price_unit && <span>{selected.offer.price_unit}</span>}
                    {selected.offer?.title && <span>Позиция: {selected.offer.title}</span>}
                    {selected.offer?.price_note && <small>{selected.offer.price_note}</small>}
                    {selected.offer?.availability && <small>Наличие: {selected.offer.availability}</small>}
                    {selected.offer?.offer_checked_date ? <small>Публичное предложение проверено {selected.offer.offer_checked_date}. Итоговую цену и наличие подтвердит поставщик.</small>
                      : <small>Подтверждённого прайса для этого запроса нет. Итоговую стоимость, объём и доставку уточните у поставщика.</small>}
                    {selected.offer?.offer_url.startsWith('https://') && <a href={selected.offer.offer_url} target="_blank" rel="noreferrer">Карточка предложения ↗</a>}
                  </section>
                  <div className="supplier-contact">
                    <h3>Контакты и связь</h3>
                    {selected.enrichment?.phone && <a href={`tel:${selected.enrichment.phone.replace(/[^+\d]/g, '')}`}>Позвонить: {selected.enrichment.phone}</a>}
                    {selected.enrichment?.email?.includes('@') && <a href={`mailto:${selected.enrichment.email}`}>Написать: {selected.enrichment.email}</a>}
                    {selected.enrichment?.website?.startsWith('https://') && <a href={selected.enrichment.website} target="_blank" rel="noreferrer">Сайт компании ↗</a>}
                    {selected.enrichment?.contact_url?.startsWith('https://') && <a href={selected.enrichment.contact_url} target="_blank" rel="noreferrer">Страница компании ↗</a>}
                    {selected.enrichment?.contact_source?.startsWith('https://') && <small>Опубликованный контакт · проверено {selected.enrichment.contact_checked_date} · <a href={selected.enrichment.contact_source} target="_blank" rel="noreferrer">источник ↗</a></small>}
                    {!selected.enrichment?.phone && !selected.enrichment?.email &&
                      <small>Телефон и email в открытых источниках не подтверждены. Проверьте профиль компании по ИНН.</small>}
                    <a href={companyLookupUrls(selected.supplier_inn).portal} target="_blank" rel="noreferrer">Профиль на Портале поставщиков · ИНН {selected.supplier_inn} ↗</a>
                  </div>
                  </div>
                  <div className="supplier-discovery-links">
                    <a href={companyLookupUrls(selected.supplier_inn).saby} target="_blank" rel="noreferrer">Найти телефон и карточку в Saby Profile · ИНН {selected.supplier_inn} ↗</a>
                    <a href="https://spark-interfax.ru/" target="_blank" rel="noreferrer" onClick={() => navigator.clipboard?.writeText(selected.supplier_inn).catch(() => {})}>Искать компанию в СПАРК · скопировать ИНН ↗</a>
                    <a href="https://saby.ru/tenders_api" target="_blank" rel="noreferrer">Открыть Saby Trade ↗</a>
                    <button type="button" className="lookup-button" onClick={() => verifyEgrul(selected.supplier_inn)}>
                      Проверить ЕГРЮЛ по ИНН {egrul?.inn === selected.supplier_inn && egrul.loading ? '…' : '↗'}
                    </button>
                    <a href={companyLookupUrls(selected.supplier_inn).fns} target="_blank" rel="noreferrer" onClick={() => navigator.clipboard?.writeText(selected.supplier_inn).catch(() => {})}>Открыть сайт ФНС · скопировать ИНН ↗</a>
                  </div>
                  {egrul?.inn === selected.supplier_inn && !egrul.loading && <div className="egrul-result" role="status">
                    {egrul.error ? <p>{egrul.error}</p> : egrul.companies?.length ? egrul.companies.map(company =>
                      <p key={company.ogrn}><strong>Результат поиска ФНС:</strong> {company.name} · {company.kind} · ОГРН/ОГРНИП {company.ogrn}{company.registered && ` · регистрация ${company.registered}`}</p>
                    ) : <p>По этому ИНН ФНС не вернула запись.</p>}
                  </div>}
                </div>
              </aside>}
            </div>
          )}
        </div>

      </div>
    </main>
  )
}
