import { useEffect, useRef, useState } from 'react'
import { lookupEgrul, searchSuppliers, type SearchOptions, type SearchResult, type Supplier } from './api'
import { downloadPurchaseTemplate, downloadRecommendations } from './purchaseCsv'
import { type PurchaseRecommendations } from './purchaseCsv'
import { importPurchaseFiles } from './importPurchases'
import LotBrowser from './LotBrowser'
import HistoryTrail, { CustomerLinks } from './HistoryTrail'
import { initialRows, runPurchaseBatch } from './batch'
import { companyLinks, contactLinks, dateLabel, parseBudget, rubles, safeUrl, supplierTitle } from './presentation'

type SavedSupplier = { supplier: Supplier; query: string; budget?: number; savedAt: string }
const STORAGE = 'rltttsk-shortlist-v1'
const BULK_STORAGE = 'rltttsk-lots-session-v1'
const EXAMPLES = ['ремонт автоэвакуатора ОКПД2 45.20.2', 'медицинские перчатки', 'рыбные консервы', 'ИНН 7801314509']
function readSaved(): SavedSupplier[] {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE) || '[]')
    return Array.isArray(data) ? data.filter(row => row?.supplier && typeof row.supplier.supplier_inn === 'string'
      && /^\d{10}(?:\d{2})?$/.test(row.supplier.supplier_inn) && Array.isArray(row.supplier.reasons)
      && row.supplier.history && typeof row.query === 'string').slice(0, 30) : []
  } catch { return [] }
}
function readBulk() {
  try {
    const data = JSON.parse(sessionStorage.getItem(BULK_STORAGE) || 'null')
    if (!data || !Array.isArray(data.rows) || !data.rows.length || !Array.isArray(data.headers) || data.rows.length > 200) return null
    if (!data.rows.every((row: PurchaseRecommendations) => row?.purchase && typeof row.purchase.id === 'string' && typeof row.purchase.query === 'string' && Array.isArray(row.purchase.sourceValues) && row.purchase.options)) return null
    data.rows = data.rows.map((row: PurchaseRecommendations) => row.status === 'running' ? { purchase: row.purchase, status: 'cancelled' } : row)
    return data as { rows: PurchaseRecommendations[]; headers: string[]; fileName: string; warnings: string[]; itemCount: number }
  } catch { return null }
}
const fileKey = (file: File) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`
const rowKey = (row: PurchaseRecommendations['purchase']) => `${row.sourceFile || ''}\u0000${row.rowNumber}\u0000${row.id}`
const sameRequest = (a: PurchaseRecommendations['purchase'], b: PurchaseRecommendations['purchase']) =>
  a.query === b.query && a.searchQuery === b.searchQuery && JSON.stringify(a.options) === JSON.stringify(b.options)
function Icon({ name }: { name: 'search' | 'arrow' | 'check' | 'plus' | 'close' | 'download' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'search' ? <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>
      : name === 'arrow' ? <><path d="M5 12h14M13 6l6 6-6 6" /></>
        : name === 'check' ? <path d="m5 12 4 4L19 6" />
          : name === 'close' ? <path d="m6 6 12 12M18 6 6 18" />
            : name === 'download' ? <><path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4" /></>
              : <path d="M12 5v14M5 12h14" />}
  </svg>
}
function Contacts({ supplier, expanded = false }: { supplier: Supplier; expanded?: boolean }) {
  const c = contactLinks(supplier)
  const hasContacts = Boolean(c.phone || c.email || c.website)
  return <div className="contacts">
    <div className="contact-actions">
      {c.phone && <a href={c.phone.href} aria-label={'Позвонить ' + supplierTitle(supplier)}>{c.phone.label}</a>}
      {c.email && <a href={c.email.href} title={c.email.label}>{expanded ? c.email.label : 'Email ↗'}</a>}
      {c.website && <a href={c.website} target="_blank" rel="noreferrer">Сайт ↗</a>}
      {!hasContacts && <><span className="muted">Контакты не найдены</span><a href={c.lookup} target="_blank" rel="noreferrer">Найти по ИНН ↗</a></>}
    </div>
    {expanded && hasContacts && <small className="contact-source">{c.source ? <a href={c.source} target="_blank" rel="noreferrer">Источник контактов ↗</a> : 'Контакт из профиля'}
      {supplier.enrichment?.contact_checked_date && ' · проверен ' + dateLabel(supplier.enrichment.contact_checked_date)}</small>}
  </div>
}
function Price({ supplier, compact = false }: { supplier: Supplier; compact?: boolean }) {
  const history = supplier.pricing?.historical_purchase
  const offer = supplier.offer
  const offerUrl = safeUrl(offer?.offer_url)
  return <div className={'price-block' + (compact ? ' compact' : '')}>
    <div><span className="eyebrow">Цена поставщика</span><strong>{offer?.price || 'По запросу'}{offer?.price_unit ? ` ${offer.price_unit}` : ''}</strong>
      {offer?.title && !compact && <small>{offer.title}</small>}
      {offer?.offer_checked_date && !compact && <small>Публичное предложение проверено {dateLabel(offer.offer_checked_date)}</small>}
      {offerUrl && !compact && <a href={offerUrl} target="_blank" rel="noreferrer">Источник предложения ↗</a>}</div>
    {history ? <div><span className="eyebrow">Бюджет похожей закупки</span><strong>{rubles(history.start_price)}</strong><small>{dateLabel(history.publish_date)} · лот {history.lot_id}</small></div>
      : !compact && <p className="muted">Сопоставимый исторический бюджет не найден.</p>}
    {!compact && <p className="price-note">Исторический бюджет относится ко всему лоту. Объём, состав, наличие и итоговую цену подтвердит поставщик.</p>}
  </div>
}

function LotCandidate({ supplier, row }: { supplier: Supplier; row: PurchaseRecommendations }) {
  const [expanded, setExpanded] = useState(false)
  const links = companyLinks(supplier.supplier_inn)
  return <article className={'bulk-candidate' + (expanded ? ' expanded' : '')}>
    <button className="candidate-open" type="button" aria-expanded={expanded}
      aria-label={(expanded ? 'Свернуть' : 'Открыть') + ' карточку поставщика ' + supplierTitle(supplier)} onClick={() => setExpanded(value => !value)}>
      <span className="candidate-identity"><span className="rank">#{supplier.rank}</span><strong>{supplierTitle(supplier)}</strong>
        <small>ИНН {supplier.supplier_inn} · ОКПД2 {supplier.category_division}</small>
        <span className="candidate-excerpt">{supplier.profile_excerpt || supplier.reasons[0]}</span>
        <span className="candidate-cta">{expanded ? 'Скрыть опыт и историю ↑' : 'Открыть опыт и историю →'}</span></span>
      <span className="candidate-price"><span className="muted">Бюджет лота: {rubles(row.purchase.options.start_price)}</span><Price supplier={supplier} /></span>
    </button>
    <div className="candidate-actions"><Contacts supplier={supplier} expanded />
      <div className="source-links"><a href={links.fns} target="_blank" rel="noreferrer">Компания в ФНС ↗</a><a href={links.portal} target="_blank" rel="noreferrer">На портале ↗</a></div></div>
    {expanded && <div className="candidate-expanded"><div className="candidate-evidence"><div><strong>{supplier.history.participations}</strong><span>участий в ЭМ</span></div>
      <div><strong>{supplier.history.wins}</strong><span>побед в ЭМ</span></div><div><strong>{supplier.history.buyer_participations}</strong><span>у этого заказчика</span></div></div>
      <h4>Почему подходит</h4><ul className="reasons">{supplier.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
      <HistoryTrail supplier={supplier} /></div>}
  </article>
}

export default function App() {
  const [restoredBulk] = useState(readBulk)
  const [tab, setTab] = useState<'search' | 'bulk' | 'saved'>('search')
  const [query, setQuery] = useState('')
  const [code, setCode] = useState('')
  const [customer, setCustomer] = useState('')
  const [budgetText, setBudgetText] = useState('')
  const [applied, setApplied] = useState<{ query: string; options: SearchOptions } | null>(null)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [selected, setSelected] = useState<Supplier | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [page, setPage] = useState(0)
  const [saved, setSaved] = useState<SavedSupplier[]>(readSaved)
  const [notice, setNotice] = useState('')
  const [compare, setCompare] = useState<Supplier[]>([])
  const [compareOpen, setCompareOpen] = useState(false)
  const [egrul, setEgrul] = useState<{ inn: string; loading: boolean; companies?: { name: string; ogrn: string; registered: string; kind: string }[]; error?: string } | null>(null)
  const [csvHeaders, setCsvHeaders] = useState<string[]>(restoredBulk?.headers || [])
  const [bulkRows, setBulkRows] = useState<PurchaseRecommendations[]>(restoredBulk?.rows || [])
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkError, setBulkError] = useState('')
  const [fileName, setFileName] = useState(restoredBulk?.fileName || '')
  const [importWarnings, setImportWarnings] = useState<string[]>(restoredBulk?.warnings || [])
  const [itemCount, setItemCount] = useState(restoredBulk?.itemCount || 0)
  const [stagedFiles, setStagedFiles] = useState<File[]>([])
  const [uploadHint, setUploadHint] = useState('')
  const [uploading, setUploading] = useState(false)
  const [datasetVersion, setDatasetVersion] = useState(0)
  const stagedFilesRef = useRef<File[]>([])
  const uploadingRef = useRef(false)
  const searchController = useRef<AbortController | null>(null)
  const bulkController = useRef<AbortController | null>(null)
  const detailRef = useRef<HTMLElement | null>(null)
  const compareDialog = useRef<HTMLDialogElement | null>(null)
  const suppliers = result?.recommendations ?? []
  const visible = tab === 'saved' ? saved.map(row => row.supplier) : suppliers.slice(page * 6, page * 6 + 6)
  const finished = bulkRows.filter(row => ['done', 'empty', 'error'].includes(row.status)).length
  const bulkCounts = {
    done: bulkRows.filter(row => row.status === 'done').length,
    empty: bulkRows.filter(row => row.status === 'empty').length,
    error: bulkRows.filter(row => row.status === 'error').length,
    remaining: bulkRows.filter(row => ['pending', 'running', 'cancelled'].includes(row.status)).length,
  }
  const retryIndices = bulkRows.map((row, index) => (['error', 'cancelled', 'pending'].includes(row.status) && !row.purchase.validationError) ? index : -1).filter(index => index >= 0)

  useEffect(() => {
    try { localStorage.setItem(STORAGE, JSON.stringify(saved)) } catch { setNotice('Браузер не разрешил сохранить список. Скачайте CSV, чтобы сохранить выбранных поставщиков.') }
  }, [saved])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { sessionStorage.setItem(BULK_STORAGE, JSON.stringify({ rows: bulkRows, headers: csvHeaders, fileName, warnings: importWarnings, itemCount })) }
      catch { setNotice('Не удалось сохранить результаты в этой вкладке. Скачайте CSV перед обновлением страницы.') }
    }, 300)
    return () => window.clearTimeout(timer)
  }, [bulkRows, csvHeaders, fileName, importWarnings, itemCount])
  useEffect(() => () => { searchController.current?.abort(); bulkController.current?.abort() }, [])
  useEffect(() => {
    const dialog = compareDialog.current
    if (compareOpen && dialog && !dialog.open) dialog.showModal()
    else if (!compareOpen && dialog?.open) dialog.close()
  }, [compareOpen])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function submitSearch(value = query) {
    let options: SearchOptions
    const clean = value.trim()
    try {
      if (clean.length < 2) throw new Error('Опишите закупку или введите ИНН / ОКПД2.')
      if (code && !/^\d{2}(?:\.\d{1,3}){0,4}$/.test(code.trim())) throw new Error('Проверьте код ОКПД2, например 45.20.2.')
      if (customer && !/^\d{10}(?:\d{2})?$/.test(customer.trim())) throw new Error('ИНН заказчика должен содержать 10 или 12 цифр.')
      const budget = parseBudget(budgetText)
      options = { ...(code.trim() ? { okpd2_code: code.trim() } : {}), ...(customer.trim() ? { customer_inn: customer.trim() } : {}),
        ...(budget !== undefined ? { start_price: budget } : {}) }
    } catch (err) { setError((err as Error).message); return }
    searchController.current?.abort()
    const controller = new AbortController(); searchController.current = controller
    setTab('search'); setQuery(clean); setApplied({ query: clean, options }); setLoading(true); setResult(null); setSelected(null); setPage(0); setError(''); setCompare([])
    try {
      const data = await searchSuppliers(clean, controller.signal, options)
      if (!controller.signal.aborted) { setResult(data); setSelected(data.recommendations[0] || null) }
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Не удалось выполнить поиск.') }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  function toggleSave(supplier: Supplier) {
    if (saved.some(row => row.supplier.supplier_inn === supplier.supplier_inn)) {
      setSaved(rows => rows.filter(row => row.supplier.supplier_inn !== supplier.supplier_inn)); setNotice('Поставщик удалён из выбранных.')
    } else {
      if (saved.length >= 30) { setNotice('В списке уже 30 компаний. Выгрузите CSV или удалите часть компаний.'); return }
      setSaved(rows => [...rows, { supplier, query: applied?.query || 'Поиск поставщика', budget: applied?.options.start_price, savedAt: new Date().toISOString() }])
      setNotice('Поставщик добавлен в выбранные.')
    }
  }
  function toggleCompare(supplier: Supplier) {
    if (compare.some(item => item.supplier_inn === supplier.supplier_inn)) setCompare(items => items.filter(item => item.supplier_inn !== supplier.supplier_inn))
    else if (compare.length < 3) setCompare(items => [...items, supplier])
    else setNotice('В сравнении могут быть три компании. Уберите одну, чтобы добавить другую.')
  }
  function openSupplier(supplier: Supplier) {
    setSelected(supplier)
    if (window.innerWidth < 1000) window.setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }
  async function applyFiles(next: File[], previous: File[]) {
    uploadingRef.current = true; setUploading(true); setBulkError(''); setUploadHint('')
    try {
      if (!next.length) {
        setBulkRows([]); setCsvHeaders([]); setFileName(''); setImportWarnings([]); setItemCount(0)
        setDatasetVersion(version => version + 1)
        return
      }
      const parsed = await importPurchaseFiles(next)
      setCsvHeaders(parsed.headers)
      setBulkRows(current => {
        const known = new Map(current.map(row => [rowKey(row.purchase), row]))
        return parsed.purchases.map(purchase => {
          const old = known.get(rowKey(purchase))
          return old && sameRequest(old.purchase, purchase) ? { ...old, purchase } : initialRows([purchase])[0]
        })
      })
      setFileName(`${parsed.files.length} CSV · ${parsed.purchases.length} лотов · ${parsed.itemCount} позиций ТРУ`)
      setImportWarnings(parsed.warnings); setItemCount(parsed.itemCount)
      setUploadHint(parsed.provisionalOnly
        ? 'Лоты собраны по ТРУ: их можно открыть и выполнить подбор. Добавьте CSV извещений для бюджета, заказчика и точного предмета.'
        : parsed.itemCount ? 'Извещения и ТРУ объединены по lot_id. Выберите лот или запустите подбор.'
          : 'Извещения загружены. Добавьте CSV ТРУ, чтобы увидеть состав лотов и уточнить подбор.')
      setDatasetVersion(version => version + 1)
    } catch (err) {
      stagedFilesRef.current = previous; setStagedFiles(previous)
      setBulkError(err instanceof Error ? err.message : 'Не удалось прочитать CSV.')
    } finally { uploadingRef.current = false; setUploading(false) }
  }
  function addCsv(files: File[]) {
    if (!files.length || bulkController.current || uploadingRef.current) return
    if (files.some(file => !/\.csv$/i.test(file.name))) { setBulkError('Можно добавить только CSV-файлы. ZIP сначала распакуйте.'); return }
    const previous = stagedFilesRef.current
    const known = new Set(previous.map(fileKey))
    const fresh = files.filter(file => { const key = fileKey(file); if (known.has(key)) return false; known.add(key); return true })
    if (!fresh.length) { setNotice('Эти CSV уже добавлены.'); return }
    const next = [...previous, ...fresh]
    if (next.length > 12) { setBulkError('В одном наборе можно добавить до 12 CSV-файлов.'); return }
    if (next.some(file => file.size > 5 * 1024 * 1024) || next.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) {
      setBulkError('Лимит: 5 МБ на файл и 20 МБ на весь набор.'); return
    }
    if (bulkRows.length && !previous.length) setNotice('Для дополнения набора после обновления страницы добавьте все исходные CSV снова.')
    stagedFilesRef.current = next; setStagedFiles(next); void applyFiles(next, previous)
  }
  function removeCsv(index: number) {
    if (bulkController.current || uploadingRef.current) return
    const previous = stagedFilesRef.current
    const next = previous.filter((_, i) => i !== index)
    stagedFilesRef.current = next; setStagedFiles(next); void applyFiles(next, previous)
  }
  function clearCsv() {
    if (bulkController.current || uploadingRef.current) return
    const previous = stagedFilesRef.current
    stagedFilesRef.current = []; setStagedFiles([]); void applyFiles([], previous)
  }
  async function runBulk(indices?: number[]) {
    if (!bulkRows.length || bulkController.current) return
    const controller = new AbortController(); bulkController.current = controller; setBulkRunning(true); setBulkError('')
    try { await runPurchaseBatch(bulkRows, controller.signal, setBulkRows, searchSuppliers, indices) }
    catch (err) { setBulkError(err instanceof Error ? err.message : 'Обработка прервана.') }
    finally { if (bulkController.current === controller) { bulkController.current = null; setBulkRunning(false) } }
  }
  function exportSaved() {
    downloadRecommendations(['Поисковый запрос', 'Сохранено'], saved.map((row, index) => ({
      purchase: { rowNumber: index + 2, id: row.supplier.supplier_inn, query: row.query, sourceValues: [row.query, row.savedAt],
        options: { start_price: row.budget } }, status: 'done',
      result: { mode: 'recommendations', candidate_count: 1, category_division: row.supplier.category_division,
        parsed_query: { purchase_text: row.query, okpd2_code: null, customer_inn: null, supplier_inn: null }, recommendations: [row.supplier] },
    })))
  }
  const selectedContacts = selected ? contactLinks(selected) : null
  function verifyEgrul(inn: string) {
    setEgrul({ inn, loading: true })
    lookupEgrul(inn).then(data => setEgrul({ inn, loading: false, companies: data.companies }))
      .catch(error => setEgrul({ inn, loading: false, error: error instanceof Error ? error.message : 'ФНС не ответила.' }))
  }
  const savedContext = tab === 'saved' ? saved.find(row => row.supplier.supplier_inn === selected?.supplier_inn) : undefined
  const selectedQuery = savedContext?.query || applied?.query || ''
  const selectedBudget = tab === 'saved' ? savedContext?.budget : applied?.options.start_price
  const quoteEmail = selectedContacts?.email ? selectedContacts.email.href + '?subject=' + encodeURIComponent('Запрос цены: ' + (selectedQuery || 'закупка')) +
    '&body=' + encodeURIComponent('Здравствуйте!\nПросим уточнить возможность поставки / выполнения работ: ' + selectedQuery +
      '\nБюджет закупки: ' + rubles(selectedBudget) + '\nПросим указать стоимость, сроки, состав предложения и условия оплаты.\nСпасибо!') : null

  return <main className={'app' + (tab === 'bulk' && bulkRows.length ? ' bulk-ready-view' : '')}>
    <header className="topbar"><a className="brand" href="#" onClick={event => { event.preventDefault(); setTab('search') }}>RLTTTSK<span>ПОИСК ПОСТАВЩИКОВ</span></a>
      <span className="version-badge"><i />Пилотная версия</span></header>
    <section className="hero">
      <img src={import.meta.env.BASE_URL + 'images/petersburg-sketch.png'} alt="" aria-hidden="true" className="city-background" />
      <div className="hero-content"><span className="eyebrow">ЗАКУПКИ · КОМПАНИИ · РЕШЕНИЯ</span>
        <h1>Поставщики под<br /><em>вашу закупку.</em></h1>
        <p>Найдите подходящие компании, сравните опыт и свяжитесь<br className="desktop-break" /> с поставщиком — в одном рабочем пространстве.</p></div>
      <div className="hero-aside"><span>01 / ПОИСК И СРАВНЕНИЕ</span><p>От запроса<br />к короткому списку.</p><small>История закупок 2024–2025<br />и сведения из открытых источников</small></div>
    </section>
    <div className="workspace">
      <nav className="tabs" aria-label="Разделы">
        <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>Поиск поставщиков</button>
        <button className={tab === 'bulk' ? 'active' : ''} onClick={() => setTab('bulk')}>Список закупок CSV{bulkRunning && <span className="tab-count">…</span>}</button>
        <button className={tab === 'saved' ? 'active' : ''} onClick={() => { setTab('saved'); setSelected(saved[0]?.supplier || null) }}>Выбранные<span className="tab-count">{saved.length}</span></button>
      </nav>
      {tab === 'search' && <section className="search-panel" aria-label="Параметры закупки">
        <div className="flow-hint" aria-label="Как пользоваться поиском"><span><b>1</b> Опишите закупку</span><span><b>2</b> Откройте компанию</span><span><b>3</b> Сравните и свяжитесь</span></div>
        <form onSubmit={event => { event.preventDefault(); void submitSearch() }}>
          <label className="field-label" htmlFor="query">Предмет закупки, ИНН поставщика или ОКПД2</label>
          <div className="search-shell"><Icon name="search" /><input id="query" type="search" value={query} maxLength={500} autoComplete="off" placeholder="Например, ремонт автоэвакуатора"
            onChange={event => setQuery(event.target.value)} /><button className="button primary" type="submit">{loading ? 'Подбираем…' : 'Найти поставщиков'}<Icon name="arrow" /></button></div>
          <div className="search-options">
            <label>Бюджет закупки, ₽<input inputMode="decimal" value={budgetText} onChange={event => setBudgetText(event.target.value)} placeholder="Например, 450 000" /></label>
            <label>Код ОКПД2<input value={code} onChange={event => setCode(event.target.value)} placeholder="Необязательно" /></label>
            <label>ИНН заказчика<input inputMode="numeric" value={customer} onChange={event => setCustomer(event.target.value)} placeholder="Для учёта прошлого опыта" maxLength={12} /></label>
          </div>
        </form>
        <div className="examples"><span>Попробуйте:</span>{EXAMPLES.map(example => <button key={example} onClick={() => void submitSearch(example)}>{example}</button>)}</div>
        {error && <div className="alert error" role="alert">{error}<button onClick={() => void submitSearch()}>Повторить поиск</button></div>}
      </section>}
      {tab === 'bulk' ? <section className="bulk-panel">
        <div className="section-heading"><div><span className="eyebrow">ЛОТЫ И РЕКОМЕНДАЦИИ</span><h2>Добавьте CSV и выберите лот</h2><p>Извещения и ТРУ можно добавлять по одному или сразу несколькими файлами. Сайт соберёт лоты по lot_id.</p></div>
          <button className="button secondary" onClick={downloadPurchaseTemplate}><Icon name="download" />Шаблон CSV</button></div>
        <div className="flow-hint bulk-flow" aria-label="Порядок работы с CSV"><span><b>1</b> Загрузите файлы</span><span><b>2</b> Выберите лот</span><span><b>3</b> Получите рекомендации</span></div>
        <div className={'upload-area' + (bulkRows.length || stagedFiles.length ? ' has-files' : '')}>
          <label className={'upload-button' + (bulkRunning || uploading ? ' disabled' : '')}
            onDragOver={event => event.preventDefault()}
            onDrop={event => { event.preventDefault(); addCsv(Array.from(event.dataTransfer.files)) }}>
            <span className="upload-icon">↑</span><strong>{stagedFiles.length ? 'Добавить ещё CSV' : 'Добавить CSV извещений и ТРУ'}</strong>
            <small>Выбирайте несколько файлов сразу или добавляйте по одному · можно перетащить сюда</small>
            <input aria-label="Загрузить CSV" type="file" accept=".csv,text/csv" multiple disabled={bulkRunning || uploading}
              onChange={event => { addCsv(Array.from(event.target.files || [])); event.currentTarget.value = '' }} />
          </label>
          {stagedFiles.length > 0 && <div className="staged-files"><div className="staged-heading"><strong>В наборе {stagedFiles.length} CSV</strong><button type="button" disabled={bulkRunning || uploading} onClick={clearCsv}>Очистить набор</button></div>
            <ul>{stagedFiles.map((file, index) => <li key={fileKey(file)}><span title={file.name}>{file.name}</span><small>{Math.max(1, Math.round(file.size / 1024))} КБ</small>
              <button type="button" aria-label={'Убрать файл ' + file.name} disabled={bulkRunning || uploading} onClick={() => removeCsv(index)}>×</button></li>)}</ul></div>}
          {fileName && <p className="upload-summary">{fileName}</p>}
          {uploadHint && <p className="upload-hint" role="status">{uploadHint}</p>}
          {!stagedFiles.length && bulkRows.length > 0 && <p className="upload-hint" role="status">Результаты восстановлены после обновления страницы. Чтобы добавить новые файлы к этому набору, выберите исходные CSV заново.</p>}
        </div>
        {!!importWarnings.length && <div className="import-warnings" role="status">{importWarnings.map(warning => <p key={warning}>{warning}</p>)}</div>}
        <p className="muted csv-help">Лоты и результаты сохраняются в этой вкладке. Для поиска сервису передаются описание закупки и заполненные параметры.</p>
        {bulkError && <p className="alert error" role="alert">{bulkError}</p>}
        {bulkRows.length > 0 && <>
          <div className="bulk-controls">
            <button className="button primary" disabled={bulkRunning || !bulkRows.some(row => row.status === 'pending')} onClick={() => void runBulk()}>{bulkRunning ? 'Подбираем поставщиков…' : 'Получить рекомендации'}<Icon name="arrow" /></button>
            {bulkRunning ? <button className="button secondary" onClick={() => bulkController.current?.abort()}>Остановить</button>
              : retryIndices.length > 0 && finished > 0 && <button className="button secondary" onClick={() => void runBulk(retryIndices)}>Повторить / продолжить ({retryIndices.length})</button>}
            <button className="button secondary" disabled={bulkRunning} onClick={() => downloadRecommendations(csvHeaders, bulkRows)}><Icon name="download" />Скачать CSV</button>
          </div>
          {bulkRunning && <progress value={finished} max={bulkRows.length} aria-label="Прогресс обработки CSV" />}
          <div className="bulk-stats" role="status"><div><strong>{bulkRows.length}</strong><span>лотов в файлах</span></div><div><strong>{itemCount}</strong><span>позиций ТРУ</span></div><div><strong>{bulkCounts.done}</strong><span>с рекомендациями</span></div><div><strong>{bulkCounts.empty}</strong><span>без кандидатов</span></div><div><strong>{bulkCounts.error}</strong><span>с ошибками</span></div><div><strong>{bulkCounts.remaining}</strong><span>не завершено</span></div></div>
          <LotBrowser key={datasetVersion} rows={bulkRows} running={bulkRunning} recommendOne={index => void runBulk([index])}
            renderCandidate={(supplier, row) => <LotCandidate supplier={supplier} row={row} />} />
        </>}
      </section> : <>
        {tab === 'saved' && <div className="section-heading saved-heading"><div><span className="eyebrow">КОРОТКИЙ СПИСОК</span><h2>Выбранные поставщики</h2><p>Список хранится в этом браузере. Сведения сохранены на момент добавления.</p></div>
          {saved.length > 0 && <button className="button secondary" onClick={exportSaved}><Icon name="download" />Скачать CSV</button>}</div>}
        {(result || tab === 'saved') && <div className="results-heading"><div><h2>{tab === 'saved' ? saved.length + ' компаний в списке' : result?.mode === 'supplier_lookup' ? 'Профиль поставщика' : 'Подходящие компании'}</h2>
          {tab === 'search' && <p>{result?.candidate_count} кандидатов рассмотрено{result?.category_division && ' · ОКПД2 ' + result.category_division}{result?.category_inferred && ' определён автоматически'}{result?.search_fallback && ' · поиск расширен'}</p>}</div>
          {tab === 'search' && <div className="budget-badge"><span>Бюджет закупки</span><strong>{rubles(applied?.options.start_price)}</strong>
            {applied?.options.customer_inn && <CustomerLinks inn={applied.options.customer_inn} compact />}</div>}</div>}
        {loading ? <div className="loading-grid" role="status" aria-label="Подбираем поставщиков">{[1, 2, 3].map(i => <div className="skeleton" key={i}><div /><div /><div /></div>)}</div>
          : !visible.length ? <div className="empty-state">
            <span className="empty-icon"><Icon name={tab === 'saved' ? 'plus' : 'search'} /></span>
            <h2>{tab === 'saved' ? 'Соберите свой короткий список' : result ? 'Подходящие компании пока не найдены' : 'Начните с предмета закупки'}</h2>
            <p>{tab === 'saved' ? 'Добавляйте компании из поиска, чтобы вернуться к ним и выгрузить контакты.' : result ? 'Уточните описание, укажите код ОКПД2 или найдите компанию по ИНН.' : 'Мы сопоставим специализацию компании, историю её закупок и опыт работы с заказчиком.'}</p>
          </div> : <div className="results-layout"><section className="supplier-list" aria-label="Список поставщиков">
            {visible.map(supplier => {
              const isSaved = saved.some(row => row.supplier.supplier_inn === supplier.supplier_inn)
              const isCompared = compare.some(row => row.supplier_inn === supplier.supplier_inn)
              return <article className={'supplier-card' + (selected?.supplier_inn === supplier.supplier_inn ? ' selected' : '')} key={supplier.supplier_inn}>
                <div className="card-head"><span className="rank">#{supplier.rank}</span><div><button className="supplier-name" onClick={() => openSupplier(supplier)}>{supplierTitle(supplier)}</button>
                  <p>ИНН {supplier.supplier_inn}{supplier.enrichment?.city && ' · ' + supplier.enrichment.city}</p></div>
                  <button className={'save-button' + (isSaved ? ' saved' : '')} aria-label={isSaved ? 'Убрать из выбранных' : 'Добавить в выбранные'} aria-pressed={isSaved} onClick={() => toggleSave(supplier)}><Icon name={isSaved ? 'check' : 'plus'} /></button></div>
                <div className="evidence-line"><span className="evidence-tag">{supplier.history.participations > 0 ? 'История конкурентных закупок' : 'Без истории конкуренции в ЭМ'}</span>
                  <span>{supplier.history.category_wins} побед в категории</span></div>
                <p className="card-description">{supplier.profile_excerpt || supplier.reasons[0]}</p>
                <Price supplier={supplier} compact />
                <Contacts supplier={supplier} expanded />
                <div className="card-footer"><span className="text-button">Открыть профиль и историю <Icon name="arrow" /></span>
                  <label className="compare-check"><input type="checkbox" checked={isCompared} onChange={() => toggleCompare(supplier)} />Сравнить</label></div>
              </article>
            })}
            {tab === 'search' && suppliers.length > 6 && <nav className="pagination" aria-label="Страницы результатов">
              <button className="button secondary" disabled={!page} onClick={() => setPage(page - 1)}>← Назад</button><span>{page + 1} / {Math.ceil(suppliers.length / 6)}</span>
              <button className="button secondary" disabled={(page + 1) * 6 >= suppliers.length} onClick={() => setPage(page + 1)}>Далее →</button></nav>}
          </section>
          {selected && <aside ref={detailRef} className="supplier-detail" aria-label="Подробности поставщика">
            <div className="detail-heading"><span className="eyebrow">ПРОФИЛЬ КОМПАНИИ</span><button className="icon-button" aria-label="Закрыть профиль" onClick={() => setSelected(null)}><Icon name="close" /></button></div>
            <h2>{supplierTitle(selected)}</h2><p className="muted">ИНН {selected.supplier_inn} · ОКПД2 {selected.category_division}</p>
            <div className="profile-overview"><span className="eyebrow">ЧЕМ ЗАНИМАЛАСЬ В АРХИВЕ</span>
              <p>{selected.profile_excerpt || 'Описание деятельности в выбранной категории не найдено.'}</p>
              <div className="profile-chips"><span>{selected.enrichment?.observed_lots ? `${selected.enrichment.observed_lots} записей закупок` : 'Архив закупок'}</span>
                {selected.enrichment?.last_activity && <span>Последняя запись {dateLabel(selected.enrichment.last_activity)}</span>}
                {selected.enrichment?.supplier_role && <span>{selected.enrichment.supplier_role}</span>}</div>
            </div>
            <section className="detail-section"><h3>Контактная информация</h3><Contacts supplier={selected} expanded />
              {quoteEmail && <a className="button primary quote-button" href={quoteEmail}>Подготовить запрос цены<Icon name="arrow" /></a>}
              {!quoteEmail && selectedContacts?.phone && <a className="button primary quote-button" href={selectedContacts.phone.href}>Уточнить цену по телефону<Icon name="arrow" /></a>}
              <button className="button secondary profile-save-button" onClick={() => toggleSave(selected)}>{saved.some(row => row.supplier.supplier_inn === selected.supplier_inn) ? 'Убрать из выбранных' : 'Добавить в выбранные'}</button>
            </section>
            <section className="detail-section"><h3>Бюджет и цена</h3><div className="detail-budget"><span>Бюджет вашей закупки</span><strong>{rubles(tab === 'saved' ? saved.find(row => row.supplier.supplier_inn === selected.supplier_inn)?.budget : applied?.options.start_price)}</strong></div>
              <Price supplier={selected} />
              {selected.pricing?.historical_purchase && <details className="history-example"><summary>Посмотреть похожую закупку</summary><p>{selected.pricing.historical_purchase.purchase_text}</p>
                <small>{selected.pricing.historical_purchase.channel} · архив 2024–2025 · лот {selected.pricing.historical_purchase.lot_id}<br />
                  {selected.pricing.historical_purchase.channel === 'ЭМ'
                    ? selected.pricing.historical_purchase.was_winner ? 'В ЭМ отмечена победителем этого лота; цена предложения отсутствует.' : 'В ЭМ отмечена другим участником; цена предложения отсутствует.'
                    : 'В АИС ГЗ есть запись о поставщике; конкурентный исход не подтверждён.'}</small></details>}
            </section>
            <section className="detail-section"><h3>Опыт в закупках ЭМ</h3><div className="history-stats"><div><strong>{selected.history.participations}</strong><span>участий</span></div><div><strong>{selected.history.wins}</strong><span>побед</span></div><div><strong>{selected.history.category_wins}</strong><span>в категории</span></div></div>
              {!selected.history.participations && <p className="muted">Отсутствие истории ЭМ не означает, что компания новая. Оценивайте её профиль и источники.</p>}
              {tab === 'search' && applied?.options.customer_inn && <div className="buyer-experience"><strong>С выбранным заказчиком</strong>
                <CustomerLinks inn={applied.options.customer_inn} compact />
                <span>{selected.history.buyer_participations} участий в ЭМ · {selected.history.buyer_wins} побед по архиву</span></div>}
              <HistoryTrail supplier={selected} /></section>
            <section className="detail-section"><h3>Сигналы соответствия закупке</h3><ul className="reasons">{selected.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></section>
            <section className="detail-section"><h3>Сведения и источники</h3><dl className="facts">
              {(selected.enrichment?.region || selected.enrichment?.city) && <><dt>Регистрация</dt><dd>{[selected.enrichment.region, selected.enrichment.city].filter(Boolean).join(', ')}</dd></>}
              {selected.enrichment?.primary_okved && <><dt>ОКВЭД</dt><dd>{selected.enrichment.primary_okved}</dd></>}
              {selected.enrichment?.last_activity && <><dt>Активность в архиве</dt><dd>{dateLabel(selected.enrichment.last_activity)}</dd></>}
              <dt>Роль компании</dt><dd>{selected.enrichment?.supplier_role || 'Требует подтверждения'}</dd></dl>
              <p className="muted">{selected.source}</p>
              {selected.enrichment?.snapshot_date && <p className="muted">Срез ФНС: {dateLabel(selected.enrichment.snapshot_date)}</p>}
              <div className="source-links"><button type="button" className="button secondary" onClick={() => verifyEgrul(selected.supplier_inn)}>Проверить ЕГРЮЛ{egrul?.inn === selected.supplier_inn && egrul.loading ? '…' : ' ↗'}</button><a href={companyLinks(selected.supplier_inn).fns} target="_blank" rel="noreferrer">Открыть ФНС ↗</a><a href={companyLinks(selected.supplier_inn).portal} target="_blank" rel="noreferrer">Портал поставщиков ↗</a>
                {safeUrl(selected.enrichment?.role_source) && <a href={safeUrl(selected.enrichment?.role_source)} target="_blank" rel="noreferrer">Подтверждение роли ↗</a>}
                {safeUrl(selected.source_url) && <a href={safeUrl(selected.source_url)} target="_blank" rel="noreferrer">Исходный профиль ↗</a>}</div>
              {egrul?.inn === selected.supplier_inn && !egrul.loading && <div role="status" className="egrul-result">{egrul.error ? <p>{egrul.error}</p> : egrul.companies?.length
                ? egrul.companies.map(company => <p key={company.ogrn}>{company.name} · {company.kind} · ОГРН {company.ogrn}{company.registered && ` · ${company.registered}`}</p>)
                : <p>По этому ИНН ФНС не вернула запись.</p>}</div>}</section>
          </aside>}
        </div>}
      </>}
      <footer className="footer"><span>RLTTTSK · Подбор поставщиков</span><span>Рекомендация помогает сформировать список для проверки. Условия и цену подтвердите у компании.</span></footer>
    </div>
    {compare.length > 0 && <div className="compare-bar"><span>В сравнении <strong>{compare.length} / 3</strong></span><button className="button primary" disabled={compare.length < 2} onClick={() => setCompareOpen(true)}>Сравнить компании<Icon name="arrow" /></button>
      <button className="icon-button" aria-label="Очистить сравнение" onClick={() => setCompare([])}><Icon name="close" /></button></div>}
    <dialog ref={compareDialog} className="compare-dialog" onCancel={() => setCompareOpen(false)} onClose={() => setCompareOpen(false)}>
      <div className="section-heading"><div><span className="eyebrow">СРАВНЕНИЕ КОМПАНИЙ</span><h2>Выберите поставщиков для проверки</h2></div><button className="icon-button" aria-label="Закрыть сравнение" onClick={() => setCompareOpen(false)}><Icon name="close" /></button></div>
      <div className="compare-table-wrap"><table className="compare-table"><thead><tr><th>Критерий</th>{compare.map(s => <th key={s.supplier_inn}>{supplierTitle(s)}<small>ИНН {s.supplier_inn}</small></th>)}</tr></thead><tbody>
        <tr><th>Контакты</th>{compare.map(s => <td key={s.supplier_inn}><Contacts supplier={s} expanded /></td>)}</tr>
        <tr><th>Цена / ориентир</th>{compare.map(s => <td key={s.supplier_inn}><Price supplier={s} /></td>)}</tr>
        <tr><th>Опыт в ЭМ</th>{compare.map(s => <td key={s.supplier_inn}>{s.history.participations} участий · {s.history.wins} побед<br />{s.history.category_wins} побед в категории</td>)}</tr>
        <tr><th>Опыт у заказчика</th>{compare.map(s => <td key={s.supplier_inn}>{s.history.buyer_participations ? s.history.buyer_participations + ' участий · ' + s.history.buyer_wins + ' побед' : 'Не найден / заказчик не указан'}</td>)}</tr>
        <tr><th>Соответствие</th>{compare.map(s => <td key={s.supplier_inn}>{s.reasons.slice(0, 3).join(' · ')}</td>)}</tr>
        <tr><th>Источник</th>{compare.map(s => <td key={s.supplier_inn}>{s.source}</td>)}</tr>
        <tr><th>Короткий список</th>{compare.map(s => <td key={s.supplier_inn}><button className="button secondary" onClick={() => toggleSave(s)}>{saved.some(row => row.supplier.supplier_inn === s.supplier_inn) ? 'Убрать из выбранных' : 'Добавить в выбранные'}</button></td>)}</tr>
      </tbody></table></div>
    </dialog>
    {notice && <div className="toast" role="status">{notice}</div>}
  </main>
}
