import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Supplier } from './api'
import { statusLabel, type PurchaseRecommendations } from './purchaseCsv'
import { dateLabel, rubles } from './presentation'
import { CustomerLinks } from './HistoryTrail'

export default function LotBrowser({ rows, running, recommendOne, renderCandidate }: {
  rows: PurchaseRecommendations[]
  running: boolean
  recommendOne(index: number): void
  renderCandidate(supplier: Supplier, row: PurchaseRecommendations): ReactNode
}) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState('all')
  const visible = useMemo(() => rows.map((row, index) => ({ row, index })).filter(({ row }) => {
    const text = filter.trim().toLowerCase()
    return (!text || (row.purchase.id + ' ' + row.purchase.query).toLowerCase().includes(text))
      && (status === 'all' || row.status === status)
  }), [rows, filter, status])
  useEffect(() => { setSelectedIndex(index => Math.min(index, Math.max(0, rows.length - 1))) }, [rows.length])
  const selected = rows[selectedIndex]
  const position = visible.findIndex(item => item.index === selectedIndex)
  function select(index: number) {
    setSelectedIndex(index)
    document.getElementById('lot-button-' + index)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  function move(delta: number) {
    const next = position < 0 ? 0 : Math.min(visible.length - 1, Math.max(0, position + delta))
    if (visible[next]) select(visible[next].index)
  }
  if (!selected) return null
  return <section className="lot-browser" aria-label="Просмотр лотов и рекомендаций">
    <aside className="lot-sidebar">
      <div className="lot-list-heading"><h3>Лоты <span>{rows.length}</span></h3><p>Выберите lot_id или листайте по порядку</p></div>
      <label className="lot-filter">Поиск по lot_id или предмету<input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Например, 5968880" /></label>
      <label className="lot-filter status-filter">Статус<select value={status} onChange={event => setStatus(event.target.value)}>
        <option value="all">Все лоты</option><option value="done">С рекомендациями</option><option value="empty">Без кандидатов</option>
        <option value="error">С ошибками</option><option value="pending">Не обработано</option><option value="cancelled">Остановлено</option></select></label>
      <div className="lot-list" role="list" aria-label="Лоты из CSV">
        {visible.map(({ row, index }) => <div role="listitem" key={index}><button id={'lot-button-' + index} className={'lot-select' + (index === selectedIndex ? ' selected' : '')}
          aria-label={'Открыть лот ' + row.purchase.id} aria-current={index === selectedIndex ? 'true' : undefined} onClick={() => select(index)}>
          <span className="lot-select-top"><strong>Лот {row.purchase.id}</strong><span className={'lot-dot ' + row.status} /></span>
          <span className="lot-select-query">{row.purchase.query || 'Описание не указано'}</span>
          <span className="lot-select-bottom"><span>{rubles(row.purchase.options.start_price)}</span><span>{row.result?.recommendations.length ? row.result.recommendations.length + ' компаний' : statusLabel[row.status]}</span></span>
        </button></div>)}
        {!visible.length && <p className="muted">Лоты по этому фильтру не найдены.</p>}
      </div>
    </aside>
    <article className="lot-detail">
      <div className="lot-navigation"><span>{position >= 0 ? 'Лот ' + (position + 1) + ' из ' + visible.length : 'Выбранный лот вне фильтра'}</span>
        <div><button className="button secondary" aria-label="Предыдущий лот" disabled={position <= 0} onClick={() => move(-1)}>← Предыдущий</button>
          <button className="button secondary" aria-label="Следующий лот" disabled={position >= visible.length - 1 || !visible.length} onClick={() => move(1)}>Следующий →</button></div></div>
      <div className="lot-detail-heading"><span className="eyebrow">LOT_ID {selected.purchase.id}</span><h2>{selected.purchase.query || 'Описание не указано'}</h2>
        {selected.purchase.provisional && <p className="provisional-note">Лот собран из ТРУ. Для точного предмета, бюджета и данных заказчика добавьте CSV извещений.</p>}
        <div className="lot-meta"><div><span>Бюджет закупки</span><strong>{rubles(selected.purchase.options.start_price)}</strong></div>
          <div><span>Дата публикации</span><strong>{dateLabel(selected.purchase.published) || 'Не указана'}</strong></div>
          <div><span>Заказчик</span><CustomerLinks inn={selected.purchase.options.customer_inn} /></div></div>
        {selected.purchase.reqnum && <p className="muted">Реестровый номер: {selected.purchase.reqnum}</p>}
        <p className="muted">Источник: {selected.purchase.sourceFile || 'CSV'} · строка {selected.purchase.rowNumber}</p>
      </div>
      {!!selected.purchase.items?.length && <details className="lot-items"><summary>Состав лота · {selected.purchase.items.length} позиций ТРУ</summary>
        {selected.purchase.multiCategory && <p className="muted">В лоте несколько разделов ОКПД2. Рекомендации требуют проверки соответствия всему составу закупки.</p>}
        <div className="lot-items-table"><table><thead><tr><th>Товар / работа / услуга</th><th>ОКПД2</th></tr></thead><tbody>
          {selected.purchase.items.map((item, i) => <tr key={i}><td>{item.product_name}</td><td>{item.okpd2_code || '—'}</td></tr>)}
        </tbody></table></div></details>}
      <div className="lot-recommendation-heading"><div><h3>Рекомендованные поставщики</h3><p>{selected.status === 'done' ? 'Откройте карточку целиком, чтобы увидеть опыт и лоты компании.' : statusLabel[selected.status]}</p></div>
        <button className="button primary" disabled={running || Boolean(selected.purchase.validationError)}
          onClick={() => recommendOne(selectedIndex)}>{selected.status === 'done' || selected.status === 'empty' ? 'Обновить подбор' : 'Подобрать для этого лота'}</button></div>
      {selected.recommendedAt && <p className="muted">Подобраны {new Date(selected.recommendedAt).toLocaleString('ru-RU')}</p>}
      {selected.error && <p className="alert error" role="alert">{selected.error}</p>}
      {selected.status === 'pending' && <div className="lot-no-results"><h3>Лот готов к подбору</h3><p>Подберите поставщиков для этого лота или запустите подбор для всего списка. При переключении лотов результаты сохраняются.</p></div>}
      {selected.status === 'running' && <div className="lot-no-results" role="status">Подбираем подходящих поставщиков…</div>}
      {selected.status === 'cancelled' && <div className="lot-no-results">Подбор остановлен. Можно продолжить с этого лота.</div>}
      {selected.status === 'empty' && <div className="lot-no-results">Подходящих компаний в текущем каталоге не найдено. Проверьте состав закупки и коды ОКПД2.</div>}
      <div className="lot-candidates">{selected.result?.recommendations.map(supplier => <div key={supplier.supplier_inn}>{renderCandidate(supplier, selected)}</div>)}</div>
    </article>
  </section>
}
