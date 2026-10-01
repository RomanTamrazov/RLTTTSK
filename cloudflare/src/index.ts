import { bucket, overlap, predict, priceCap, schemaVersion, tokens, treeCount } from './model'
import { parseQuery } from './query'

type Env = { DB: D1Database; ALLOWED_ORIGINS: string }
type RecordValue = Record<string, string | number>
type Catalog = RecordValue & { observed_lots: number; ais_records: number; em_records: number; examples: { text: string; tokens: string[] }[] }
type External = RecordValue & { supplier_name: string; profile_text: string; source: string; source_url: string; okpd2_codes: string; portal_status: string; portal_offer_count: string; offer_region_match: string; portal_category_match: string }
type Profile = { global: RecordValue; categories: Record<string, RecordValue>; catalog: Record<string, Catalog>; external?: External }
type BuyerProfile = Record<string, [number, number, Record<string, number>]>
type Match = { inn: string; division: string; relevance: number; example: string; catalog?: Catalog; profile: Profile }

class InputError extends Error { constructor(message: string) { super(message) } }
const digits = /^\d{10}(?:\d{2})?$/
const number = (value: unknown, fallback = 0) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback }
const originHeaders = (request: Request, env: Env): Record<string, string> => {
  const origin = request.headers.get('Origin') || ''
  const allowed = env.ALLOWED_ORIGINS.split(',')
  return origin && allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}
}
function json(request: Request, env: Env, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...originHeaders(request, env) } })
}

