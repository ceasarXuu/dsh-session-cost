/**
 * Official DeepSeek "Models & Pricing" page: fetch + fail-closed parser.
 *
 * This module is the only place that knows how to read the official pricing
 * pages. The host half (`index.js`) calls `fetchOfficialPrices()` at most once
 * per `autoCheck.intervalDays` and appends a dated price revision only when the
 * parsed table differs from the effective one. A parse failure is surfaced to
 * the Client as "pricing check failed — manual check may be needed", so every
 * uncertainty here must become `{ ok: false, error }` instead of a guess.
 *
 * The pages are Docusaurus server-rendered HTML with one model/pricing table:
 *
 *   <table>
 *     <tr> 模型[colspan=3]   deepseek-flash(1)  deepseek-v4-pro       (header)
 *     ...
 *     <tr> 价格 [rowspan=6]  百万tokens输入（缓存命中）[rowspan=2]
 *                            空闲时段   0.02元   0.15元
 *     <tr>                  高峰时段   0.04元   0.30元
 *     <tr>                  百万tokens输入（缓存未命中）[rowspan=2] ...
 *     <tr>                  百万tokens输出[rowspan=2] ...
 *     ...
 *   </table>
 *
 * The English page is the same table in dollars (`$0.02`-style cells,
 * `OFF-PEAK` / `PEAK` labels, `1M INPUT TOKENS (CACHE HIT)` labels). A second,
 * unrelated "Search" price table exists on both pages; it has no model columns
 * and is ignored.
 *
 * Parser strategy: expand the table into a rectangular grid honouring
 * `rowspan` / `colspan` (so a price row inherits its dimension label), find the
 * header row that names both expected model columns, then read every
 * window-labelled row below it. Values are mapped to models left-to-right and
 * validated cell by cell. Anything unexpected fails closed.
 *
 * Zero npm dependencies; Node 20+ globals only (`fetch`, `AbortController`).
 */

/** Official pricing pages, keyed by the display currency of the table. */
export const PRICING_URLS = Object.freeze({
  CNY: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  USD: 'https://api-docs.deepseek.com/quick_start/pricing/',
})

/**
 * The DSH-shipped model ids this plugin prices. The auto check must not invent
 * a table for a changed model catalog: if the official page adds, renames or
 * removes a model column, parsing fails and the user does the manual refresh.
 */
const EXPECTED_MODELS = Object.freeze(['deepseek-flash', 'deepseek-v4-pro'])

/** Billing dimensions the plugin's cost formula consumes, in canonical order. */
const DIMENSIONS = Object.freeze(['hit', 'miss', 'output'])

/** Sanity ceiling: per 1M tokens, any six-figure price is a parse error. */
const MAX_PLAUSIBLE_PRICE = 10_000

/** Tolerance for "consistent peak/off-peak ratio" and `tablesEqual`. */
const EPSILON = 1e-9

/* ------------------------------------------------------------------ */
/* 1. HTML → table grid.                                               */
/* ------------------------------------------------------------------ */

const ENTITY_MAP = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
})

/** Decode the handful of entities that can appear inside table cells. */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    const key = String(body).toLowerCase()
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITY_MAP[key] ?? whole
  })
}

/**
 * Cell text: tags → spaces, entities decoded, whitespace collapsed, footnote
 * markers (`(1)`, `(2)`) removed. The stripped footnote is what turns
 * `deepseek-flash<sup>(1)</sup>` into the exact model id.
 */
function normalizeCellText(html) {
  const withoutTags = String(html).replace(/<[^>]*>/g, ' ')
  return decodeEntities(withoutTags)
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*\d+\s*\)/g, '')
    .trim()
}

/** A positive-integer `rowspan` / `colspan` attribute, defaulting to 1. */
function spanValue(attrs, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'i').exec(attrs)
  if (match === null) return 1
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) && value > 0 ? value : 1
}

