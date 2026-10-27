/**
 * Offline tests for `prices.js`.
 *
 * Golden fixtures under `test/fixtures/` are the real official pricing pages
 * fetched on 2026-10-28 (see `docs/price-refresh.md` for provenance and the
 * refresh recipe). Everything here runs without network: the fetch tests use
 * injected `fetchImpl` stubs.
 *
 * Run with:  node --test test/prices.test.mjs   (or)  node test/prices.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  PRICING_URLS,
  parsePricingHtml,
  fetchOfficialPrices,
  tablesEqual,
} from '../prices.js'

const FIXTURES = new URL('./fixtures/', import.meta.url)
const readFixture = name => readFileSync(new URL(name, FIXTURES), 'utf8')

const CNY_HTML = readFixture('pricing-cny.html')
const USD_HTML = readFixture('pricing-usd.html')

/** Expected official off-peak prices, per 1M tokens (fetched 2026-10-28). */
const EXPECTED = {
  CNY: {
    'deepseek-flash': { hit: 0.02, miss: 1, output: 4 },
    'deepseek-v4-pro': { hit: 0.15, miss: 4.5, output: 13.5 },
  },
  USD: {
    'deepseek-flash': { hit: 0.003, miss: 0.15, output: 0.6 },
    'deepseek-v4-pro': { hit: 0.022, miss: 0.66, output: 1.98 },
  },
}

/** Replace one exact marker, asserting the fixture really contains it. */
function mutate(html, search, replacement) {
  assert.ok(html.includes(search), `fixture must contain ${JSON.stringify(search)}`)
  return html.replace(search, replacement)
}

/** Minimal fetch Response stand-in. */
function htmlResponse(html, { status = 200, statusText = 'OK' } = {}) {
  return { ok: status >= 200 && status < 300, status, statusText, text: async () => html }
}

/* ------------------------------------------------------------------ */
/* 1. Golden fixtures.                                                 */
/* ------------------------------------------------------------------ */

