/**
 * Host half of the Session API Cost bundle.
 *
 * Folds one durable `sessionCost` session projection unit from exactly the
 * events the shipped `tokenUsage` unit totals (same usage samples, same
 * `llm/retry-started` replacement semantics), prices every sample on its own
 * route, at its own tariff window (official DeepSeek peak/off-peak), and with
 * the price revision that was in force at that sample's request time.
 *
 * Price history: `config.prices` holds dated revisions per model. When the
 * official page changes, new revisions are appended (by this plugin's own
 * once-per-interval check) so that sessions before the change keep their old
 * rates and later sessions use the new ones.
 *
 * Auto check: at most once per `autoCheck.intervalDays` (7 by default) the
 * host fetches the official pricing page through `prices.js`, validates the
 * table fail-closed, and — only when the parsed current prices differ from the
 * effective revision — appends an auto revision dated today (Beijing) and
 * re-registers the projection so folds use it. A failed fetch records the
 * failure and leaves the price data untouched; the Client renders that as a
 * warning ("may need a manual check").
 *
 * Attribution facts this fold relies on:
 * - `assistant/message.data.message.source.{provider,model}` names the route
 *   of a settled request; `assistant/attempt` inherits the latest
 *   `request/header` route (the token-meter replay uses the same rule).
 * - `step/start` / `llm/retry-started` carry the durable request-start time
 *   used to pick both the tariff window and the price revision.
 *
 * No npm dependency is used beyond Node built-ins and the local `prices.js`;
 * the projection registry only requires `{ parse(value) }` schema shapes.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fetchOfficialPrices, PRICING_URLS } from './prices.js'

/* ------------------------------------------------------------------ */
/* 1. Tiny runtime schemas the projection registry actually consumes.  */
/* ------------------------------------------------------------------ */