/** All `<table>` blocks on the page, each as an array of parsed rows. */
function extractTables(html) {
  const tables = []
  const tableRe = /<table(?:\s[^<>]*)?>([\s\S]*?)<\/table\s*>/gi
  let tableMatch
  while ((tableMatch = tableRe.exec(html)) !== null) {
    tables.push(extractRows(tableMatch[1]))
  }
  return tables
}

/** One `<table>` → `[{ text, rowSpan, colSpan }, ...][row]`. */
function extractRows(tableHtml) {
  const rows = []
  const rowRe = /<tr(?:\s[^<>]*)?>([\s\S]*?)<\/tr\s*>/gi
  let rowMatch
  while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
    const cells = []
    const cellRe = /<(td|th)((?:\s[^<>]*)?)>([\s\S]*?)<\/\1\s*>/gi
    let cellMatch
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      const attrs = cellMatch[2] ?? ''
      cells.push({
        text: normalizeCellText(cellMatch[3]),
        rowSpan: spanValue(attrs, 'rowspan'),
        colSpan: spanValue(attrs, 'colspan'),
      })
    }
    rows.push(cells)
  }
  return rows
}

/**
 * Expand `rowspan` / `colspan` into a rectangular grid of cell texts. Spanned
 * cells are repeated in every row/column they cover, so a peak row without its
 * own dimension label still exposes the inherited label at the same column.
 */
function buildGrid(rows) {
  const grid = []
  /** @type {Map<number, { text: string, remaining: number }>} */
  const carried = new Map()

  for (const rowCells of rows) {
    const cells = []
    const carriedColumns = [...carried.keys()].sort((left, right) => left - right)
    const preexisting = new Set(carriedColumns)
    let cellIndex = 0
    let column = 0

    while (cellIndex < rowCells.length || carriedColumns.some(col => col >= column)) {
      const carriedCell = carried.get(column)
      if (carriedCell !== undefined) {
        cells[column] = carriedCell.text
        column += 1
        continue
      }
      if (cellIndex >= rowCells.length) {
        const nextColumn = carriedColumns.find(col => col >= column)
        if (nextColumn === undefined) break
        cells[nextColumn] = carried.get(nextColumn).text
        column = nextColumn + 1
        continue
      }
      const cell = rowCells[cellIndex]
      cellIndex += 1
      for (let offset = 0; offset < cell.colSpan; offset += 1) {
        cells[column + offset] = cell.text
        if (cell.rowSpan > 1) {
          carried.set(column + offset, { text: cell.text, remaining: cell.rowSpan - 1 })
        }
      }
      column += cell.colSpan
    }

    // Every carry read by this row or started before it ages by exactly one row.
    for (const carriedColumn of preexisting) {
      const entry = carried.get(carriedColumn)
      if (entry === undefined) continue
      entry.remaining -= 1
      if (entry.remaining <= 0) carried.delete(carriedColumn)
    }
    grid.push(cells)
  }
  return grid
}

/* ------------------------------------------------------------------ */
/* 2. Cell classification.                                             */
/* ------------------------------------------------------------------ */

/** Model ids are lowercase slug cells (`deepseek-flash`, `deepseek-v4-pro`). */
const MODEL_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/

const OFF_PEAK_RE = /^(?:空闲时段|空闲|off[\s-]?peak)$/i
const PEAK_RE = /^(?:高峰时段|高峰|peak)$/i

const DIMENSION_MARKERS = Object.freeze([
  ['miss', /缓存\s*未命中|cache\s*miss/i],
  ['hit', /缓存\s*命中|cache\s*hit/i],
  ['output', /输出|output/i],
])

/** Classify a row label as cache-hit / cache-miss / output, if it is one. */
function dimensionOf(text) {
  for (const [dimension, marker] of DIMENSION_MARKERS) {
    if (marker.test(text)) return dimension
  }
  return null
}

