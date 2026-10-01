import model from '../generated/model.json'

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
export function bucket(term: string): number {
  let value = 2166136261
  for (const char of term) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0
  return value % 512
}