test('PRICING_URLS points at the official zh-CN and English pricing pages', () => {
  assert.equal(PRICING_URLS.CNY, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/')
  assert.equal(PRICING_URLS.USD, 'https://api-docs.deepseek.com/quick_start/pricing/')
})

test('CNY fixture parses to the exact official off-peak table with a 2x peak', () => {
  const result = parsePricingHtml(CNY_HTML, 'CNY')
  assert.equal(result.ok, true, result.ok ? undefined : result.error)
  assert.deepEqual(result.table, EXPECTED.CNY)
  assert.equal(result.peakMultiplier, 2)
})

test('USD fixture parses to the exact official off-peak table with a 2x peak', () => {
  const result = parsePricingHtml(USD_HTML, 'USD')
  assert.equal(result.ok, true, result.ok ? undefined : result.error)
  assert.deepEqual(result.table, EXPECTED.USD)
  assert.equal(result.peakMultiplier, 2)
})

test('currency argument is normalized case-insensitively', () => {
  const result = parsePricingHtml(CNY_HTML, 'cny')
  assert.equal(result.ok, true, result.ok ? undefined : result.error)
  assert.deepEqual(result.table, EXPECTED.CNY)
})

test('model columns are mapped by header order, not by fixed position', () => {
  const swapped = `
    <table>
      <tr><td colspan="3">模型</td><td>deepseek-v4-pro</td><td>deepseek-flash</td></tr>
      <tr><td rowspan="6">价格</td><td rowspan="2">百万tokens输入（缓存命中）</td><td>空闲时段</td><td>0.15元</td><td>0.02元</td></tr>
      <tr><td>高峰时段</td><td>0.30元</td><td>0.04元</td></tr>
      <tr><td rowspan="2">百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>4.5元</td><td>1元</td></tr>
      <tr><td>高峰时段</td><td>9.0元</td><td>2元</td></tr>
      <tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td><td>13.5元</td><td>4元</td></tr>
      <tr><td>高峰时段</td><td>27.0元</td><td>8元</td></tr>
    </table>`
  const result = parsePricingHtml(swapped, 'CNY')
  assert.equal(result.ok, true, result.ok ? undefined : result.error)
  assert.deepEqual(result.table, EXPECTED.CNY)
  assert.equal(result.peakMultiplier, 2)
})

/* ------------------------------------------------------------------ */
/* 2. Fail-closed parsing.                                             */
/* ------------------------------------------------------------------ */

test('truncated html (price rows cut off) fails closed', () => {
  const truncated = CNY_HTML.slice(0, CNY_HTML.indexOf('rowspan="6"'))
  const result = parsePricingHtml(truncated, 'CNY')
  assert.equal(result.ok, false)
  assert.equal(typeof result.error, 'string')
  assert.ok(result.error.length > 0)
})

test('a price row missing one price cell fails closed', () => {
  const truncatedRow = mutate(CNY_HTML, '<td>0.04元</td><td>0.30元</td>', '<td>0.04元</td>')
  const result = parsePricingHtml(truncatedRow, 'CNY')
  assert.equal(result.ok, false)
  assert.match(result.error, /price cell/i)
})

test('wrong model set fails closed', () => {
  const renamed = mutate(CNY_HTML, '<td>deepseek-v4-pro</td>', '<td>deepseek-v4-max</td>')
  const result = parsePricingHtml(renamed, 'CNY')
  assert.equal(result.ok, false)
  assert.match(result.error, /model columns mismatch/i)
})

test('an extra model column fails closed instead of silently ignoring it', () => {
  const extra = mutate(CNY_HTML, '<td>deepseek-v4-pro</td>', '<td>deepseek-v4-pro</td><td>deepseek-v5</td>')
  const result = parsePricingHtml(extra, 'CNY')
  assert.equal(result.ok, false)
  assert.match(result.error, /model columns mismatch/i)
})

test('non-numeric price fails closed', () => {
  const broken = mutate(CNY_HTML, '<td>1元</td>', '<td>一元</td>')
  const result = parsePricingHtml(broken, 'CNY')
  assert.equal(result.ok, false)
  assert.match(result.error, /price cell/i)
})

test('a price cell without a currency marker fails closed', () => {
  const bare = mutate(CNY_HTML, '<td>0.02元</td>', '<td>0.02</td>')
  const result = parsePricingHtml(bare, 'CNY')
  assert.equal(result.ok, false)
  assert.match(result.error, /currency marker/i)
})

test('implausibly large price fails closed', () => {
  const huge = mutate(CNY_HTML, '<td>0.02元</td>', '<td>99999元</td>')
  const result = parsePricingHtml(huge, 'CNY')
  assert.equal(result.ok, false)
  assert.match(result.error, /implausibly large/i)
})

test('inconsistent peak/off-peak ratio fails closed', () => {
  const inconsistent = mutate(CNY_HTML, '<td>0.04元</td>', '<td>0.05元</td>')
  const result = parsePricingHtml(inconsistent, 'CNY')
  assert.equal(result.ok, false)
  assert.match(result.error, /ratio/i)
})

test('missing peak row fails closed', () => {
  const missing = mutate(CNY_HTML, '<td>高峰时段</td><td>0.04元</td>', '<td>高峰时</td><td>0.04元</td>')
  const result = parsePricingHtml(missing, 'CNY')
  assert.equal(result.ok, false)
  assert.match(result.error, /missing peak hit price/i)
})

test('a structurally corrupted rowspan table fails closed', () => {
  // Removing the whole peak row leaves the inherited dimension rowspan behind;
  // the parser must refuse instead of guessing which billing label wins.
  const corrupted = mutate(
    CNY_HTML,
    '<tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>',
    '',
  )
  const result = parsePricingHtml(corrupted, 'CNY')
  assert.equal(result.ok, false)
  assert.equal(typeof result.error, 'string')
  assert.ok(result.error.length > 0)
})

test('CNY page parsed as USD fails closed on currency mismatch', () => {
  const result = parsePricingHtml(CNY_HTML, 'USD')
  assert.equal(result.ok, false)
  assert.match(result.error, /currency mismatch/i)
})

test('USD page parsed as CNY fails closed on currency mismatch', () => {
  const result = parsePricingHtml(USD_HTML, 'CNY')
  assert.equal(result.ok, false)
  assert.match(result.error, /currency mismatch/i)
})

test('a CNY marker on the USD page fails closed', () => {
  const mixed = mutate(USD_HTML, '<td>$0.003</td>', '<td>0.003元</td>')
  const result = parsePricingHtml(mixed, 'USD')
  assert.equal(result.ok, false)
  assert.match(result.error, /currency mismatch/i)
})

test('unsupported currency fails closed', () => {
  const result = parsePricingHtml(CNY_HTML, 'EUR')
  assert.equal(result.ok, false)
  assert.match(result.error, /unsupported currency/i)
})

test('empty / non-string html fails closed without throwing', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    const result = parsePricingHtml(bad, 'CNY')
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
  }
})

test('html without a table fails closed', () => {
  const result = parsePricingHtml('<html><body><p>maintenance</p></body></html>', 'CNY')
  assert.equal(result.ok, false)
  assert.match(result.error, /no <table> found/i)
})

/* ------------------------------------------------------------------ */
/* 3. fetchOfficialPrices (offline, injected fetch).                   */
/* ------------------------------------------------------------------ */

test('fetchOfficialPrices parses a 200 response and reports metadata', async () => {
  let seenUrl
  let seenInit
  const result = await fetchOfficialPrices({
    currency: 'CNY',
    fetchImpl: async (url, init) => {
      seenUrl = url
      seenInit = init
      return htmlResponse(CNY_HTML)
    },
  })
  assert.equal(seenUrl, PRICING_URLS.CNY)
  assert.ok(seenInit.signal instanceof AbortSignal, 'fetch receives an AbortSignal')
  assert.equal(result.ok, true, result.ok ? undefined : result.error)
  assert.equal(result.currency, 'CNY')
  assert.equal(result.url, PRICING_URLS.CNY)
  assert.deepEqual(result.table, EXPECTED.CNY)
  assert.equal(result.peakMultiplier, 2)
  assert.ok(!Number.isNaN(Date.parse(result.fetchedAt)), 'fetchedAt is an ISO timestamp')
})