/**
 * `0.02元`, `1元`, `$0.003`, `US$0.15` → `{ ok: true, value }`.
 * The currency marker is required: a bare number means the cell was truncated
 * or the page changed format, so it must not be trusted.
 */
function parsePriceCell(text, currency) {
  const match = /^(?:(US\$|¥|￥|\$|CNY|USD)\s*)?(\d+(?:\.\d+)?)\s*(元|美元|CNY|USD)?$/i.exec(text)
  if (match === null) return { ok: false, error: `price cell ${JSON.stringify(text)} is not a number with a currency marker` }

  const prefix = match[1] === undefined ? '' : match[1].toUpperCase()
  const suffix = match[3] === undefined ? '' : match[3].toUpperCase()
  const markerCurrency = raw => {
    if (raw === '') return null
    if (raw === '元' || raw === '¥' || raw === 'CNY') return 'CNY'
    if (raw === '$' || raw === 'US$' || raw === 'USD' || raw === '美元') return 'USD'
    return 'unknown'
  }
  const prefixCurrency = markerCurrency(prefix)
  const suffixCurrency = markerCurrency(suffix)

  if (prefixCurrency === null && suffixCurrency === null) {
    return { ok: false, error: `price cell ${JSON.stringify(text)} has no currency marker` }
  }
  if (prefixCurrency === 'unknown' || suffixCurrency === 'unknown') {
    return { ok: false, error: `price cell ${JSON.stringify(text)} uses an unknown currency marker` }
  }
  if (prefixCurrency !== null && suffixCurrency !== null && prefixCurrency !== suffixCurrency) {
    return { ok: false, error: `price cell ${JSON.stringify(text)} mixes currencies` }
  }
  const cellCurrency = prefixCurrency ?? suffixCurrency
  if (cellCurrency !== currency) {
    return { ok: false, error: `currency mismatch: expected ${currency} but price cell ${JSON.stringify(text)} is ${cellCurrency}` }
  }

  const value = Number(match[2])
  if (!Number.isFinite(value)) return { ok: false, error: `price cell ${JSON.stringify(text)} is not a finite number` }
  if (!(value > 0)) return { ok: false, error: `price cell ${JSON.stringify(text)} is not positive` }
  if (!(value < MAX_PLAUSIBLE_PRICE)) return { ok: false, error: `price cell ${JSON.stringify(text)} is implausibly large` }
  return { ok: true, value }
}

/* ------------------------------------------------------------------ */
/* 3. Table parser.                                                    */
/* ------------------------------------------------------------------ */

function fail(error) {
  return { ok: false, error }
}

/**
 * Find the most model-like header row. Returns the grid row index plus
 * `{ col, text }` for every model-like header cell and how many expected
 * models it named. A row that names only one expected model is still returned
 * (as the best candidate) so the caller can report the model-set mismatch
 * instead of a generic "table not found" error.
 */
function findModelHeader(grid) {
  let best = null
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex += 1) {
    const modelCells = []
    for (let column = 0; column < grid[rowIndex].length; column += 1) {
      const text = grid[rowIndex][column]
      if (typeof text === 'string' && MODEL_ID_RE.test(text)) modelCells.push({ col: column, text })
    }
    if (modelCells.length === 0) continue
    const matched = EXPECTED_MODELS.filter(expected => modelCells.some(cell => cell.text === expected)).length
    if (best === null || matched > best.matched) best = { rowIndex, modelCells, matched }
    if (matched === EXPECTED_MODELS.length) break
  }
  return best
}

