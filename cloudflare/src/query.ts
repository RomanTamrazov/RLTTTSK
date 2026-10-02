export function parseQuery(query: string) {
  const buyers: string[] = [], suppliers: string[] = [], codes: string[] = []
  let requestedQuantity: number | null = null, quantityUnit: string | null = null
  let packageSize: number | null = null, packageUnit: string | null = null
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
  // Keep quantities as request metadata, not search keywords (e.g. 10 000 ampoules, 10 ml).
  rest = rest.replace(/(?<![\p{L}\p{N}])([\d\s.,]+)\s*(мл|ml|л|литр(?:а|ов)?|г|гр|кг|килограмм(?:а|ов)?|шт(?:ук)?|ампул(?:а|ы|е|у|ой|ами|ах)?|упак(?:овк(?:а|и|у|ой|е|ок)?|овок)?|метр(?:а|ов)?|м|рулон(?:а|ов)?)(?![\p{L}])/giu,
    (_whole: string, rawNumber: string, rawUnit: string) => {
      const compact = rawNumber.trim().replace(/\s/g, '')
      const punctuation = Math.max(compact.lastIndexOf(','), compact.lastIndexOf('.'))
      const integer = punctuation >= 0 ? compact.slice(0, punctuation) : compact
      const fraction = punctuation >= 0 ? compact.slice(punctuation + 1) : ''
      const grouped = punctuation >= 0 && fraction.length === 3 && integer.length > 0 && !/^0+$/.test(integer)
      const amount = Number(punctuation < 0 || grouped ? compact.replace(/[,.]/g, '')
        : integer.replace(/[,.]/g, '') + '.' + fraction)
      const unit = rawUnit.toLowerCase().replaceAll('ё', 'е')
      if (Number.isFinite(amount)) {
        if (/^(мл|ml|л|литр|г$|гр$|кг$|килограмм)/.test(unit)) { packageSize ??= amount; packageUnit ??= unit }
        else {
          requestedQuantity ??= amount; quantityUnit ??= unit
          if (/^(упак|шт|штук|рулон|метр|м)/.test(unit)) return ' '
          return ` ${rawUnit} `
        }
      }
      return ' '
    })
  if (/^\s*\d{2}\s*$/.test(rest)) { codes.push(rest.trim()); rest = '' }
  rest = rest.replace(/(?<![\p{L}\p{N}_])(?:инн|окпд\s*[- ]?\s*2|заказчик(?:а)?|поставщик(?:а)?)(?![\p{L}\p{N}_])/giu, ' ')
  return {
    purchase_text: rest.replace(/[,;:№]+/g, ' ').trim().replace(/\s+/g, ' '),
    okpd2_code: takeOne(codes, 'кодов ОКПД2'), customer_inn: takeOne(buyers, 'ИНН заказчика'),
    supplier_inn: takeOne(suppliers, 'ИНН поставщика'),
    requested_quantity: requestedQuantity, quantity_unit: quantityUnit,
    package_size: packageSize, package_unit: packageUnit,
  }
}
