export function parseQuery(query: string) {
  const buyers: string[] = [], suppliers: string[] = [], codes: string[] = []
  const takeOne = (values: string[], name: string) => {
    if (new Set(values).size > 1) throw new Error(`В одной строке найдено несколько разных ${name}; уточните запрос.`)
    return values[0] || ''
  }
  let rest = query.replace(/(?<![\p{L}\p{N}_])(инн\s+заказчика|заказчик(?:а)?(?:\s+инн)?|инн\s+поставщика|поставщик(?:а)?(?:\s+инн)?|инн)\s*[:№]?\s*((?:\d{12}|\d{10}))(?!\d)/giu,
    (_, role: string, inn: string) => { (role.toLowerCase().includes('заказчик') ? buyers : suppliers).push(inn); return ' ' })
  rest = rest.replace(/(?<!\d)(?:\d{12}|\d{10})(?!\d)/g, inn => { suppliers.push(inn); return ' ' })
  const takeCode = (_: string, code: string) => { codes.push(code); return ' ' }
  rest = rest.replace(/(?<![\p{L}\p{N}_])окпд\s*[- ]?\s*2\s*[:№]?\s*(\d{2}(?:\.\d{1,3}){0,4})(?![\d.])/giu, takeCode)
    .replace(/(?<![\p{L}\p{N}_.])(\d{2}(?:\.\d{1,3}){1,4})(?![\p{L}\p{N}_.])/gu, takeCode)
  if (/^\s*\d{2}\s*$/.test(rest)) { codes.push(rest.trim()); rest = '' }
  rest = rest.replace(/(?<![\p{L}\p{N}_])(?:инн|окпд\s*[- ]?\s*2|заказчик(?:а)?|поставщик(?:а)?)(?![\p{L}\p{N}_])/giu, ' ')
  return {
    purchase_text: rest.replace(/[,;:№]+/g, ' ').trim().replace(/\s+/g, ' '),
    okpd2_code: takeOne(codes, 'кодов ОКПД2'), customer_inn: takeOne(buyers, 'ИНН заказчика'),
    supplier_inn: takeOne(suppliers, 'ИНН поставщика'),
  }
}
