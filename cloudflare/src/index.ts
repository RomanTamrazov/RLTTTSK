import { bucket, lexicalRelevance, overlap, predict, priceCap, schemaVersion, searchTerms, tokens, treeCount } from './model'
import { parseQuery } from './query'

type Env = { DB: D1Database; ALLOWED_ORIGINS: string }
type RecordValue = Record<string, string | number>
type Catalog = RecordValue & { observed_lots: number; ais_records: number; em_records: number; okpd2_codes: string[]; examples: { text: string; tokens: string[] }[] }
type External = RecordValue & { supplier_name: string; profile_text: string; source: string; source_url: string; okpd2_codes: string; portal_status: string; portal_offer_count: string; offer_region_match: string; portal_category_match: string; offers_json?: string }
type Enrichment = { supplier_name?: string; region?: string; city?: string; primary_okved?: string; msp_category?: string;
  staff_count?: string; snapshot_date?: string; source_url?: string; phone?: string; email?: string; website?: string;
  contact_url?: string; contact_source?: string; contact_checked_date?: string; last_activity?: string;
  observed_lots?: string; ais_records?: string; em_records?: string; activity_period?: string;
  activity_source?: string; portal_lookup_url?: string; fns_registry_url?: string }
type Offer = { title: string; price: string; price_unit: string; price_note: string; availability: string; offer_url: string; offer_checked_date: string }
type Profile = { global: RecordValue; categories: Record<string, RecordValue>; catalog: Record<string, Catalog>; external?: External }
type BuyerProfile = Record<string, [number, number, Record<string, number>]>
type Match = { inn: string; division: string; relevance: number; example: string; catalog?: Catalog; profile: Profile; codeMatch?: boolean; offer?: Offer }

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
function animalProduct(text: string): boolean { return /ветеринар|вет\.|лошад|животн|собак|кошк|крупнорогат|свинь|коз[аы]/iu.test(text) }
function packageMismatch(size: number | null, unit: string | null, text: string): boolean {
  if (!size || !unit) return false
  const group = (value: string) => /^(мл|ml)$/.test(value) ? 'volume-small' : /^(л|литр)/.test(value) ? 'volume-large'
    : /^(г|гр)$/.test(value) ? 'weight-small' : /^(кг|килограмм)/.test(value) ? 'weight-large' : value
  const expectedUnit = group(unit)
  const measures = [...text.matchAll(/(\d+(?:[,.]\d+)?)\s*(мл|ml|л|литр(?:а|ов)?|г|гр|кг|килограмм(?:а|ов)?)(?![\p{L}])/giu)]
  const comparable = measures.filter(match => group(match[2].toLowerCase()) === expectedUnit)
  return comparable.length > 0 && !comparable.some(match => Math.abs(Number(match[1].replace(',', '.')) - size) < 0.0001)
}
function divisions(profile: Profile): string[] {
  const codes = profile.external?.okpd2_codes
  if (!codes) return []
  try { return (JSON.parse(codes) as string[]).map(code => String(code).split('.')[0]) } catch { return [] }
}
function offers(external: External): Offer[] {
  const primary = external.offer_title && external.offer_checked_date ? [{ title: String(external.offer_title), price: String(external.offer_price || ''),
    price_unit: String(external.offer_price_unit || ''), price_note: String(external.offer_price_note || ''),
    availability: String(external.offer_availability || ''), offer_url: String(external.offer_url || external.source_url),
    offer_checked_date: String(external.offer_checked_date) }] : []
  try { return primary.concat(JSON.parse(external.offers_json || '[]') as Offer[]) } catch { return primary }
}
function bestExample(queryTerms: Set<string>, catalog: Catalog, requiredWords: number, weights: Map<string, number>, mustMatch: string[]): { relevance: number; text: string } {
  if (!queryTerms.size) return { relevance: 0, text: catalog.examples?.[0]?.text || '' }
  let best = { relevance: 0, text: '' }
  for (const example of catalog.examples || []) {
    const exampleTerms = new Set(example.tokens)
    const common = [...queryTerms].filter(term => exampleTerms.has(term)).length
    if (common < requiredWords || mustMatch.some(term => !exampleTerms.has(term))) continue
    const relevance = lexicalRelevance(queryTerms, exampleTerms, weights)
    if (relevance > best.relevance) best = { relevance, text: example.text }
  }
  return best
}
function nearbyTerms(text: string, terms: Set<string>): boolean {
  const words = (text.toLowerCase().match(/[0-9a-zа-яё]{3,}/g) || []).flatMap(word => [...tokens(word)])
  for (let start = 0; start < words.length; start++) {
    if (terms.has(words[start]) && [...terms].every(term => words.slice(start, start + 4).includes(term))) return true
  }
  return false
}
function featureValues(match: Match, division: string, purchaseTerms: Set<string>, buyer: BuyerProfile | undefined, customer: string, price: number) {
  const global = match.profile.global || {}, category = match.profile.categories[division] || {}
  const relation = customer ? buyer?.[customer] : undefined
  const participation = number(global.total_participations), categoryParticipation = number(category.category_participations)
  const buyerParticipation = relation?.[0] || 0, buyerWins = relation?.[1] || 0, buyerCategoryWins = relation?.[2]?.[division] || 0
  const categoryMatch = Number(Boolean(category.category_participations) || divisions(match.profile).includes(division) || Boolean(match.catalog))
  const profileText = match.profile.external?.profile_text || String(global.last_win_text || '')
  const textSimilarity = Math.max(overlap(purchaseTerms, tokens(String(global.last_win_text || profileText))), overlap(purchaseTerms, tokens(String(category.last_win_text || profileText))))
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
  if (match.codeMatch) reasons.push('есть поставки с таким же точным кодом ОКПД2 в архиве закупок')
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
  const animalQuery = animalProduct(parsed.purchase_text)
  const queryTerms = searchTerms(parsed.purchase_text)
  if (!queryTerms.size && !explicitDivision && !requestedInn) throw new InputError('Укажите предмет закупки, код ОКПД2 или ИНН поставщика.')
  const mode = requestedInn ? 'supplier_lookup' : queryTerms.size ? 'recommendations' : 'category_browse'
  const topK = Math.max(1, Math.min(30, Math.floor(number(input.top_k, 10))))
  const parsedQuery = { purchase_text: parsed.purchase_text, okpd2_code: explicitCode || null, customer_inn: customer || null, supplier_inn: requestedInn || null,
    requested_quantity: parsed.requested_quantity, quantity_unit: parsed.quantity_unit,
    package_size: parsed.package_size, package_unit: parsed.package_unit }
  const empty = (division: string | null) => json(request, env, { query, category_division: division, category_inferred: !explicitDivision,
    mode, parsed_query: parsedQuery, candidate_count: 0, rank_score_is_probability: false, recommendations: [] })

  const codeTerms: string[] = []
  if (explicitCode) {
    const parts = explicitCode.split('.')
    for (let end = parts.length; end >= 1; end--) codeTerms.push('@' + parts.slice(0, end).join('.'))
  }
  const terms = requestedInn ? [] : [...queryTerms].slice(0, 8).concat(codeTerms)
  const index = await load<Record<string, string[]>>(env.DB, [...new Set(terms.map(term => 't:' + bucket(term)))])
  // Use the most specific code level available; broaden only if its leaf is absent.
  const matchedCodeTerm = codeTerms.find(term => (index.get('t:' + bucket(term))?.[term]?.length || 0) > 0) || ''
  const codeInns = matchedCodeTerm ? (index.get('t:' + bucket(matchedCodeTerm))?.[matchedCodeTerm] || []).slice(0, 200) : []
  const weights = new Map<string, number>()
  for (const term of queryTerms) {
    const postingCount = index.get('t:' + bucket(term))?.[term]?.length || 1
    weights.set(term, 1 + Math.log(50000 / postingCount))
  }
  // Require the two rarest query terms. This keeps category mates such as an
  // HPV vaccine out of a flu-vaccine search while retaining broad wording.
  const mustMatch = [...queryTerms].sort((a, b) => (weights.get(b) || 0) - (weights.get(a) || 0))
    .slice(0, Math.min(2, queryTerms.size))
  const counts = new Map<string, number>()
  for (const term of queryTerms) {
    for (const inn of (index.get('t:' + bucket(term))?.[term] || []).slice(0, 300)) counts.set(inn, (counts.get(inn) || 0) + 1)
  }
  // With an explicit code, one distinctive product word plus the code is
  // stronger than requiring two words from a terse product label.
  const minTerms = explicitCode ? Math.min(1, queryTerms.size) : Math.min(2, queryTerms.size)
  const textInns = [...counts].filter(([, count]) => count >= minTerms).sort((a, b) => b[1] - a[1]).slice(0, 150).map(([inn]) => inn)
  let inns = requestedInn ? [requestedInn] : codeInns.length
    // Prefer product-text hits before broad parent-code postings. Otherwise a
    // busy OKPD2 parent can fill the cap and hide a matching external profile.
    ? [...new Set([...textInns, ...codeInns])].slice(0, 300)
    : textInns
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
      const codeMatch = Boolean(explicitCode && catalog.okpd2_codes?.includes(explicitCode))
      if (matchedCodeTerm && codeInns.includes(inn) && !codeMatch) continue
      const requiredWords = codeMatch ? Math.min(1, queryTerms.size) : searchFallback ? 1 : Math.min(2, queryTerms.size)
      const best = bestExample(queryTerms, catalog, requiredWords, weights, mustMatch)
      // A matching broad code is not enough by itself for a named product:
      // keep at least one matching product/experience word to avoid bad fits.
      if (!best.text && !requestedInn && queryTerms.size) continue
      const example = best.text || (codeMatch ? catalog.examples?.[0]?.text || '' : '')
      if (!requestedInn && (animalProduct(example) && !animalQuery || packageMismatch(parsed.package_size, parsed.package_unit, example))) continue
      matches.push({ inn, division, relevance: Math.max(best.relevance, codeMatch ? 0.18 : 0), example, catalog, profile, codeMatch })
      found = true
    }
    if (profile.external) {
      if (!requestedInn && packageMismatch(parsed.package_size, parsed.package_unit, profile.external.profile_text)) continue
      for (const division of divisions(profile)) {
        if (explicitDivision && division !== explicitDivision) continue
        const externalOffers = offers(profile.external)
        const requiredExternalTerms = explicitCode || searchFallback ? 1 : Math.min(2, queryTerms.size)
        let best: { relevance: number; text: string; offer?: Offer } = { relevance: 0, text: profile.external.profile_text }
        const snippets = [profile.external.profile_text, ...profile.external.profile_text.split(/[.;]/).map(text => text.trim()).filter(Boolean)]
          .map(text => ({ text, offer: undefined as Offer | undefined }))
          .concat(externalOffers.map(offer => ({ text: offer.title, offer })))
        for (const { text: snippet, offer } of snippets) {
          if (!requestedInn && (animalProduct(snippet) && !animalQuery || packageMismatch(parsed.package_size, parsed.package_unit, snippet))) continue
          const snippetTerms = tokens(snippet)
          if (queryTerms.size && ([...queryTerms].filter(term => snippetTerms.has(term)).length < requiredExternalTerms
            || mustMatch.some(term => !snippetTerms.has(term)))) continue
          const relevance = lexicalRelevance(queryTerms, snippetTerms, weights)
          if (relevance >= best.relevance && relevance > 0) best = { relevance, text: snippet, offer }
        }
        if (!requestedInn && queryTerms.size && best.relevance === 0) continue
        matches.push({ inn, division, relevance: best.relevance, example: best.text, profile, offer: best.offer })
        found = true
      }
    }
    if (requestedInn && !found) matches.push({ inn, division: explicitDivision || Object.keys(profile.categories || {})[0] || 'unknown', relevance: 0,
      example: String(profile.global?.last_win_text || ''), profile })
  }
  // When several suppliers match every product word, omit broad one-word
  // fallbacks (for example ordinary vehicle repair for tow-truck repair).
  if (!explicitCode && queryTerms.size > 1) {
    const precise = matches.filter(match => nearbyTerms(match.example, queryTerms))
    if (new Set(precise.map(match => match.inn)).size >= 3) matches.splice(0, matches.length, ...precise)
  }
  matches.sort((a, b) => b.relevance - a.relevance || number(b.catalog?.observed_lots) - number(a.catalog?.observed_lots))
  if (!matches.length) return empty(explicitDivision || null)
  const chosen = new Map<string, Match>()
  // Without an explicit OKPD2 code, preserve relevant suppliers from adjacent
  // sections: oxygen concentrators and medical equipment use several divisions.
  for (const match of matches) if ((!explicitDivision || match.division === explicitDivision) && !chosen.has(match.inn)) chosen.set(match.inn, match)
  if (!chosen.size) return empty(explicitDivision || null)
  inns = [...chosen.keys()].slice(0, 100)
  const buyerProfiles = customer ? await load<BuyerProfile>(env.DB, inns.map(inn => 'b:' + inn)) : new Map<string, BuyerProfile>()
  const price = number(input.start_price)
  const ranked = inns.map(inn => {
    const match = chosen.get(inn)!
    const features = featureValues(match, match.division, queryTerms, buyerProfiles.get('b:' + inn), customer, price)
    const score = predict(features.values, match.division)
    const external = match.profile.external
    const matchedOffer = match.offer || (external && offers(external)
      .filter(offer => !packageMismatch(parsed.package_size, parsed.package_unit, offer.title)
        && (!queryTerms.size || mustMatch.every(term => tokens(offer.title).has(term))))
      .sort((a, b) => lexicalRelevance(queryTerms, tokens(b.title), weights) - lexicalRelevance(queryTerms, tokens(a.title), weights))[0])
    const channels = [number(match.catalog?.em_records) ? 'ЭМ' : '', number(match.catalog?.ais_records) ? 'АИС ГЗ' : ''].filter(Boolean)
    return { match, features, score, matchedOffer, source: external?.source || (channels.length ? `История закупок: ${channels.join(', ')}` : 'История закупок: ЭМ') }
  }).sort((a, b) => b.match.relevance - a.match.relevance || b.score - a.score)
  // Keep one recently verified, contactable supplier visible when its product
  // match is comparable to the leaders. The learned winner rank stays first.
  if (!requestedInn && ranked.length > 5) {
    const matchFloor = Math.max(0.28, ranked[0].match.relevance * 0.35)
    const contactIndex = ranked.findIndex((row, index) => index >= 5 && row.match.relevance >= matchFloor
      && Boolean(row.match.profile.external?.contact_phone || row.match.profile.external?.contact_email))
    if (contactIndex >= 0 && !ranked.slice(0, 5).some(row => row.match.profile.external?.contact_phone || row.match.profile.external?.contact_email)) {
      const [contactable] = ranked.splice(contactIndex, 1)
      ranked.splice(4, 0, contactable)
    }
  }
  const visible = ranked.slice(0, requestedInn ? 1 : topK)
  const visibleDivisions = new Set(visible.map(row => row.match.division))
  const displayDivision = explicitDivision || (visibleDivisions.size === 1 ? [...visibleDivisions][0] : null)
  const enriched = await load<Enrichment>(env.DB, visible.map(row => 'e:' + row.match.inn))
  const recommendations = visible.map((row, index) => ({
    rank: index + 1, supplier_inn: row.match.inn,
    supplier_name: row.match.profile.external?.supplier_name || enriched.get('e:' + row.match.inn)?.supplier_name || '',
    profile_excerpt: (row.match.example || row.features.profileText).slice(0, 280),
    profile_description: (row.match.profile.external?.profile_text || row.match.catalog?.examples?.map(example => example.text).slice(0, 4).join('; ') || row.features.profileText).slice(0, 1500),
    category_division: row.match.division,
    rank_score: requestedInn ? null : row.score, source: row.source, source_url: row.matchedOffer?.offer_url || row.match.profile.external?.source_url || '',
    reasons: [...(requestedInn ? ['точное совпадение ИНН поставщика'] : []), ...explain(row.match, row.features)], history: row.features.history,
    enrichment: enriched.get('e:' + row.match.inn) || null,
    offer: row.matchedOffer || null,
  }))
  return json(request, env, { query, category_division: displayDivision, category_inferred: !explicitDivision, search_fallback: searchFallback, mode, parsed_query: parsedQuery,
    candidate_count: ranked.length, rank_score_is_probability: false, recommendations })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...originHeaders(request, env),
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } })
    const path = new URL(request.url).pathname.replace(/^\/api/, '')
    if (request.method === 'GET' && path === '/health') return json(request, env, { status: 'ok', feature_schema_version: schemaVersion, trees: treeCount })
    if (request.method === 'GET' && path === '/egrul') {
      const inn = new URL(request.url).searchParams.get('inn') || ''
      if (!digits.test(inn)) return json(request, env, { detail: 'Укажите ИНН из 10 или 12 цифр.' }, 422)
      try {
        const started = await fetch('https://egrul.nalog.ru/', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json' },
          body: new URLSearchParams({ query: inn }), signal: AbortSignal.timeout(12000),
        })
        if (!started.ok) throw new Error(`FNS search ${started.status}`)
        const token = await started.json() as { t?: string; captchaRequired?: boolean }
        if (token.captchaRequired) return json(request, env, { detail: 'ФНС запросила проверку в браузере. Откройте официальный сайт.' }, 503)
        if (!token.t || !/^[A-F0-9]{64,256}$/.test(token.t)) throw new Error('FNS search token missing')
        const found = await fetch(`https://egrul.nalog.ru/search-result/${token.t}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) })
        if (!found.ok) throw new Error(`FNS result ${found.status}`)
        const data = await found.json() as { rows?: { i?: string; n?: string; o?: string; r?: string; k?: string }[] }
        const companies = (data.rows || []).filter(row => row.i === inn).map(row => ({ name: row.n || '', ogrn: row.o || '', registered: row.r || '', kind: row.k === 'fl' ? 'ИП' : 'организация' }))
        return json(request, env, { inn, companies, source_url: 'https://egrul.nalog.ru/index.html' })
      } catch (error) {
        console.error('FNS lookup error', error)
        return json(request, env, { detail: 'ФНС временно не ответила. Попробуйте позже или откройте официальный сайт.' }, 502)
      }
    }
    if (request.method !== 'POST' || path !== '/search') return json(request, env, { detail: 'Маршрут не найден.' }, 404)
    try { return await search(request, env) }
    catch (error) {
      if (error instanceof InputError) return json(request, env, { detail: error.message }, 422)
      console.error('Search error', error)
      return json(request, env, { detail: 'Ошибка сервиса рекомендаций.' }, 500)
    }
  },
} satisfies ExportedHandler<Env>
