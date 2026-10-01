export interface Supplier {
  rank: number
  supplier_inn: string
  supplier_name: string
  profile_excerpt: string
  category_division: string
  rank_score: number | null
  source: string
  source_url: string
  reasons: string[]
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
  parsed_query: { purchase_text: string; okpd2_code: string | null; customer_inn: string | null; supplier_inn: string | null }
  recommendations: Supplier[]
}

let apiUrl: Promise<string> | undefined
export async function searchSuppliers(query: string, signal: AbortSignal): Promise<SearchResult> {
  apiUrl ??= fetch(`${import.meta.env.BASE_URL}config.json`)
    .then(r => { if (!r.ok) throw new Error('Не найден адрес сервиса рекомендаций.'); return r.json() })
    .then(config => import.meta.env.VITE_API_URL || config.apiUrl || '/api')
  const response = await fetch(`${(await apiUrl).replace(/\/$/, '')}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, top_k: 5 }), signal,
  })
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Сервис рекомендаций недоступен. Попробуйте позже.')
  }
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Не удалось выполнить поиск.')
  return data
}