/** Schema floor the projection cache and the wire serializer actually use. */
function guard(check) {
  return {
    parse(value) {
      check(value)
      return value
    },
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInteger(value, min) {
  return Number.isInteger(value) && value >= min
}

const stateSchema = guard((value) => {
  if (!isRecord(value)) throw new Error('sessionCost state must be an object')
  if (!Number.isFinite(value.costNano) || value.costNano < 0) {
    throw new Error('sessionCost state costNano must be a non-negative number')
  }
  if (!isInteger(value.unpricedTokens, 0)) {
    throw new Error('sessionCost state unpricedTokens must be a non-negative integer')
  }
  if (value.route !== null
    && !(isRecord(value.route)
      && typeof value.route.provider === 'string'
      && typeof value.route.model === 'string')) {
    throw new Error('sessionCost state route must be null or { provider, model }')
  }
  if (value.stepStartTime !== null && !Number.isFinite(value.stepStartTime)) {
    throw new Error('sessionCost state stepStartTime must be null or a finite number')
  }
  if (value.last !== null) {
    const last = value.last
    if (!isRecord(last)
      || !isInteger(last.turn, 0)
      || !isInteger(last.step, 0)
      || !isRecord(last.buckets)
      || !Number.isFinite(last.costNano) || last.costNano < 0
      || !isInteger(last.unpricedTokens, 0)) {
      throw new Error('sessionCost state last must be null or a replacement slot')
    }
  }
})

const viewSchema = guard((value) => {
  if (!isRecord(value)
    || !Number.isFinite(value.costNano) || value.costNano < 0
    || typeof value.currency !== 'string'
    || typeof value.unpriced !== 'boolean'
    || !isInteger(value.unpricedTokens, 0)
    || !isInteger(value.checkStatus, 0)
    || (value.priceAsOf !== null && typeof value.priceAsOf !== 'string')
    || (value.priceRevisionAt !== null && typeof value.priceRevisionAt !== 'string')
    || (value.priceCheckedAt !== null && !Number.isFinite(value.priceCheckedAt))
    || (value.priceCheckError !== null && typeof value.priceCheckError !== 'string')) {
    throw new Error('sessionCost view must be { costNano, currency, unpriced, unpricedTokens, checkStatus, priceAsOf, priceRevisionAt, priceCheckedAt, priceCheckError }')
  }
})

/** `checkStatus` wire values (integers keep the wire shape simple). */
const CHECK_NEVER = 0
const CHECK_OK = 1
const CHECK_FAILED = 2

/* ------------------------------------------------------------------ */
/* 2. Price history: dated revisions, normalized to exact milli-units. */
/* ------------------------------------------------------------------ */

/** Integer scale: prices are quoted per 1M tokens; 1 currency unit = 1e9 nano. */
const NANO_PER_UNIT = 1_000_000_000

/** Fallback snapshot when a config carries no prices (kept as the shipped default). */
const DEFAULT_PRICES = {
  CNY: {
    'deepseek-flash': { hit: 0.02, miss: 1, output: 4 },
    'deepseek-v4-pro': { hit: 0.15, miss: 4.5, output: 13.5 },
  },
  USD: {
    'deepseek-flash': { hit: 0.003, miss: 0.15, output: 0.6 },
    'deepseek-v4-pro': { hit: 0.022, miss: 0.66, output: 1.98 },
  },
}
const DEFAULT_PRICES_AS_OF = '2026-10-28'
const DEFAULT_INTERVAL_DAYS = 7
const CHECK_RETRY_FLOOR_MS = 60 * 60 * 1000
const PLUGIN_DATA_DIR = 'session-cost'
const STATE_FILE = 'price-state.json'

/**
 * Official peak windows: Beijing Mon–Fri 09:00–12:00 and 14:00–18:00,
 * excluding Chinese statutory holidays. Beijing has no DST, so a fixed
 * +08:00 offset is exact.
 */
const DEFAULT_TARIFF = {
  enabled: true,
  peakMultiplier: 2,
  utcOffsetMinutes: 480,
  peakWindows: ['09:00-12:00', '14:00-18:00'],
  weekdays: [1, 2, 3, 4, 5],
  holidays: [
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
    '2026-10-06', '2026-10-07',
  ],
}

const ZERO_BUCKETS = () => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/** Provider usage → the four disjoint billed buckets the official total uses. */
function bucketsFrom(usage) {
  return {
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

function bucketsEqual(left, right) {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
}

/** Last `usage` chunk embedded in one settlement stream, when the stream carries one. */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record !== null && typeof record === 'object'
      && record.type === 'chunk'
      && record.chunk !== null && typeof record.chunk === 'object'
      && record.chunk.type === 'usage') {
      return record.chunk.usage
    }
  }
  return undefined
}

/** The provider usage one durable settlement reports, mirroring the token-meter unit. */
function usageOf(event) {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return streamUsage(event.data.stream)
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** `YYYY-MM-DD` → epoch ms at that day's start in the configured zone, or null. */
function dateStartMs(text, utcOffsetMinutes) {
  if (typeof text !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const utc = Date.UTC(year, month - 1, day)
  if (!Number.isFinite(utc)) return null
  return utc - Math.round(utcOffsetMinutes) * 60_000
}

function pad(value) {
  return String(value).padStart(2, '0')
}

/** Today's Beijing calendar date (`YYYY-MM-DD`) for one instant. */
function dateKeyAt(timestamp, utcOffsetMinutes) {
  const shifted = new Date(timestamp + Math.round(utcOffsetMinutes) * 60_000)
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/** One price row (already per 1M, raw currency) → milli-unit triple, or null. */
function priceRowMilli(row) {
  if (!isRecord(row)) return null
  const hit = finiteOr(row.hit ?? row.cacheHit, undefined)
  const miss = finiteOr(row.miss ?? row.cacheMiss, undefined)
  const output = finiteOr(row.output, undefined)
  if (hit === undefined || miss === undefined || output === undefined) return null
  const write = finiteOr(row.write ?? row.cacheWrite, miss)
  return {
    hit: Math.round(hit * 1000),
    miss: Math.round(miss * 1000),
    write: Math.round(write * 1000),
    output: Math.round(output * 1000),
  }
}

/**
 * Normalize one model's config value into sorted dated revisions.
 * Accepts one `{hit,miss,output}` row (any date) or an array of
 * `{from?: 'YYYY-MM-DD', hit, miss, output}` rows.
 * @returns revisions sorted by effective time, or null when the value is unusable.
 */
function normalizeHistory(value, utcOffsetMinutes) {
  const rows = Array.isArray(value) ? value : [value]
  const revisions = []
  for (const row of rows) {
    const milli = priceRowMilli(row)
    if (milli === null) return null
    let fromMs = Number.NEGATIVE_INFINITY
    let from = null
    if (isRecord(row) && row.from !== undefined) {
      const parsed = dateStartMs(row.from, utcOffsetMinutes)
      if (parsed === null) return null
      fromMs = parsed
      from = row.from
    }
    revisions.push({
      from,
      fromMs,
      hit: milli.hit,
      miss: milli.miss,
      write: milli.write,
      output: milli.output,
      auto: row.auto === true,
    })
  }
  revisions.sort((left, right) => left.fromMs - right.fromMs)
  return revisions.length === 0 ? null : revisions
}

/** Normalize one currency table of model → history; drop unusable models. */
function normalizeCurrencyTable(table, utcOffsetMinutes) {
  if (!isRecord(table)) return null
  const models = {}
  for (const [model, value] of Object.entries(table)) {
    const history = normalizeHistory(value, utcOffsetMinutes)
    if (history !== null) models[model] = history
  }
  return Object.keys(models).length === 0 ? null : models
}

/** Read the plugin row Config into closed-over pricing facts. */
function resolveConfig(raw) {
  const config = isRecord(raw) ? raw : {}
  const tariff = normalizeTariff(config.tariffs)
  const currency = typeof config.currency === 'string' && config.currency.length > 0 ? config.currency : 'CNY'

  const declared = isRecord(config.prices) ? config.prices : {}
  const tables = {}
  for (const [id, table] of Object.entries(declared)) {
    const normalized = normalizeCurrencyTable(table, tariff.utcOffsetMinutes)
    if (normalized !== null) tables[id] = normalized
  }
  if (Object.keys(tables).length === 0) {
    for (const [id, table] of Object.entries(DEFAULT_PRICES)) {
      const normalized = normalizeCurrencyTable(table, tariff.utcOffsetMinutes)
      if (normalized !== null) tables[id] = normalized
    }
  }

  const autoRaw = isRecord(config.autoCheck) ? config.autoCheck : {}
  const intervalDays = finiteOr(autoRaw.intervalDays, DEFAULT_INTERVAL_DAYS) || DEFAULT_INTERVAL_DAYS
  const intervalMs = finiteOr(autoRaw.intervalMs, Math.round(intervalDays * 86_400_000))
  const pricingUrls = isRecord(config.pricingUrls) ? config.pricingUrls : {}
  const url = typeof pricingUrls[currency] === 'string' && pricingUrls[currency].length > 0
    ? pricingUrls[currency]
    : (typeof autoRaw.url === 'string' && autoRaw.url.length > 0 ? autoRaw.url : PRICING_URLS[currency])

  return {
    currency,
    tariff,
    prices: tables,
    pricesAsOf: typeof config.pricesAsOf === 'string' && config.pricesAsOf.length > 0
      ? config.pricesAsOf
      : DEFAULT_PRICES_AS_OF,
    autoCheck: {
      enabled: autoRaw.enabled !== false,
      intervalMs: Math.max(CHECK_RETRY_FLOOR_MS, Math.round(intervalMs)),
      url,
    },
    statePath: typeof config.statePath === 'string' && config.statePath.length > 0
      ? (config.statePath.startsWith('~') ? join(homedir(), config.statePath.slice(1)) : resolvePath(config.statePath))
      : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-data', PLUGIN_DATA_DIR, STATE_FILE),
  }
}

/** Normalize the official tariff config (peak windows, holidays). */
function peakWindow(value) {
  let start
  let end
  if (typeof value === 'string') {
    const [rawStart, rawEnd] = value.split('-')
    start = rawStart
    end = rawEnd
  } else if (isRecord(value)) {
    start = value.start
    end = value.end
  }
  if (typeof start !== 'string' || typeof end !== 'string') return null
  const parse = (text) => {
    const [hours, minutes] = text.split(':').map(Number)
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null
    if (hours < 0 || hours > 24 || minutes < 0 || minutes > 59) return null
    return hours * 60 + minutes
  }
  const from = parse(start)
  const to = parse(end)
  if (from === null || to === null || from >= to) return null
  return { from, to }
}

function normalizeTariff(raw) {
  const source = isRecord(raw) ? raw : {}
  const windows = []
  if (Array.isArray(source.peakWindows)) {
    for (const value of source.peakWindows) {
      const window = peakWindow(value)
      if (window !== null) windows.push(window)
    }
  }
  const defaultWindows = DEFAULT_TARIFF.peakWindows.map(peakWindow)
  const weekdays = Array.isArray(source.weekdays)
    ? source.weekdays.filter(day => Number.isInteger(day) && day >= 1 && day <= 7)
    : DEFAULT_TARIFF.weekdays
  const holidays = new Set(
    Array.isArray(source.holidays)
      ? source.holidays.filter(day => typeof day === 'string')
      : DEFAULT_TARIFF.holidays,
  )
  return {
    enabled: source.enabled === undefined ? DEFAULT_TARIFF.enabled : source.enabled !== false,
    peakMultiplier: Math.max(1, Math.round(finiteOr(source.peakMultiplier, DEFAULT_TARIFF.peakMultiplier))),
    utcOffsetMinutes: Math.round(
      typeof source.utcOffsetMinutes === 'number' && Number.isFinite(source.utcOffsetMinutes)
        ? source.utcOffsetMinutes
        : DEFAULT_TARIFF.utcOffsetMinutes,
    ),
    peakWindows: windows.length > 0 ? windows : defaultWindows,
    weekdays: weekdays.length > 0 ? weekdays : DEFAULT_TARIFF.weekdays,
    holidays,
  }
}

/** Whether one request timestamp falls in the official peak tariff window. */
function isPeak(timestamp, tariff) {
  if (!tariff.enabled || !Number.isFinite(timestamp)) return false
  const shifted = new Date(timestamp + tariff.utcOffsetMinutes * 60_000)
  const weekday = shifted.getUTCDay()
  const isoWeekday = weekday === 0 ? 7 : weekday
  if (!tariff.weekdays.includes(isoWeekday)) return false
  const dateKey = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
  if (tariff.holidays.has(dateKey)) return false
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  return tariff.peakWindows.some(window => minutes >= window.from && minutes < window.to)
}

/* ------------------------------------------------------------------ */
/* 3. Persisted auto-check state and price-history merge.              */
/* ------------------------------------------------------------------ */

function freshStatus() {
  return {
    version: 1,
    lastCheckAt: null,
    lastCheckOk: null,
    lastSuccessAt: null,
    lastError: null,
    revisions: {},
  }
}

/** Read the persisted auto-check state, falling back to a fresh one. */
function loadStatus(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(parsed)) return freshStatus()
    return {
      version: 1,
      lastCheckAt: typeof parsed.lastCheckAt === 'number' ? parsed.lastCheckAt : null,
      lastCheckOk: typeof parsed.lastCheckOk === 'boolean' ? parsed.lastCheckOk : null,
      lastSuccessAt: typeof parsed.lastSuccessAt === 'number' ? parsed.lastSuccessAt : null,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      revisions: isRecord(parsed.revisions) ? parsed.revisions : {},
    }
  } catch (_missingOrCorrupt) {
    return freshStatus()
  }
}

/** Persist the auto-check state atomically; a failed write only loses the check history. */
function saveStatus(path, status) {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(status, null, 2))
    renameSync(temp, path)
    return true
  } catch (_unwritable) {
    return false
  }
}

