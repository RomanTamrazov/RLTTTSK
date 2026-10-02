import model from '../generated/model.json' with { type: 'json' }

const borders = model.float_feature_borders.map((values, i) => [model.float_features_index[i], values] as const)
export function predict(features: number[], division: string): number {
  const bins = borders.filter(([, values]) => values.length).map(([index, values]) => {
    const value = Math.fround(features[index])
    let bin = 0
    for (const border of values) if (value > border) bin++
    return bin
  })
  const categories: Record<string, number[]> = model.category_bins
  bins.push(...(categories[division] ?? categories.unknown))
  let score = 0, split = 0, leaf = 0
  for (const depth of model.tree_depth) {
    let index = 0
    for (let bit = 0; bit < depth; bit++, split++) {
      index |= Number((bins[model.tree_split_feature_index[split]] ^ model.tree_split_xor_mask[split]) >= model.tree_split_border[split]) << bit
    }
    score += model.leaf_values[leaf + index]
    leaf += 1 << depth
  }
  return model.scale * score + model.biases[0]
}
export const schemaVersion = model.schema_version
export const treeCount = model.tree_depth.length
export const priceCap = model.price_cap
const generic = new Set(model.generic_stems)
const searchLexicon = model as typeof model & { search_vocabulary?: string[]; search_term_frequency?: Record<string, number> }
const searchVocabulary = searchLexicon.search_vocabulary ?? []
const vocabulary = new Set(searchVocabulary)
const vocabularyByLength = new Map<number, string[]>()
const vocabularyByGram = new Map<string, Set<string>>()
for (const term of searchVocabulary) {
  const words = vocabularyByLength.get(term.length) ?? []
  words.push(term)
  vocabularyByLength.set(term.length, words)
  const gramSize = term.length >= 5 ? 3 : 2
  for (let index = 0; index <= term.length - gramSize; index += 1) {
    const gram = term.slice(index, index + gramSize)
    const matches = vocabularyByGram.get(gram) ?? new Set<string>()
    matches.add(term)
    vocabularyByGram.set(gram, matches)
  }
}

function editDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]
    let minimum = row
    for (let column = 1; column <= right.length; column += 1) {
      const leftChar = left[row - 1], rightChar = right[column - 1]
      const vowelSwap = 'аеёиоуыэюя'.includes(leftChar) && 'аеёиоуыэюя'.includes(rightChar)
      const substitution = leftChar === rightChar ? 0 : vowelSwap ? 0.65 : 1
      const value = Math.min(current[column - 1] + 1, previous[column] + 1,
        previous[column - 1] + substitution)
      current.push(value)
      minimum = Math.min(minimum, value)
    }
    if (minimum > limit) return limit + 1
    previous = current
  }
  return previous[right.length]
}

function transliterate(word: string): string {
  const input = word.startsWith('i') ? 'ai' + word.slice(1) : word
  return input.replace(/shch|yo|zh|kh|ts|ch|sh|yu|ya|ph/g, value => ({
    shch: 'щ', yo: 'ё', zh: 'ж', kh: 'х', ts: 'ц', ch: 'ч', sh: 'ш', yu: 'ю', ya: 'я', ph: 'ф',
  })[value]!).replace(/[a-z]/g, char => ({ a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х',
    i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т',
    u: 'у', v: 'в', w: 'в', x: 'кс', y: 'ы', z: 'з' })[char]!)
}

function nearestTerm(word: string, limit: number): string | undefined {
  if (word.length < 4 || word.length > 20) return undefined
  let bestDistance = limit + 1
  let best: string[] = []
  const gramSize = word.length >= 5 ? 3 : 2
  const candidates = new Set<string>()
  for (let index = 0; index <= word.length - gramSize; index += 1) {
    for (const candidate of vocabularyByGram.get(word.slice(index, index + gramSize)) ?? []) candidates.add(candidate)
  }
  if (!candidates.size) {
    for (let length = Math.max(4, word.length - limit); length <= word.length + limit; length += 1) {
      for (const candidate of vocabularyByLength.get(length) ?? []) candidates.add(candidate)
    }
  }
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - word.length) <= limit) {
      const distance = editDistance(word, candidate, Math.min(limit, bestDistance))
      if (distance < bestDistance) { bestDistance = distance; best = [candidate] }
      else if (distance === bestDistance) best.push(candidate)
    }
  }
  if (bestDistance > limit) return undefined
  if (best.length === 1) return best[0]
  const ranked = best.map(term => [term, searchLexicon.search_term_frequency?.[term] || 0] as const)
    .sort((a, b) => b[1] - a[1])
  return ranked[0][1] >= Math.max(3, ranked[1][1] * 2) ? ranked[0][0] : undefined
}

const concepts: Record<string, string> = { iphone: 'смартфон', iphon: 'смартфон', айфон: 'смартфон', phone: 'телефон' }
export function searchTerms(text: string): Set<string> {
  const result = new Set<string>()
  for (const term of tokens(text)) {
    if (concepts[term] && vocabulary.has(concepts[term])) { result.add(concepts[term]); continue }
    if (term.endsWith('ь') && vocabulary.has(term.slice(0, -1))) { result.add(term.slice(0, -1)); continue }
    if (vocabulary.has(term)) { result.add(term); continue }
    const latin = /[a-z]/.test(term)
    const phonetic = latin ? [...tokens(transliterate(term))] : []
    let corrected = phonetic.find(word => vocabulary.has(word))
    if (!corrected && latin) {
      for (const word of phonetic) {
        corrected = nearestTerm(word, 2)
        if (corrected) break
      }
    }
    if (!corrected) corrected = nearestTerm(term, term.length >= 8 ? 2 : 1)
    result.add(corrected || term)
  }
  return result
}

export function tokens(text: string): Set<string> {
  const result = new Set<string>()
  for (let word of text.toLowerCase().replaceAll('ё', 'е').match(/[0-9a-zа-я]{3,}/g) ?? []) {
    const ending = model.endings.find(ending => word.endsWith(ending) && word.length - ending.length >= 4)
    if (ending) word = word.slice(0, -ending.length)
    if (!generic.has(word)) result.add(word)
  }
  return result
}
export function overlap(a: Set<string>, b: Set<string>): number {
  let common = 0
  for (const term of a) if (b.has(term)) common++
  return a.size && b.size ? common / Math.sqrt(a.size * b.size) : 0
}
export function lexicalRelevance(query: Set<string>, candidate: Set<string>, weights: Map<string, number>): number {
  let matchedWeight = 0, totalWeight = 0
  for (const term of query) {
    const weight = weights.get(term) || 1
    totalWeight += weight
    if (candidate.has(term)) matchedWeight += weight
  }
  return matchedWeight / Math.max(totalWeight, 1) * Math.sqrt(query.size / Math.max(candidate.size, 1))
}
export function bucket(term: string): number {
  let value = 2166136261
  for (const char of term) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0
  return value % 512
}