test('fetchOfficialPrices honours a url override', async () => {
  const result = await fetchOfficialPrices({
    currency: 'USD',
    url: 'https://example.test/pricing',
    fetchImpl: async () => htmlResponse(USD_HTML),
  })
  assert.equal(result.ok, true, result.ok ? undefined : result.error)
  assert.equal(result.url, 'https://example.test/pricing')
  assert.deepEqual(result.table, EXPECTED.USD)
})

test('non-2xx response is a failure', async () => {
  const result = await fetchOfficialPrices({
    currency: 'CNY',
    fetchImpl: async () => htmlResponse('<html></html>', { status: 500, statusText: 'Internal Server Error' }),
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /HTTP 500/)
})

test('network error is caught and reported, never thrown', async () => {
  const result = await fetchOfficialPrices({
    currency: 'CNY',
    fetchImpl: async () => { throw new Error('socket hang up') },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /socket hang up/)
})

test('parse failure is reported, never thrown', async () => {
  const result = await fetchOfficialPrices({
    currency: 'CNY',
    fetchImpl: async () => htmlResponse('<html><body>maintenance</body></html>'),
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /<table>|pricing table/i)
})

test('timeout aborts the fetch and is reported', async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted by test')))
  })
  const result = await fetchOfficialPrices({ currency: 'CNY', timeoutMs: 20, fetchImpl: hang })
  assert.equal(result.ok, false)
  assert.match(result.error, /timed out after 20 ms/)
})

test('unsupported currency fails before any fetch is attempted', async () => {
  let fetched = false
  const result = await fetchOfficialPrices({
    currency: 'EUR',
    fetchImpl: async () => {
      fetched = true
      return htmlResponse(CNY_HTML)
    },
  })
  assert.equal(result.ok, false)
  assert.equal(fetched, false)
  assert.match(result.error, /unsupported currency/i)
})

test('invalid url or protocol fails closed without fetching', async () => {
  let fetched = false
  const fetchImpl = async () => {
    fetched = true
    return htmlResponse(CNY_HTML)
  }
  const invalid = await fetchOfficialPrices({ currency: 'CNY', url: 'not a url', fetchImpl })
  assert.equal(invalid.ok, false)
  assert.match(invalid.error, /invalid pricing url/i)
  const fileUrl = await fetchOfficialPrices({ currency: 'CNY', url: 'file:///tmp/pricing.html', fetchImpl })
  assert.equal(fileUrl.ok, false)
  assert.match(fileUrl.error, /protocol/i)
  assert.equal(fetched, false)
})

test('missing options / null options fail closed instead of throwing', async () => {
  for (const options of [undefined, null, {}]) {
    const result = await fetchOfficialPrices(options)
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
  }
})

/* ------------------------------------------------------------------ */
/* 4. tablesEqual.                                                     */
/* ------------------------------------------------------------------ */

test('tablesEqual accepts identical tables in either order', () => {
  const left = structuredClone(EXPECTED.CNY)
  const right = structuredClone(EXPECTED.CNY)
  assert.equal(tablesEqual(left, right), true)
  assert.equal(tablesEqual(right, left), true)
})

test('tablesEqual applies the epsilon to every value', () => {
  const left = structuredClone(EXPECTED.USD)
  const right = structuredClone(EXPECTED.USD)
  right['deepseek-flash'].hit += 1e-10
  assert.equal(tablesEqual(left, right), true)
  right['deepseek-flash'].hit += 1e-3
  assert.equal(tablesEqual(left, right), false)
})

test('tablesEqual rejects different model sets and missing values', () => {
  const sameNumbers = structuredClone(EXPECTED.CNY)
  assert.equal(tablesEqual(EXPECTED.CNY, sameNumbers), true) // only model keys + values matter, never the currency label
  const missingModel = { 'deepseek-flash': { ...EXPECTED.CNY['deepseek-flash'] } }
  assert.equal(tablesEqual(EXPECTED.CNY, missingModel), false)
  const extraModel = structuredClone(EXPECTED.CNY)
  extraModel['deepseek-v5'] = { hit: 1, miss: 1, output: 1 }
  assert.equal(tablesEqual(EXPECTED.CNY, extraModel), false)
  const missingDimension = structuredClone(EXPECTED.CNY)
  delete missingDimension['deepseek-flash'].output
  assert.equal(tablesEqual(EXPECTED.CNY, missingDimension), false)
  assert.equal(tablesEqual(EXPECTED.CNY, null), false)
  assert.equal(tablesEqual(null, EXPECTED.CNY), false)
  assert.equal(tablesEqual(EXPECTED.CNY, 42), false)
})
