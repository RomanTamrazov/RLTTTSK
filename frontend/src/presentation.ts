import type { Supplier } from './api'

export const supplierTitle = (supplier: Supplier) => supplier.supplier_name || `Поставщик ИНН ${supplier.supplier_inn}`
export const rubles = (value?: number | null) => value != null && Number.isFinite(value)
  ? new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: value % 1 ? 2 : 0 }).format(value)
  : 'Не указан'
export const dateLabel = (value?: string) => value ? value.slice(0, 10).split('-').reverse().join('.') : ''
export function parseBudget(text: string): number | undefined {
  if (!text.trim()) return undefined
  const normalized = text.replace(/[\s\u00a0₽]/g, '').replace(',', '.')
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Укажите бюджет числом, например 450 000 или 450000,50.')
  const value = Number(normalized)
  if (!Number.isFinite(value) || value <= 0 || value > 1e12) throw new Error('Бюджет должен быть больше нуля и не превышать 1 трлн ₽.')
  return value
}
export function safeUrl(value?: string): string | undefined {
  if (!value) return undefined
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined } catch { return undefined }
}
export function contactLinks(supplier: Supplier) {
  const e = supplier.enrichment
  const phone = e?.phone?.split(/[;,]/)[0]?.trim()
  const digits = phone?.replace(/[^+\d]/g, '')
  const email = e?.email?.split(/[;,\s]/)[0]
  return {
    phone: digits && /^\+?\d{7,15}$/.test(digits) ? { label: phone!, href: `tel:${digits}` } : undefined,
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { label: email, href: `mailto:${email}` } : undefined,
    website: safeUrl(e?.website), source: safeUrl(e?.contact_source),
    lookup: safeUrl(e?.contact_lookup_url) || `https://yandex.ru/search/?text=${encodeURIComponent(`контакты компании ИНН ${supplier.supplier_inn}`)}`,
  }
}
export const companyLinks = (inn: string) => ({
  fns: `https://egrul.nalog.ru/index.html?query=${encodeURIComponent(inn)}`,
  portal: `https://zakupki.mos.ru/organization/list?page=1&perPage=10&filter=${encodeURIComponent(JSON.stringify({ isSupplier: true, inn: { value: inn } }))}`,
})
export const customerLinks = (inn: string) => ({
  fns: `https://egrul.nalog.ru/index.html?query=${encodeURIComponent(inn)}`,
  eis: `https://zakupki.gov.ru/epz/order/extendedsearch/results.html?searchString=${encodeURIComponent(inn)}`,
})