/** Parse one table whose header row already names both expected models. */
function parsePricingTable(grid, header, currency) {
  const modelOrder = header.modelCells.map(cell => cell.text)
  const expectedSet = [...EXPECTED_MODELS].sort()
  const foundSet = [...new Set(modelOrder)].sort()
  if (foundSet.length !== expectedSet.length || foundSet.some((model, index) => model !== expectedSet[index])) {
    return fail(`model columns mismatch: expected [${EXPECTED_MODELS.join(', ')}], found [${foundSet.join(', ')}]`)
  }

  /** @type {Record<string, Record<string, { offpeak?: number, peak?: number }>>} */
  const collected = {}
  for (const model of modelOrder) {
    collected[model] = { hit: {}, miss: {}, output: {} }
  }

  let priceRowCount = 0
  for (let rowIndex = header.rowIndex + 1; rowIndex < grid.length; rowIndex += 1) {
    const row = grid[rowIndex]

    let period = null
    let periodColumn = -1
    for (let column = 0; column < row.length; column += 1) {
      const text = row[column]
      if (typeof text !== 'string') continue
      if (OFF_PEAK_RE.test(text)) {
        period = 'offpeak'
        periodColumn = column
        break
      }
      if (PEAK_RE.test(text)) {
        period = 'peak'
        periodColumn = column
        break
      }
    }
    if (period === null) continue
    priceRowCount += 1

    const dimensions = []
    for (let column = 0; column < periodColumn; column += 1) {
      const text = row[column]
      if (typeof text !== 'string') continue
      const dimension = dimensionOf(text)
      if (dimension !== null) dimensions.push(dimension)
    }
    if (dimensions.length > 1) {
      // Duplicated rowspans (e.g. a removed row) could otherwise mis-classify
      // a price row; refuse rather than guess which label is authoritative.
      const labels = row.filter(text => typeof text === 'string' && text !== '').join(' | ')
      return fail(`pricing row has multiple billing labels (${dimensions.join(', ')}): ${labels}`)
    }
    if (dimensions.length === 0) {
      const labels = row.filter(text => typeof text === 'string' && text !== '').join(' | ')
      return fail(`pricing row with window label "${row[periodColumn]}" has no cache-hit/cache-miss/output label: ${labels}`)
    }
    const dimension = dimensions[0]

    const valueCells = []
    for (let column = periodColumn + 1; column < row.length; column += 1) {
      const text = row[column]
      if (typeof text === 'string' && text !== '') valueCells.push(text)
    }
    if (valueCells.length !== modelOrder.length) {
      return fail(`pricing row ${dimension}/${period} has ${valueCells.length} price cell(s); expected ${modelOrder.length} (${modelOrder.join(', ')})`)
    }

    for (let index = 0; index < modelOrder.length; index += 1) {
      const model = modelOrder[index]
      const parsed = parsePriceCell(valueCells[index], currency)
      if (!parsed.ok) {
        return fail(`${parsed.error} (row ${dimension}/${period}, model ${model})`)
      }
      const slot = collected[model][dimension]
      if (slot[period] !== undefined) {
        return fail(`duplicate pricing row for ${model}/${dimension}/${period}`)
      }
      slot[period] = parsed.value
    }
  }

  if (priceRowCount === 0) return fail('pricing table has no off-peak/peak rows below the model header')

  // Every model must carry all three dimensions in both tariff windows.
  const ratios = []
  const ratioRefs = []
  const table = {}
  for (const model of modelOrder) {
    const row = {}
    for (const dimension of DIMENSIONS) {
      const slot = collected[model][dimension]
      if (slot.offpeak === undefined) return fail(`missing off-peak ${dimension} price for ${model}`)
      if (slot.peak === undefined) return fail(`missing peak ${dimension} price for ${model}`)
      const ratio = slot.peak / slot.offpeak
      if (!Number.isFinite(ratio) || ratio <= 0) {
        return fail(`invalid peak/off-peak ratio for ${model}/${dimension}`)
      }
      ratios.push(ratio)
      ratioRefs.push(`${model}/${dimension}`)
      row[dimension] = slot.offpeak
    }
    table[model] = row
  }

  // The multiplier must be evidence from every price pair, never assumed.
  const reference = ratios[0]
  for (let index = 0; index < ratios.length; index += 1) {
    if (Math.abs(ratios[index] - reference) > EPSILON) {
      return fail(`inconsistent peak/off-peak ratio across prices: ${ratioRefs[0]}=${reference} vs ${ratioRefs[index]}=${ratios[index]}`)
    }
  }
  let peakMultiplier = reference
  const rounded = Math.round(peakMultiplier)
  if (rounded > 0 && Math.abs(rounded - peakMultiplier) <= EPSILON) peakMultiplier = rounded

  return { ok: true, table, peakMultiplier }
}