// A profile or index is split into small D1 rows. A range query reconstructs it.
async function load<T>(db: D1Database, keys: string[]): Promise<Map<string, T>> {
  const unique = [...new Set(keys)]
  const result = new Map<string, T>()
  for (let start = 0; start < unique.length; start += 25) {
    const group = unique.slice(start, start + 25)
    const clause = group.map(() => '(key >= ? AND key < ?)').join(' OR ')
    const bounds = group.flatMap(key => [key + ':', key + ';'])
    const rows = await db.prepare(`SELECT key, value FROM store WHERE ${clause} ORDER BY key`).bind(...bounds).all<{ key: string; value: string }>()
    const chunks = new Map<string, string[]>()
    for (const row of rows.results) {
      const key = row.key.slice(0, row.key.lastIndexOf(':'))
      if (!chunks.has(key)) chunks.set(key, [])
      chunks.get(key)!.push(row.value)
    }
    for (const [key, parts] of chunks) result.set(key, JSON.parse(parts.join('')) as T)
  }
  return result
}
function age(value: unknown): number {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? Math.min(3650, Math.max(0, Math.floor((Date.now() - timestamp) / 86400000))) : 3650
}
function divisions(profile: Profile): string[] {
  const codes = profile.external?.okpd2_codes
  if (!codes) return []
  try { return (JSON.parse(codes) as string[]).map(code => String(code).split('.')[0]) } catch { return [] }
}
function bestExample(queryTerms: Set<string>, catalog: Catalog, requiredWords: number): { relevance: number; text: string } {
  if (!queryTerms.size) return { relevance: 0, text: catalog.examples?.[0]?.text || '' }
  let best = { relevance: 0, text: '' }
  for (const example of catalog.examples || []) {
    let common = 0
    for (const term of queryTerms) if (example.tokens.includes(term)) common++
    if (common < requiredWords) continue
    const relevance = common / Math.sqrt(queryTerms.size * Math.max(example.tokens.length, 1))
    if (relevance > best.relevance) best = { relevance, text: example.text }
  }
  return best
}
function featureValues(match: Match, division: string, purchaseText: string, buyer: BuyerProfile | undefined, customer: string, price: number) {
  const global = match.profile.global || {}, category = match.profile.categories[division] || {}
  const relation = customer ? buyer?.[customer] : undefined
  const participation = number(global.total_participations), categoryParticipation = number(category.category_participations)
  const buyerParticipation = relation?.[0] || 0, buyerWins = relation?.[1] || 0, buyerCategoryWins = relation?.[2]?.[division] || 0
  const categoryMatch = Number(Boolean(category.category_participations) || divisions(match.profile).includes(division) || Boolean(match.catalog))
  const profileText = match.profile.external?.profile_text || String(global.last_win_text || '')
  const textSimilarity = Math.max(overlap(tokens(purchaseText), tokens(String(global.last_win_text || profileText))), overlap(tokens(purchaseText), tokens(String(category.last_win_text || profileText))))
  return {
    values: [participation, number(global.total_wins), number(global.total_win_rate, .5), age(global.last_activity),
      categoryParticipation, number(category.category_wins), number(category.category_win_rate, .5), categoryMatch,
      age(category.last_category_activity), buyerParticipation, buyerWins,
      (buyerWins + 1) / (buyerParticipation + 2), buyerCategoryWins,
      Math.log1p(Math.min(Math.max(0, price), priceCap)), textSimilarity, 1],
    history: { participations: participation, wins: number(global.total_wins), category_participations: categoryParticipation,
      category_wins: number(category.category_wins), buyer_participations: buyerParticipation, buyer_wins: buyerWins,
      buyer_category_wins: buyerCategoryWins },
    categoryMatch, textSimilarity, profileText,
  }
}
function explain(match: Match, features: ReturnType<typeof featureValues>) {
  const reasons: string[] = []
  if (features.categoryMatch) reasons.push('профиль поставщика совпадает с разделом ОКПД2')
  if (features.history.category_participations) reasons.push(`участвовал в этой категории ${features.history.category_participations} раз, побед ${features.history.category_wins}`)
  if (features.history.buyer_participations) reasons.push(`есть ${features.history.buyer_participations} прошлых участий у заказчика, побед ${features.history.buyer_wins}`)
  if (features.history.buyer_category_wins) reasons.push(`побед у этого заказчика в данной категории: ${features.history.buyer_category_wins}`)
  if (features.textSimilarity >= .15) reasons.push('описание опыта или профиля похоже на предмет закупки')
  if (!features.history.participations) reasons.push(match.catalog?.observed_lots ? 'есть записи закупок, но нет истории конкурентных результатов ЭМ' : 'нет истории в этих данных; оценка основана на профиле кандидата')
  else if (features.history.participations < 10) reasons.push('исторический процент побед пока подтверждён небольшим числом участий')
  if (match.profile.external?.portal_status) reasons.push(`статус в портале: ${match.profile.external.portal_status}`)
  if (match.profile.external?.portal_offer_count) reasons.push(`в профиле портала опубликовано предложений: ${match.profile.external.portal_offer_count}`)
  if (match.profile.external?.offer_region_match === 'True') reasons.push('портал подтверждает регион поставки для этой закупки')
  if (match.profile.external?.portal_category_match === 'True') reasons.push('в каталоге портала найдено совпадение товарной категории')
  if (match.catalog?.observed_lots) reasons.push(`в архиве найдено закупок в этой категории: ${match.catalog.observed_lots}`)
  return reasons
}