/**
 * Overlay persisted auto revisions on the config baseline. Same `from` date in
 * the overlay replaces the baseline row (an auto-detected update wins).
 * @returns merged currency → model → sorted revisions.
 */
function mergePrices(baseline, overlayRaw, utcOffsetMinutes) {
  const merged = {}
  const currencies = new Set([...Object.keys(baseline), ...Object.keys(overlayRaw ?? {})])
  for (const currency of currencies) {
    const base = baseline[currency] ?? {}
    const overlay = normalizeCurrencyTable(overlayRaw?.[currency], utcOffsetMinutes) ?? {}
    const models = {}
    for (const model of new Set([...Object.keys(base), ...Object.keys(overlay)])) {
      const rows = [...(base[model] ?? []), ...(overlay[model] ?? [])]
      const byFrom = new Map()
      for (const row of rows) {
        const key = row.fromMs === Number.NEGATIVE_INFINITY ? '∞' : String(row.fromMs)
        const previous = byFrom.get(key)
        // Overlay rows are appended last, so a later row for the same instant wins.
        if (previous === undefined || row.auto || !previous.auto) byFrom.set(key, row)
      }
      const sorted = [...byFrom.values()].sort((left, right) => left.fromMs - right.fromMs)
      if (sorted.length > 0) models[model] = sorted
    }
    merged[currency] = models
  }
  return merged
}

