export interface Supplier {
  rank: number
  supplier_inn: string
  supplier_name: string
  profile_excerpt: string
  category_division: string
  rank_score: number | null
  has_contacts?: boolean
  offer?: { title: string; price: string; price_unit: string; price_note: string; availability: string; offer_url: string; offer_checked_date: string } | null
  source: string
  source_url: string
  pricing?: { status: 'on_request'; historical_purchase: HistoricalPurchase | null }
  enrichment: {
    region?: string
    city?: string
    primary_okved?: string
    msp_category?: string
    staff_count?: string
    snapshot_date?: string
    source_url?: string
    phone?: string
    email?: string
    website?: string
    contact_url?: string
    contact_source?: string
    contact_checked_date?: string
    last_activity?: string
    observed_lots?: string
    ais_records?: string
    em_records?: string
    activity_period?: string
    activity_source?: string
    contact_lookup_url?: string
    website_lookup_url?: string
    portal_lookup_url?: string
    fns_registry_url?: string
    supplier_role?: string
    role_source?: string
    role_checked_date?: string
  } | null
  reasons: string[]
  history_examples?: HistoryExample[]
  history: {
    participations: number
    wins: number
    category_participations: number
    category_wins: number
    buyer_participations: number
    buyer_wins: number
    buyer_category_wins: number
  }
}

export interface HistoryExample {
  lot_id: string
  reqnum: string
  purchase_text: string
  publish_date: string
  customer_inn: string
  channel: string
  em_winner: boolean | null
  start_price: number | null
}

export interface HistoricalPurchase {
  lot_id: string
  purchase_text: string
  start_price: number
  publish_date: string
  channel: string
  was_winner: boolean
}

export interface SearchResult {
  mode: 'recommendations' | 'category_browse' | 'supplier_lookup'
  candidate_count: number
  search_fallback?: boolean
  category_inferred?: boolean
  purchase_budget?: number | null
  category_division: string | null
  parsed_query: { purchase_text: string; okpd2_code: string | null; customer_inn: string | null; supplier_inn: string | null;
    requested_quantity?: number | null; quantity_unit?: string | null; package_size?: number | null; package_unit?: string | null }
  recommendations: Supplier[]
}

let apiUrl: Promise<string> | undefined
async function serviceUrl(): Promise<string> {
  apiUrl ??= (import.meta.env.VITE_API_URL ? Promise.resolve(import.meta.env.VITE_API_URL) : fetch(`${import.meta.env.BASE_URL}config.json`)
    .then(r => { if (!r.ok) throw new Error('Не найден адрес сервиса рекомендаций.'); return r.json() })
    .then(config => config.apiUrl || '/api')).catch(error => { apiUrl = undefined; throw error })
  return apiUrl
}
export async function lookupEgrul(inn: string): Promise<{ inn: string; companies: { name: string; ogrn: string; registered: string; kind: string }[]; source_url: string }> {
  const response = await fetch(`${(await serviceUrl()).replace(/\/$/, '')}/egrul?inn=${encodeURIComponent(inn)}`)
  const data = await response.json()
  if (!response.ok) throw new Error(data.detail || 'Не удалось проверить ЕГРЮЛ.')
  return data
}
export class ApiError extends Error {
  constructor(message: string, public status: number, public retryAfterMs = 1000) { super(message) }
  get retryable() { return this.status === 429 || this.status >= 500 || this.status === 0 }
}
export interface SearchOptions {
  okpd2_code?: string
  customer_inn?: string
  start_price?: number
  top_k?: number
  structured_query?: boolean
}

export async function searchSuppliers(query: string, signal: AbortSignal, options: SearchOptions = {}): Promise<SearchResult> {
  if (signal.aborted) throw new DOMException('Остановлено', 'AbortError')
  const url = await serviceUrl()
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) controller.abort()
  let timedOut = false
  const timer = window.setTimeout(() => { timedOut = true; controller.abort() }, 25000)
  try {
  const response = await fetch(`${url.replace(/\/$/, '')}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, top_k: 30, ...options }), signal: controller.signal,
  })
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError('Сервис рекомендаций недоступен. Попробуйте позже.', response.status >= 400 ? response.status : 502)
  }
  const data = await response.json()
  if (!response.ok) throw new ApiError(typeof data.detail === 'string' ? data.detail : 'Не удалось выполнить поиск.', response.status, Math.min(10000, Math.max(1000, Number(response.headers.get('Retry-After') || 1) * 1000)))
  if (!Array.isArray(data.recommendations)) throw new ApiError('Сервис вернул некорректный ответ.', 502)
  return data
  } catch (error) {
    if (signal.aborted) throw new DOMException('Остановлено', 'AbortError')
    if (timedOut) throw new ApiError('Сервис отвечает слишком долго. Повторите запрос.', 0)
    if (error instanceof TypeError) throw new ApiError('Нет связи с сервисом рекомендаций.', 0)
    throw error
  } finally { window.clearTimeout(timer); signal.removeEventListener('abort', abort) }
}
