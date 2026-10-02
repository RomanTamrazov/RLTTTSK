import { ApiError, searchSuppliers, type SearchOptions, type SearchResult } from './api'
import type { PurchaseRecommendations, PurchaseRow } from './purchaseCsv'

export type SearchFunction = (query: string, signal: AbortSignal, options: SearchOptions) => Promise<SearchResult>
export const initialRows = (purchases: PurchaseRow[]): PurchaseRecommendations[] => purchases.map(purchase => ({
  purchase, status: purchase.validationError ? 'error' : 'pending', error: purchase.validationError,
}))
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Остановлено', 'AbortError')); return }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Остановлено', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
export async function runPurchaseBatch(
  initial: PurchaseRecommendations[], signal: AbortSignal, onUpdate: (rows: PurchaseRecommendations[]) => void,
  search: SearchFunction = searchSuppliers, indices?: number[],
) {
  const rows = initial.map(row => ({ ...row }))
  const pending = indices ?? rows.map((_, i) => i).filter(i => rows[i].status === 'pending')
  for (const index of pending) rows[index] = { purchase: rows[index].purchase, status: 'pending' }
  let cursor = 0
  const publish = () => onUpdate(rows.map(row => ({ ...row })))
  publish()
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (!signal.aborted) {
      const index = pending[cursor++]
      if (index === undefined) return
      const purchase = rows[index].purchase
      if (purchase.validationError) { rows[index] = { purchase, status: 'error', error: purchase.validationError }; publish(); continue }
      rows[index] = { purchase, status: 'running' }; publish()
      try {
        let result: SearchResult | undefined
        for (let attempt = 0; attempt < 3; attempt++) {
          try { result = await search(purchase.searchQuery || purchase.query, signal, purchase.options); break }
          catch (error) {
            if (signal.aborted || !(error instanceof ApiError) || !error.retryable || attempt === 2) throw error
            await delay(Math.max(error.retryAfterMs, 750 * 2 ** attempt), signal)
          }
        }
        rows[index] = { purchase, result, status: result?.recommendations.length ? 'done' : 'empty', recommendedAt: new Date().toISOString() }
      } catch (error) {
        rows[index] = { purchase, status: signal.aborted ? 'cancelled' : 'error',
          error: signal.aborted ? undefined : error instanceof Error ? error.message : 'Не удалось получить рекомендации.' }
      }
      publish()
    }
  }))
  for (const index of pending) if (rows[index].status === 'pending' || rows[index].status === 'running') rows[index] = { purchase: rows[index].purchase, status: 'cancelled' }
  publish()
  return rows
}