/** Effective revision for one history at a given instant (earliest as fallback). */
function effectiveRevision(history, timestamp) {
  if (!Array.isArray(history) || history.length === 0) return null
  let current = history[0]
  for (const revision of history) {
    if (revision.fromMs <= timestamp) current = revision
    else break
  }
  return current
}

/** Most recent revision date (display label) among merged histories of one currency. */
function latestRevisionDate(prices, currency) {
  let latest = null
  for (const history of Object.values(prices[currency] ?? {})) {
    for (const revision of history) if (revision.from !== null && (latest === null || revision.from > latest)) latest = revision.from
  }
  return latest
}

/** Current effective table (per 1M, raw currency) for one currency at one instant. */
function effectiveTable(prices, currency, timestamp) {
  const table = {}
  for (const [model, history] of Object.entries(prices[currency] ?? {})) {
    const revision = effectiveRevision(history, timestamp)
    if (revision === null) continue
    table[model] = { offPeak: { hit: revision.hit / 1000, miss: revision.miss / 1000, output: revision.output / 1000 } }
  }
  return table
}

/* ------------------------------------------------------------------ */
/* 4. The projection unit.                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the `sessionCost` projection definition.
 * @param economy - validated config + merged price history (mutated by the updater).
 * @param status - shared auto-check status object read by the wire view.
 */
