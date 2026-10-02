export interface Supplier {
  rank: number
  supplier_inn: string
  supplier_name: string
  profile_excerpt: string
  profile_description: string
  category_division: string
  rank_score: number | null
  source: string
  source_url: string
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
  } | null
  reasons: string[]
  offer: { title: string; price: string; price_unit: string; price_note: string; availability: string; offer_url: string; offer_checked_date: string } | null
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

export interface SearchResult {
  mode: 'recommendations' | 'category_browse' | 'supplier_lookup'
  candidate_count: number
  search_fallback?: boolean
  category_division: string | null
  parsed_query: { purchase_text: string; okpd2_code: string | null; customer_inn: string | null; supplier_inn: string | null;
    requested_quantity: number | null; quantity_unit: string | null; package_size: number | null; package_unit: string | null }
  recommendations: Supplier[]
}

let apiUrl: Promise<string> | undefined
const serviceUrl = () => apiUrl ??= fetch(`${import.meta.env.BASE_URL}config.json`)
  .then(r => { if (!r.ok) throw new Error('Не найден адрес сервиса рекомендаций.'); return r.json() })
  .then(config => import.meta.env.VITE_API_URL || config.apiUrl || '/api')

export async function lookupEgrul(inn: string): Promise<{ inn: string; companies: { name: string; ogrn: string; registered: string; kind: string }[]; source_url: string }> {
  const response = await fetch(`${(await serviceUrl()).replace(/\/$/, '')}/egrul?inn=${encodeURIComponent(inn)}`)
  const data = await response.json()
  if (!response.ok) throw new Error(data.detail || 'Не удалось проверить ЕГРЮЛ.')
  return data
}
export interface SearchOptions {
  okpd2_code?: string
  customer_inn?: string
  start_price?: number
  top_k?: number
}

export async function searchSuppliers(query: string, signal: AbortSignal, options: SearchOptions = {}): Promise<SearchResult> {
  const response = await fetch(`${(await serviceUrl()).replace(/\/$/, '')}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, top_k: 30, ...options }), signal,
  })
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Сервис рекомендаций недоступен. Попробуйте позже.')
  }
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Не удалось выполнить поиск.')
  return data
}
