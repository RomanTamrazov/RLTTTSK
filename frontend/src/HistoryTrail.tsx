import type { Supplier } from './api'
import { customerLinks, dateLabel, rubles } from './presentation'

export function CustomerLinks({ inn, compact = false }: { inn?: string; compact?: boolean }) {
  if (!inn || !/^\d{10}(?:\d{2})?$/.test(inn)) return <span className="muted">ИНН заказчика не указан</span>
  const links = customerLinks(inn)
  return <div className={'customer-links' + (compact ? ' compact' : '')}>
    <span>ИНН {inn}</span>
    <a href={links.fns} target="_blank" rel="noreferrer" aria-label={'Найти заказчика ' + inn + ' в ФНС'}>ФНС ↗</a>
    <a href={links.eis} target="_blank" rel="noreferrer" aria-label={'Искать закупки по ИНН заказчика ' + inn + ' в ЕИС'}>Поиск в ЕИС ↗</a>
  </div>
}

export default function HistoryTrail({ supplier }: { supplier: Supplier }) {
  const examples = supplier.history_examples || []
  return <details className="history-trail">
    <summary>Где встречался поставщик <span>{examples.length ? `${examples.length} последних записей` : 'нет примеров'}</span></summary>
    <div className="history-trail-body">
      {examples.length ? <>
        <p className="history-intro">Примеры из архива 2024–2025 по этому разделу ОКПД2. Показана часть записей, а не вся история компании.</p>
        <ol className="history-list">{examples.map(item => <li key={item.lot_id}>
          <div className="history-row-top"><span>{dateLabel(item.publish_date)}</span><span className="history-channel">{item.channel}</span>
            <span className="history-outcome">{item.channel === 'ЭМ' ? item.em_winner ? 'Отмечен победителем' : 'Другой участник' : 'Запись о поставщике'}</span></div>
          <strong>{item.purchase_text || 'Предмет закупки не указан'}</strong>
          <div className="history-row-meta"><span>Лот {item.lot_id}{item.reqnum && ` · № ${item.reqnum}`}</span>
            {item.start_price != null && <span>Начальный бюджет: {rubles(item.start_price)}</span>}</div>
          <CustomerLinks inn={item.customer_inn} compact />
        </li>)}</ol>
        <p className="history-footnote">В ЭМ статус взят из поля is_winner. Для АИС ГЗ исход конкурентного отбора по этим данным не подтверждён. Бюджет лота не является ценой предложения компании.</p>
      </> : <p className="muted">{supplier.history_available === false
        ? 'История поставщика пока недоступна в подключённом сервисе.'
        : 'По выбранной категории примеров лотов нет. Нулевой счётчик ЭМ не означает, что компания новая.'}</p>}
    </div>
  </details>
}