function defineProjection(economy, status) {
  const priceOf = (route, timestamp) => {
    const table = economy.prices[economy.currency]
    if (table === undefined) return null
    if (route === null) return null
    const keys = [`${route.provider}/${route.model}`, `*/${route.model}`, route.model]
    for (const key of keys) {
      if (Object.hasOwn(table, key)) return effectiveRevision(table[key], timestamp)
    }
    return null
  }

  const priceSample = (buckets, route, timestamp) => {
    const price = priceOf(route, timestamp)
    if (price === null) {
      return {
        costNano: 0,
        unpricedTokens: buckets.uncachedInputTokens + buckets.cacheReadTokens
          + buckets.cacheWriteTokens + buckets.outputTokens,
      }
    }
    const multiplier = isPeak(timestamp, economy.tariff) ? economy.tariff.peakMultiplier : 1
    // `price` fields are milli-units (price × 1000, quoted per 1M tokens), so
    // `tokens × milli` is already nano-units of the display currency.
    const costNano = multiplier * (
      buckets.uncachedInputTokens * price.miss
      + buckets.cacheReadTokens * price.hit
      + buckets.cacheWriteTokens * price.write
      + buckets.outputTokens * price.output
    )
    return { costNano: Math.round(costNano), unpricedTokens: 0 }
  }

  const init = () => ({
    route: null,
    stepStartTime: null,
    costNano: 0,
    unpricedTokens: 0,
    last: null,
  })

  /**
   * Pure event fold. A malformed event must never throw: the registry drives
   * every registered unit from the same `session/event` listener.
   */
  const apply = (state, event) => {
    try {
      const type = event.type
      if (type === 'request/header') {
        const config = event.data?.header?.config
        const provider = config?.provider
        const model = config?.model
        if (typeof provider !== 'string' || typeof model !== 'string') return state
        if (state.route !== null && state.route.provider === provider && state.route.model === model) return state
        return { ...state, route: { provider, model } }
      }
      if (type === 'step/start') {
        const time = event.time
        if (!Number.isFinite(time) || time === state.stepStartTime) return state
        return { ...state, stepStartTime: time }
      }
      if (type === 'llm/retry-started') {
        const time = Number.isFinite(event.time) ? event.time : state.stepStartTime
        const retried = state.last !== null
          && state.last.turn === event.data?.turn
          && state.last.step === event.data?.step
        if (!retried && time === state.stepStartTime) return state
        return { ...state, stepStartTime: time, last: retried ? null : state.last }
      }
      if (type !== 'assistant/message' && type !== 'assistant/attempt') return state
      const usage = usageOf(event)
      if (usage === undefined) return state
      const turn = event.data?.turn
      const step = event.data?.step
      if (!Number.isInteger(turn) || !Number.isInteger(step)) return state
      const buckets = bucketsFrom(usage)
      const previous = state.last !== null && state.last.turn === turn && state.last.step === step
        ? state.last
        : null
      if (previous !== null && bucketsEqual(previous.buckets, buckets)) return state

      const source = type === 'assistant/message' ? event.data?.message?.source : undefined
      const route = source !== null && typeof source === 'object'
        && typeof source.provider === 'string'
        && typeof source.model === 'string'
        ? { provider: source.provider, model: source.model }
        : state.route
      const timestamp = state.stepStartTime ?? event.time
      const sample = priceSample(buckets, route, timestamp)

      const costNano = state.costNano - (previous?.costNano ?? 0) + sample.costNano
      const unpricedTokens = state.unpricedTokens - (previous?.unpricedTokens ?? 0) + sample.unpricedTokens
      const last = { turn, step, buckets, costNano: sample.costNano, unpricedTokens: sample.unpricedTokens }
      return costNano === state.costNano && unpricedTokens === state.unpricedTokens
        ? { ...state, last }
        : { ...state, costNano, unpricedTokens, last }
    } catch (_malformedEvent) {
      return state
    }
  }

  return {
    key: 'sessionCost',
    stateVersion: 2,
    stateSchema,
    init,
    apply,
    wire: {
      viewSchema,
      view: (state) => ({
        costNano: state.costNano,
        currency: economy.currency,
        unpriced: state.unpricedTokens > 0,
        unpricedTokens: state.unpricedTokens,
        checkStatus: status.lastCheckOk === true
          ? CHECK_OK
          : status.lastCheckOk === false ? CHECK_FAILED : CHECK_NEVER,
        priceAsOf: economy.pricesAsOf,
        priceRevisionAt: latestRevisionDate(economy.prices, economy.currency),
        priceCheckedAt: status.lastCheckAt,
        priceCheckError: status.lastError,
      }),
    },
  }
}

