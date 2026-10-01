import { useEffect, useRef, useState } from 'react'
import { searchSuppliers, type SearchResult } from './api'

const EXAMPLES = ['ремонт автоэвакуатора ОКПД2 45.20.2', 'медицинские изделия', 'рыбные консервы', 'ИНН 7805198740']
const title = (supplier: SearchResult['recommendations'][number]) => supplier.supplier_name || `Поставщик ИНН ${supplier.supplier_inn}`

export default function App() {
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [selectedInn, setSelectedInn] = useState<string | null>(null)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [previewHeight, setPreviewHeight] = useState(360)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const suppliers = result?.recommendations ?? []
  const selected = focused ? suppliers.find(s => s.supplier_inn === selectedInn) : undefined

  useEffect(() => {
    const controller = new AbortController()
    setResult(null); setError(''); setSelectedInn(null)
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
                }
              }}
            />
            {query && <button className="clear-search" aria-label="Очистить поиск" onClick={() => { setQuery(''); inputRef.current?.focus() }}>×</button>}
          </div>
          {!focused && !query && <p className="search-hint">Найдите поставщиков для вашей закупки</p>}
          {focused && (
            <div id="supplier-results" className="search-dropdown" style={{ minHeight: suppliers.length ? previewHeight : undefined }}>
              {query.trim().length < 2 ? (
                <div className="search-status">
                  <p>Опишите закупку или введите ИНН / ОКПД2</p>
                  {EXAMPLES.map(example => <button className="query-example" key={example} onClick={() => setQuery(example)}>{example}</button>)}
                </div>
              ) : loading ? <p className="search-status" role="status">Подбираем поставщиков…</p>
                : error ? <p className="search-status" role="alert">{error}</p>
                  : !suppliers.length ? <p className="search-status" role="status">Поставщики не найдены. Уточните предмет закупки или код ОКПД2.</p>
                    : <>
                      <div className="results-caption">{result?.mode === 'supplier_lookup' ? 'Найден поставщик' : `Кандидатов: ${result?.candidate_count} · ОКПД2 ${result?.category_division}`}{result?.search_fallback && ' · поиск расширен'}{result?.parsed_query.customer_inn && ' · учтён заказчик'}</div>
                      <div className="search-results">
                        {suppliers.map(item => (
                          <button key={item.supplier_inn} className={`search-result${selectedInn === item.supplier_inn ? ' is-active' : ''}`}
                            onMouseEnter={() => setSelectedInn(item.supplier_inn)} onFocus={() => setSelectedInn(item.supplier_inn)}
                            onClick={() => setSelectedInn(selectedInn === item.supplier_inn ? null : item.supplier_inn)}>
                            <span className="supplier-rank">{item.rank_score === null ? '✓' : item.rank}</span>
                            <span className="result-text"><span className="result-title">{title(item)}</span><span className="result-description">{item.profile_excerpt || item.source}</span></span>
                          </button>
                        ))}
                      </div>
                    </>}
            </div>
          )}
          <aside ref={previewRef} className="supplier-preview" aria-label="Опыт поставщика" aria-hidden={!selected}
            style={{ opacity: selected ? 1 : 0, pointerEvents: selected ? 'auto' : 'none' }}>
            {selected && <>
              <h2 className="supplier-title">{title(selected)}</h2>
              <p className="supplier-meta">ИНН {selected.supplier_inn} · ОКПД2 {selected.category_division}</p>
              {selected.rank_score !== null && <p className="supplier-score">Место {selected.rank} · балл {selected.rank_score.toFixed(3)}<small>Баллы сравнивают кандидатов в этом запросе.</small></p>}
              <p className="supplier-description">{selected.profile_excerpt}</p>
              <div className="supplier-history">
                <div><strong>{selected.history.participations}</strong><span>участий в ЭМ</span></div>
                <div><strong>{selected.history.wins}</strong><span>побед в ЭМ</span></div>
                <div><strong>{selected.history.category_wins}</strong><span>побед в категории</span></div>
              </div>
              <h3>Почему в выдаче</h3>
              <ul className="supplier-reasons">{selected.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
              <p className="supplier-source">{selected.source}</p>
              {selected.source_url.startsWith('https://') && <a className="supplier-link" href={selected.source_url} target="_blank" rel="noreferrer">Профиль в источнике ↗</a>}
            </>}
          </aside>
        </div>
      </div>
    </main>
  )
}