/**
 * Parse one official pricing page.
 *
 * @param {string} html - Fetched page HTML.
 * @param {'CNY'|'USD'} currency - Expected currency of the page's price cells.
 * @returns {{ ok: true, table: Record<string, { hit: number, miss: number, output: number }>, peakMultiplier: number }
 *   | { ok: false, error: string }} Off-peak prices per 1M tokens, plus the
 *   evidence-based peak/off-peak multiplier.
 *
 * Fails closed: both model columns, all three price dimensions, both tariff
 * windows, currency markers and a consistent peak ratio are all required.
 * Never throws.
 */
export function parsePricingHtml(html, currency) {
  try {
    const resolvedCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
    if (!Object.hasOwn(PRICING_URLS, resolvedCurrency)) {
      return fail(`unsupported currency ${JSON.stringify(currency)}; expected CNY or USD`)
    }
    if (typeof html !== 'string' || html.trim() === '') {
      return fail('pricing page html is empty')
    }

    const tables = extractTables(html)
    if (tables.length === 0) {
      return fail('no <table> found in pricing page html')
    }

    const parsedTables = []
    const headerErrors = []
    for (const rows of tables) {
      const grid = buildGrid(rows)
      const header = findModelHeader(grid)
      if (header === null) continue
      const parsed = parsePricingTable(grid, header, resolvedCurrency)
      if (parsed.ok) parsedTables.push(parsed)
      else headerErrors.push(parsed.error)
    }

    if (parsedTables.length === 0) {
      if (headerErrors.length > 0) return fail(headerErrors[0])
      return fail(`pricing table with model columns [${EXPECTED_MODELS.join(', ')}] not found in page html`)
    }
    if (parsedTables.length > 1) {
      const [first] = parsedTables
      const ambiguous = parsedTables.some(candidate => candidate.peakMultiplier !== first.peakMultiplier
        || !tablesEqual(candidate.table, first.table))
      if (ambiguous) {
        return fail(`ambiguous pricing pages: ${parsedTables.length} tables contain the expected model columns but disagree`)
      }
    }
    return parsedTables[0]
  } catch (error) {
    return fail(`pricing page parse failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ------------------------------------------------------------------ */
/* 4. Network fetch.                                                   */
/* ------------------------------------------------------------------ */

/**
 * Fetch and parse one official pricing page. Never throws: network, HTTP,
 * timeout and parse failures all become `{ ok: false, error }`.
 *
 * @param {object} [options]
 * @param {'CNY'|'USD'} [options.currency]
 * @param {string} [options.url] - Defaults to `PRICING_URLS[currency]`.
 * @param {number} [options.timeoutMs] - Abort timeout, default 20 s.
 * @param {typeof fetch} [options.fetchImpl] - Injectable fetch for tests.
 * @returns {Promise<
 *   { ok: true, currency: string, table: Record<string, { hit: number, miss: number, output: number }>, peakMultiplier: number, url: string, fetchedAt: string }
 *   | { ok: false, currency: string, url: string | undefined, error: string, fetchedAt: string }>}
 */
export async function fetchOfficialPrices(options = {}) {
  const fetchedAt = new Date().toISOString()
  let currency = ''
  let resolvedUrl

  try {
    const {
      currency: rawCurrency,
      url,
      timeoutMs = 20_000,
      fetchImpl = globalThis.fetch,
    } = options ?? {}

    currency = typeof rawCurrency === 'string' ? rawCurrency.trim().toUpperCase() : String(rawCurrency ?? '')
    if (!Object.hasOwn(PRICING_URLS, currency)) {
      return { ok: false, currency, url: undefined, error: `unsupported currency ${JSON.stringify(rawCurrency)}; expected CNY or USD`, fetchedAt }
    }

    resolvedUrl = typeof url === 'string' && url.trim() !== '' ? url.trim() : PRICING_URLS[currency]
    let parsedUrl
    try {
      parsedUrl = new URL(resolvedUrl)
    } catch (_invalidUrl) {
      return { ok: false, currency, url: resolvedUrl, error: `invalid pricing url ${JSON.stringify(resolvedUrl)}`, fetchedAt }
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { ok: false, currency, url: resolvedUrl, error: `unsupported pricing url protocol ${parsedUrl.protocol}`, fetchedAt }
    }
    if (typeof fetchImpl !== 'function') {
      return { ok: false, currency, url: resolvedUrl, error: 'global fetch is unavailable; pass fetchImpl', fetchedAt }
    }

    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : 20_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    timer.unref?.()

    try {
      const response = await fetchImpl(resolvedUrl, {
        signal: controller.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'dsh-session-cost/1.0 (official price check)',
        },
      })
      if (response === null || typeof response !== 'object') {
        return { ok: false, currency, url: resolvedUrl, error: 'pricing page fetch returned no response', fetchedAt }
      }
      const status = typeof response.status === 'number' ? response.status : 200
      if (response.ok === false || status < 200 || status >= 300) {
        const statusText = typeof response.statusText === 'string' && response.statusText !== '' ? ` ${response.statusText}` : ''
        return { ok: false, currency, url: resolvedUrl, error: `official pricing page returned HTTP ${status}${statusText}`, fetchedAt }
      }
      if (typeof response.text !== 'function') {
        return { ok: false, currency, url: resolvedUrl, error: 'pricing page response has no text() method', fetchedAt }
      }

      const html = await response.text()
      const parsed = parsePricingHtml(html, currency)
      if (!parsed.ok) {
        return { ok: false, currency, url: resolvedUrl, error: parsed.error, fetchedAt }
      }
      return {
        ok: true,
        currency,
        table: parsed.table,
        peakMultiplier: parsed.peakMultiplier,
        url: resolvedUrl,
        fetchedAt,
      }
    } catch (error) {
      const message = controller.signal.aborted
        ? `pricing page fetch timed out after ${timeout} ms`
        : `pricing page fetch failed: ${error instanceof Error ? error.message : String(error)}`
      return { ok: false, currency, url: resolvedUrl, error: message, fetchedAt }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return { ok: false, currency, url: resolvedUrl, error: `pricing page fetch failed: ${error instanceof Error ? error.message : String(error)}`, fetchedAt }
  }
}

/* ------------------------------------------------------------------ */
/* 5. Table comparison.                                                */
/* ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Compare two `{ model: { hit, miss, output } }` tables by model key and value,
 * in either argument order. Equal when both tables have the same model set and
 * every `hit` / `miss` / `output` differs by at most `epsilon`.
 */
export function tablesEqual(left, right, epsilon = EPSILON) {
  const tolerance = Number.isFinite(epsilon) && epsilon >= 0 ? epsilon : EPSILON
  if (!isRecord(left) || !isRecord(right)) return false
  const leftModels = Object.keys(left)
  const rightModels = Object.keys(right)
  if (leftModels.length !== rightModels.length) return false
  for (const model of leftModels) {
    if (!Object.hasOwn(right, model)) return false
    const leftRow = left[model]
    const rightRow = right[model]
    if (!isRecord(leftRow) || !isRecord(rightRow)) return false
    for (const dimension of DIMENSIONS) {
      const leftValue = leftRow[dimension]
      const rightValue = rightRow[dimension]
      if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return false
      if (Math.abs(leftValue - rightValue) > tolerance) return false
    }
  }
  return true
}