/* ------------------------------------------------------------------ */
/* 5. Once-per-interval official price check.                          */
/* ------------------------------------------------------------------ */

/** Append one auto revision per model when the fetched table differs from the effective one. */
function appendAutoRevisions(economy, status, table, now) {
  const currency = economy.currency
  const overlay = isRecord(status.revisions) ? status.revisions : {}
  const currencyOverlay = isRecord(overlay[currency]) ? overlay[currency] : {}
  const current = effectiveTable(economy.prices, currency, now)
  let changed = false
  for (const [model, row] of Object.entries(table)) {
    const effective = current[model]?.offPeak
    const same = effective !== undefined
      && Math.abs(effective.hit - row.hit) < 1e-9
      && Math.abs(effective.miss - row.miss) < 1e-9
      && Math.abs(effective.output - row.output) < 1e-9
    if (same) continue
    changed = true
    const from = dateKeyAt(now, economy.tariff.utcOffsetMinutes)
    const rows = Array.isArray(currencyOverlay[model]) ? currencyOverlay[model] : []
    // One revision per day: a repeated check on the same day replaces its row.
    const kept = rows.filter(row => !isRecord(row) || row.from !== from)
    kept.push({ from, hit: row.hit, miss: row.miss, output: row.output, auto: true, detectedAt: now })
    currencyOverlay[model] = kept
  }
  if (!changed) return false
  overlay[currency] = currencyOverlay
  status.revisions = overlay
  economy.prices = mergePrices(economy.baselinePrices, status.revisions, economy.tariff.utcOffsetMinutes)
  return true
}