async function search(request: Request, env: Env): Promise<Response> {
  if (number(request.headers.get('Content-Length')) > 4096) throw new InputError('Запрос слишком длинный.')
  let input: Record<string, unknown>
  try { input = await request.json() as Record<string, unknown> } catch { throw new InputError('Передайте JSON с полем query.') }
  const query = String(input.query || '').trim()
  if (query.length < 2 || query.length > 500) throw new InputError('Длина запроса должна быть от 2 до 500 символов.')
  let parsed: ReturnType<typeof parseQuery>
  try { parsed = parseQuery(query) } catch (error) { throw new InputError((error as Error).message) }
  const explicitCode = String(input.okpd2_code || parsed.okpd2_code || '')
  const customer = String(input.customer_inn || parsed.customer_inn || '')
  if (input.okpd2_code && parsed.okpd2_code && input.okpd2_code !== parsed.okpd2_code) throw new InputError('Коды ОКПД2 в строке и отдельном поле различаются.')
  if (input.customer_inn && parsed.customer_inn && input.customer_inn !== parsed.customer_inn) throw new InputError('ИНН заказчика в строке и отдельном поле различаются.')
  if (customer && !digits.test(customer)) throw new InputError('ИНН заказчика должен содержать 10 или 12 цифр.')
  if (explicitCode && !/^\d{2}(?:\.\d{1,3}){0,4}$/.test(explicitCode)) throw new InputError('Укажите корректный код ОКПД2.')
  const explicitDivision = explicitCode.slice(0, 2)
  const requestedInn = parsed.supplier_inn
  const queryTerms = tokens(parsed.purchase_text)
  if (!queryTerms.size && !explicitDivision && !requestedInn) throw new InputError('Укажите предмет закупки, код ОКПД2 или ИНН поставщика.')
  const mode = requestedInn ? 'supplier_lookup' : queryTerms.size ? 'recommendations' : 'category_browse'
  const topK = Math.max(1, Math.min(30, Math.floor(number(input.top_k, 10))))
  const parsedQuery = { purchase_text: parsed.purchase_text, okpd2_code: explicitCode || null, customer_inn: customer || null, supplier_inn: requestedInn || null }
  const empty = (division: string | null) => json(request, env, { query, category_division: division, category_inferred: !explicitDivision,
    mode, parsed_query: parsedQuery, candidate_count: 0, rank_score_is_probability: false, recommendations: [] })

  const terms = requestedInn ? [] : [...queryTerms].slice(0, 8)
  if (explicitDivision) terms.push('@' + explicitDivision)
  const index = await load<Record<string, string[]>>(env.DB, [...new Set(terms.map(term => 't:' + bucket(term)))])
  const counts = new Map<string, number>()
  for (const term of terms) {
    for (const inn of (index.get('t:' + bucket(term))?.[term] || []).slice(0, 300)) counts.set(inn, (counts.get(inn) || 0) + 1)
  }
  const minTerms = Math.min(2, queryTerms.size) + Number(Boolean(explicitDivision))
  let inns = requestedInn ? [requestedInn] : [...counts].filter(([, count]) => count >= minTerms).sort((a, b) => b[1] - a[1]).slice(0, 150).map(([inn]) => inn)
  const searchFallback = !requestedInn && !inns.length && queryTerms.size > 1
  if (searchFallback) inns = [...counts].filter(([, count]) => count >= 1 + Number(Boolean(explicitDivision)))
    .sort((a, b) => b[1] - a[1]).slice(0, 150).map(([inn]) => inn)
  if (!inns.length) return empty(explicitDivision || null)
  const profiles = await load<Profile>(env.DB, inns.map(inn => 's:' + inn))
  const matches: Match[] = []
  for (const inn of inns) {
    const profile = profiles.get('s:' + inn)
    if (!profile || !digits.test(inn) || inn.startsWith('0000')) continue
    let found = false
    for (const [division, catalog] of Object.entries(profile.catalog || {})) {
      if (explicitDivision && division !== explicitDivision) continue
      const best = bestExample(queryTerms, catalog, searchFallback ? 1 : Math.min(2, queryTerms.size))
      if (!best.text && !requestedInn && queryTerms.size) continue
      matches.push({ inn, division, relevance: best.relevance, example: best.text, catalog, profile })
      found = true
    }
    if (profile.external) {
      for (const division of divisions(profile)) {
        if (explicitDivision && division !== explicitDivision) continue
        const relevant = queryTerms.size ? overlap(queryTerms, tokens(profile.external.profile_text)) : 0
        if (!requestedInn && queryTerms.size && [...queryTerms].filter(term => tokens(profile.external!.profile_text).has(term)).length < (searchFallback ? 1 : Math.min(2, queryTerms.size))) continue
        matches.push({ inn, division, relevance: relevant, example: profile.external.profile_text, profile })
        found = true
      }
    }
    if (requestedInn && !found) matches.push({ inn, division: explicitDivision || Object.keys(profile.categories || {})[0] || 'unknown', relevance: 0,
      example: String(profile.global?.last_win_text || ''), profile })
  }
  matches.sort((a, b) => b.relevance - a.relevance || number(b.catalog?.observed_lots) - number(a.catalog?.observed_lots))
  if (!matches.length) return empty(explicitDivision || null)
  const leaders = matches.slice(0, 80)
  const totals = new Map<string, number[]>()
  for (const match of leaders) totals.set(match.division, [...(totals.get(match.division) || []), match.relevance])
  const division = explicitDivision || (requestedInn ? matches[0].division : [...totals].sort((a, b) =>
    b[1].sort((x, y) => y - x).slice(0, 3).reduce((x, y) => x + y, 0) - a[1].sort((x, y) => y - x).slice(0, 3).reduce((x, y) => x + y, 0))[0]?.[0] || '')
  const chosen = new Map<string, Match>()
  for (const match of matches) if (match.division === division && !chosen.has(match.inn)) chosen.set(match.inn, match)
  if (!chosen.size) return empty(division || null)
  inns = [...chosen.keys()].slice(0, 100)
  const buyerProfiles = customer ? await load<BuyerProfile>(env.DB, inns.map(inn => 'b:' + inn)) : new Map<string, BuyerProfile>()
  const price = number(input.start_price)
  const ranked = inns.map(inn => {
    const match = chosen.get(inn)!
    const features = featureValues(match, division || 'unknown', parsed.purchase_text, buyerProfiles.get('b:' + inn), customer, price)
    const score = predict(features.values, division || 'unknown')
    const external = match.profile.external
    const channels = [number(match.catalog?.em_records) ? 'ЭМ' : '', number(match.catalog?.ais_records) ? 'АИС ГЗ' : ''].filter(Boolean)
    return { match, features, score, source: external?.source || (channels.length ? `История закупок: ${channels.join(', ')}` : 'История закупок: ЭМ') }
  }).sort((a, b) => b.score - a.score)
  const recommendations = ranked.slice(0, requestedInn ? 1 : topK).map((row, index) => ({
    rank: index + 1, supplier_inn: row.match.inn, supplier_name: row.match.profile.external?.supplier_name || '',
    profile_excerpt: (row.match.example || row.features.profileText).slice(0, 280), category_division: division || 'unknown',
    rank_score: requestedInn ? null : row.score, source: row.source, source_url: row.match.profile.external?.source_url || '',
    reasons: [...(requestedInn ? ['точное совпадение ИНН поставщика'] : []), ...explain(row.match, row.features)], history: row.features.history,
  }))
  return json(request, env, { query, category_division: division || null, category_inferred: !explicitDivision, search_fallback: searchFallback, mode, parsed_query: parsedQuery,
    candidate_count: ranked.length, rank_score_is_probability: false, recommendations })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...originHeaders(request, env),
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } })
    const path = new URL(request.url).pathname.replace(/^\/api/, '')
    if (request.method === 'GET' && path === '/health') return json(request, env, { status: 'ok', feature_schema_version: schemaVersion, trees: treeCount })
    if (request.method !== 'POST' || path !== '/search') return json(request, env, { detail: 'Маршрут не найден.' }, 404)
    try { return await search(request, env) }
    catch (error) {
      if (error instanceof InputError) return json(request, env, { detail: error.message }, 422)
      console.error('Search error', error)
      return json(request, env, { detail: 'Ошибка сервиса рекомендаций.' }, 500)
    }
  },
} satisfies ExportedHandler<Env>