/**
 * Wire the auto check: initial due-check, a 6-hour wake-up, and one in-flight
 * run at a time. Returns stop functions for the owning plugin effect.
 */
function startAutoCheck({ economy, status, statePath, onPricesApplied }) {
  let inflight = null
  let stopped = false

  const run = async () => {
    if (stopped || inflight !== null) return inflight
    inflight = (async () => {
      const now = Date.now()
      const result = await fetchOfficialPrices({
        currency: economy.currency,
        url: economy.autoCheck.url,
        timeoutMs: 20_000,
      })
      if (stopped) return
      status.lastCheckAt = Date.now()
      if (result.ok === true) {
        // The published schedule defines peak as exactly N× off-peak. The
        // parser proves that N from the page; when it no longer matches the
        // configured tariff, the peak window itself may have changed, so report
        // it for a manual review instead of silently mispricing peak samples.
        if (!Number.isFinite(result.peakMultiplier)
          || Math.abs(result.peakMultiplier - economy.tariff.peakMultiplier) > 1e-9) {
          status.lastCheckOk = false
          status.lastError = `official peak multiplier is ×${String(result.peakMultiplier)} but tariffs.peakMultiplier is ×${String(economy.tariff.peakMultiplier)}; review tariffs manually`
          saveStatus(statePath, status)
          return
        }
        const applied = appendAutoRevisions(economy, status, result.table, now)
        status.lastCheckOk = true
        status.lastSuccessAt = status.lastCheckAt
        status.lastError = null
        saveStatus(statePath, status)
        if (applied) onPricesApplied()
      } else {
        status.lastCheckOk = false
        status.lastError = String(result.error ?? 'pricing page fetch/parse failed').slice(0, 300)
        saveStatus(statePath, status)
      }
    })().catch((error) => {
      if (stopped) return
      status.lastCheckAt = Date.now()
      status.lastCheckOk = false
      status.lastError = String(error?.message ?? error).slice(0, 300)
      saveStatus(statePath, status)
    }).finally(() => { inflight = null })

    return inflight
  }

  const due = () => {
    if (!economy.autoCheck.enabled) return false
    if (status.lastCheckAt === null) return true
    return Date.now() - status.lastCheckAt >= economy.autoCheck.intervalMs
  }

  const wake = () => { if (due()) void run() }

  const initial = setTimeout(wake, 2_000)
  initial.unref?.()
  const timer = setInterval(wake, 6 * 60 * 60 * 1000)
  timer.unref?.()

  return () => {
    stopped = true
    clearTimeout(initial)
    clearInterval(timer)
  }
}

/* ------------------------------------------------------------------ */
/* 6. Plugin body.                                                     */
/* ------------------------------------------------------------------ */

/**
 * Register the cost projection unit and its price-maintenance loop.
 * @param ctx - Host plugin context (injects `sessionProjections`).
 * @param config - row Config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const economy = resolveConfig(config)
  const status = loadStatus(economy.statePath)
  economy.baselinePrices = economy.prices
  economy.prices = mergePrices(economy.baselinePrices, status.revisions, economy.tariff.utcOffsetMinutes)

  let disposeRegistration = null
  const registerProjection = () => {
    try {
      disposeRegistration?.()
    } catch (_alreadyDisposed) {
      /* idempotent registration disposal */
    }
    disposeRegistration = ctx.sessionProjections.register(defineProjection(economy, status))
  }
  registerProjection()
  ctx.effect(() => () => {
    try {
      disposeRegistration?.()
    } catch (_alreadyDisposed) {
      /* idempotent registration disposal */
    }
  }, 'session-cost: cost projection')

  const stopAutoCheck = startAutoCheck({
    economy,
    status,
    statePath: economy.statePath,
    // Re-registering resets the unit's cells, so every Session refolds with the
    // new revision on its next drive/read.
    onPricesApplied: () => registerProjection(),
  })
  ctx.effect(() => () => { stopAutoCheck() }, 'session-cost: price auto-check')
}

export const inject = ['sessionProjections']
