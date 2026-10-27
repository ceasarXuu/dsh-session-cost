#!/usr/bin/env node
/**
 * Manual price refresh / diagnostic CLI for the @local/session-cost bundle.
 *
 * Fetches the official DeepSeek pricing pages (CNY and USD), runs them through
 * the same fail-closed parser the host auto check uses (`../prices.js`), compares
 * the result with the plugin's current baseline table in `cordis.patch.yml`
 * (read-only), and prints a ready-to-paste YAML revision block dated with
 * today's Beijing date.
 *
 * Baseline format understood (the shape this bundle ships):
 *
 *   config:
 *     prices:
 *       CNY:
 *         deepseek-flash:
 *           - from: '2026-10-28'     # dated revision list, or
 *             hit: 0.02              #   the simple one-row {hit,miss,output} form
 *             miss: 1
 *             output: 4
 *
 * The effective baseline for comparison is the newest `from` revision of each
 * model (revisions without `from` are treated as the oldest).
 *
 * This tool never writes a config, profile state or plugin-data file: the
 * auto check keeps its own persisted state, and a manual refresh is a
 * deliberate copy/paste by the user.
 *
 * Usage:
 *   node scripts/refresh-prices.mjs            # human-readable report
 *   node scripts/refresh-prices.mjs --json     # machine-readable JSON
 *   node scripts/refresh-prices.mjs --help
 *
 * Exit code: 1 when any fetch/parse failed; baseline problems only warn,
 * because the parsed prices are still valid on their own.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PRICING_URLS, fetchOfficialPrices } from '../prices.js'

const CURRENCIES = ['CNY', 'USD']
const FIELDS = ['hit', 'miss', 'output']
const EPSILON = 1e-9
const CONFIG_URL = new URL('../cordis.patch.yml', import.meta.url)
const CONFIG_PATH = fileURLToPath(CONFIG_URL)
const OFFICIAL_TZ = 'Asia/Shanghai'
const DEFAULT_PRICES_INDENT = 8

const HELP = `Manual price refresh / diagnostic for @local/session-cost.

Usage:
  node scripts/refresh-prices.mjs [--json] [--help]

Fetches:
  CNY  ${PRICING_URLS.CNY}
  USD  ${PRICING_URLS.USD}

Both pages are parsed fail-closed by prices.js (the same code the host auto
check uses), compared with the newest baseline revision in cordis.patch.yml
(read-only), and printed as a ready-to-paste YAML revision block with
from: '<today in ${OFFICIAL_TZ}>'.

Options:
  --json    Print a machine-readable JSON report instead of text.
  --help    Show this help.

Exit code: 1 when any fetch or parse fails, 0 otherwise.
`

/* ------------------------------------------------------------------ */
/* 1. Baseline: read the plugin's current CNY/USD tables (read-only).   */
/* ------------------------------------------------------------------ */

const BLOCK_KEY_LINE = /^([A-Za-z][\w.-]*):\s*$/
const VALUE_LINE = /^(hit|miss|output):\s*([0-9]+(?:\.[0-9]+)?)\s*$/
const LIST_FROM_LINE = /^-\s*from:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/
const LIST_VALUE_LINE = /^-\s*(hit|miss|output):\s*([0-9]+(?:\.[0-9]+)?)\s*$/

function stripInlineComment(content) {
  return content.replace(/\s+#.*$/, '').trim()
}

/**
 * Read the `config.prices` section of `cordis.patch.yml` with a strict,
 * indentation-aware line scanner (no YAML dependency). Accepts the shipped
 * dated-revision list form and the older flat `{hit, miss, output}` row form;
 * anything else reports a clear error instead of comparing a half-read table.
 */
function readBaseline(configUrl) {
  let text
  try {
    text = readFileSync(configUrl, 'utf8')
  } catch (error) {
    return { ok: false, path: CONFIG_PATH, error: `cannot read ${CONFIG_PATH}: ${error.message}` }
  }

  const peakMultiplierMatch = /^\s*peakMultiplier:\s*([0-9]+(?:\.[0-9]+)?)\s*$/m.exec(text)
  const peakMultiplier = peakMultiplierMatch === null ? null : Number(peakMultiplierMatch[1])

  const revisions = {}
  let pricesIndent = -1
  let inPrices = false
  let currency = null
  let currencyIndent = -1
  let model = null
  let modelIndent = -1
  let currentRevision = null

  const fail = error => ({ ok: false, path: CONFIG_PATH, error })

  const lines = text.split(/\r?\n/)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawContent = lines[lineIndex].trim()
    if (rawContent === '' || rawContent.startsWith('#')) continue
    const content = stripInlineComment(rawContent)
    if (content === '') continue
    const indent = lines[lineIndex].length - lines[lineIndex].trimStart().length

    if (!inPrices) {
      if (/^prices:\s*$/.test(content)) {
        pricesIndent = indent
        inPrices = true
      }
      continue
    }
    if (indent <= pricesIndent) {
      // Sibling section (e.g. `tariffs:`) — the prices block is over.
      inPrices = false
      continue
    }

    if (indent === pricesIndent + 2 && BLOCK_KEY_LINE.test(content)) {
      currency = BLOCK_KEY_LINE.exec(content)[1]
      currencyIndent = indent
      model = null
      revisions[currency] ??= {}
      continue
    }
    if (currency !== null && indent === currencyIndent + 2 && BLOCK_KEY_LINE.test(content)) {
      model = BLOCK_KEY_LINE.exec(content)[1]
      modelIndent = indent
      currentRevision = null
      revisions[currency][model] ??= []
      continue
    }
    if (model === null) {
      return fail(`unexpected structure in config.prices at line ${lineIndex + 1}: ${content}`)
    }

    const fromMatch = LIST_FROM_LINE.exec(content)
    if (fromMatch !== null && indent === modelIndent + 2) {
      currentRevision = { from: fromMatch[1] }
      revisions[currency][model].push(currentRevision)
      continue
    }
    const listValueMatch = LIST_VALUE_LINE.exec(content)
    if (listValueMatch !== null && indent === modelIndent + 2) {
      currentRevision ??= { from: null }
      if (revisions[currency][model].length === 0) revisions[currency][model].push(currentRevision)
      currentRevision[listValueMatch[1]] = Number(listValueMatch[2])
      continue
    }
    const valueMatch = VALUE_LINE.exec(content)
    if (valueMatch !== null && indent === modelIndent + 4 && currentRevision !== null) {
      currentRevision[valueMatch[1]] = Number(valueMatch[2])
      continue
    }
    if (valueMatch !== null && indent === modelIndent + 2) {
      // Flat one-row form: `deepseek-flash: { hit, miss, output }`.
      if (currentRevision === null) {
        currentRevision = { from: null }
        revisions[currency][model].push(currentRevision)
      }
      currentRevision[valueMatch[1]] = Number(valueMatch[2])
      continue
    }
    return fail(`unexpected structure in config.prices at line ${lineIndex + 1}: ${content}`)
  }

  if (!inPrices && pricesIndent === -1) return fail('config.prices not found in cordis.patch.yml')
  for (const expected of CURRENCIES) {
    const table = revisions[expected]
    if (!isRecord(table) || Object.keys(table).length === 0) {
      return fail(`config.prices.${expected} is missing from cordis.patch.yml`)
    }
    for (const [modelId, history] of Object.entries(table)) {
      if (!Array.isArray(history) || history.length === 0) {
        return fail(`config.prices.${expected}.${modelId} has no price revision`)
      }
      for (const revision of history) {
        for (const field of FIELDS) {
          if (!Number.isFinite(revision[field])) {
            return fail(`config.prices.${expected}.${modelId}: a revision is missing ${field}`)
          }
        }
      }
    }
  }

  /** Newest dated revision wins; undated revisions are the oldest. */
  const effectivePrices = {}
  const asOf = {}
  for (const currencyId of CURRENCIES) {
    effectivePrices[currencyId] = {}
    let latest = null
    for (const [modelId, history] of Object.entries(revisions[currencyId])) {
      let current = history[0]
      for (const revision of history) {
        const currentKey = current.from ?? ''
        const revisionKey = revision.from ?? ''
        if (revisionKey >= currentKey) current = revision
        if (revision.from !== null && (latest === null || revision.from > latest)) latest = revision.from
      }
      effectivePrices[currencyId][modelId] = {
        hit: current.hit,
        miss: current.miss,
        output: current.output,
      }
    }
    asOf[currencyId] = latest
  }

  return { ok: true, path: CONFIG_PATH, peakMultiplier, pricesIndent, revisions, prices: effectivePrices, asOf }
}

/* ------------------------------------------------------------------ */
/* 2. Date + comparison helpers.                                       */
/* ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Today's calendar date in Beijing (the plugin's tariff time zone). */
function officialDate(instant = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: OFFICIAL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const part = type => parts.find(entry => entry.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** Field-level differences between a baseline table and a parsed table. */
function diffTables(baselineTable, parsedTable) {
  const differences = []
  const models = new Set([...Object.keys(baselineTable ?? {}), ...Object.keys(parsedTable ?? {})])
  for (const model of [...models].sort()) {
    const baselineRow = baselineTable?.[model]
    const parsedRow = parsedTable?.[model]
    if (!isRecord(parsedRow)) {
      differences.push({ model, field: null, baseline: null, fetched: null, message: `${model}: missing from the fetched table` })
      continue
    }
    if (!isRecord(baselineRow)) {
      differences.push({ model, field: null, baseline: null, fetched: null, message: `${model}: not in the baseline` })
      continue
    }
    for (const field of FIELDS) {
      const baselineValue = baselineRow[field]
      const parsedValue = parsedRow[field]
      if (!Number.isFinite(baselineValue) || !Number.isFinite(parsedValue)
        || Math.abs(baselineValue - parsedValue) > EPSILON) {
        differences.push({
          model,
          field,
          baseline: Number.isFinite(baselineValue) ? baselineValue : null,
          fetched: Number.isFinite(parsedValue) ? parsedValue : null,
          message: `${model}.${field}: baseline ${baselineValue} → fetched ${parsedValue}`,
        })
      }
    }
  }
  return differences
}

function tablesEqualRows(leftRow, rightRow) {
  if (!isRecord(leftRow) || !isRecord(rightRow)) return false
  return FIELDS.every(field => Number.isFinite(leftRow[field]) && Number.isFinite(rightRow[field])
    && Math.abs(leftRow[field] - rightRow[field]) <= EPSILON)
}

/**
 * Build the paste-ready revision YAML: one dated revision per model whose
 * effective official price changed (every model when the baseline was not
 * readable). Indentation matches the shipped `config.prices` block.
 */
function revisionYaml(parsedByCurrency, baseline, date) {
  const pricesIndent = baseline.ok && Number.isInteger(baseline.pricesIndent)
    ? baseline.pricesIndent
    : DEFAULT_PRICES_INDENT
  const indent = levels => ' '.repeat(pricesIndent + levels * 2)
  const lines = []
  let included = 0
  for (const currency of CURRENCIES) {
    const parsedTable = parsedByCurrency[currency]?.table
    if (!isRecord(parsedTable)) continue
    const baselineTable = baseline.ok ? baseline.prices[currency] : null
    const models = Object.keys(parsedTable).filter(model => baselineTable === null
      || !tablesEqualRows(baselineTable[model], parsedTable[model]))
    if (models.length === 0) continue
    lines.push(`${indent(1)}${currency}:`)
    for (const model of models) {
      const row = parsedTable[model]
      lines.push(`${indent(2)}${model}:`)
      lines.push(`${indent(3)}- from: '${date}'`)
      for (const field of FIELDS) lines.push(`${indent(4)}${field}: ${String(row[field])}`)
      included += 1
    }
  }
  return included === 0 ? null : lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 3. Report rendering.                                                */
/* ------------------------------------------------------------------ */

function formatTable(table, tableIndent = '  ') {
  const models = Object.keys(table)
  const width = Math.max(11, ...models.map(model => model.length))
  const lines = [`${tableIndent}${'model'.padEnd(width)}  ${'hit'.padEnd(10)}  ${'miss'.padEnd(10)}  output`]
  for (const model of models) {
    const row = table[model]
    lines.push(`${tableIndent}${model.padEnd(width)}  ${String(row.hit).padEnd(10)}  ${String(row.miss).padEnd(10)}  ${String(row.output)}`)
  }
  return lines.join('\n')
}

function renderHuman(report) {
  const lines = []
  lines.push(`DeepSeek official price refresh — ${report.date} (${report.timeZone})`)
  lines.push(`baseline: ${report.baseline.path} (read-only)`)
  if (!report.baseline.ok) lines.push(`baseline warning: ${report.baseline.error}`)
  lines.push('')

  for (const currency of CURRENCIES) {
    const result = report.results[currency]
    lines.push(`${currency}  ${result.url ?? PRICING_URLS[currency]}`)
    if (result.ok !== true) {
      lines.push(`  FETCH/PARSE FAILED (${result.fetchedAt}): ${result.error}`)
      lines.push('')
      continue
    }
    lines.push(`  fetched ${result.fetchedAt} · peak multiplier ×${report.peakMultiplier.official[currency]}`)
    lines.push(formatTable(result.table))
    const comparison = report.comparisons[currency]
    if (!comparison.available) {
      lines.push('  baseline: unavailable')
    } else if (comparison.match) {
      const asOf = comparison.asOf === null ? 'undated' : `revision ${comparison.asOf}`
      lines.push(`  baseline: MATCH (current ${asOf})`)
    } else {
      lines.push(`  baseline: DIFFERS (current ${comparison.asOf === null ? 'undated' : `revision ${comparison.asOf}`})`)
      for (const difference of comparison.differences) lines.push(`    - ${difference.message}`)
    }
    lines.push('')
  }

  if (report.peakMultiplier.mismatch) {
    const official = [...new Set(report.peakMultiplier.officialValues.map(String))].join(' / ')
    lines.push(`WARNING: official peak multiplier is ×${official} but config.tariffs.peakMultiplier is ×${report.peakMultiplier.config}.`)
    lines.push('         A price revision cannot express a multiplier change; update config.tariffs.peakMultiplier manually.')
    lines.push('')
  } else if (report.peakMultiplier.config !== null && report.peakMultiplier.officialValues.length > 0) {
    lines.push(`peak multiplier: official ×${report.peakMultiplier.officialValues[0]} · config ×${report.peakMultiplier.config} (match)`)
    lines.push('')
  }

  if (report.ok !== true) {
    lines.push('RESULT: FAILED — at least one official page could not be fetched/parsed (see above).')
    lines.push('        The plugin keeps its current prices and the UI shows "manual check may be needed".')
    return lines.join('\n')
  }
  if (!report.baseline.ok) {
    lines.push('RESULT: OK — both pages parsed, but the baseline could not be read for comparison.')
    lines.push('The block below is the full current table; add it as a dated revision under config.prices.')
    lines.push('')
    lines.push(report.revisionYaml ?? '(no table to emit)')
    return lines.join('\n')
  }
  if (report.changedModelCount === 0) {
    lines.push('RESULT: OK — parsed prices equal the current baseline revision; no revision needed.')
    return lines.join('\n')
  }

  lines.push(`RESULT: OK — ${report.changedModelCount} model price(s) differ from the current baseline revision.`)
  lines.push('Append the block below under `config.prices` in cordis.patch.yml (one dated')
  lines.push(`revision per changed model; keep the existing revision history). \`from\` is today in ${OFFICIAL_TZ}.`)
  lines.push('')
  lines.push(report.revisionYaml ?? '(no table to emit)')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 4. Main.                                                            */
/* ------------------------------------------------------------------ */

async function main(argv) {
  const flags = new Set(argv.filter(argument => argument.startsWith('-')))
  const unknown = [...flags].filter(flag => !['--json', '--help', '-h'].includes(flag))
  if (unknown.length > 0) {
    process.stderr.write(`unknown option(s): ${unknown.join(', ')}\n\n${HELP}`)
    process.exitCode = 2
    return
  }
  if (flags.has('--help') || flags.has('-h')) {
    process.stdout.write(HELP)
    return
  }

  const baseline = readBaseline(CONFIG_URL)
  const results = {}
  for (const currency of CURRENCIES) {
    results[currency] = await fetchOfficialPrices({ currency })
  }

  const date = officialDate()
  const comparisons = {}
  for (const currency of CURRENCIES) {
    const result = results[currency]
    const baselineTable = baseline.ok ? baseline.prices[currency] : null
    if (result.ok !== true || baselineTable === null) {
      comparisons[currency] = { available: false, match: null, differences: [], asOf: null }
      continue
    }
    const differences = diffTables(baselineTable, result.table)
    comparisons[currency] = {
      available: true,
      match: differences.length === 0,
      differences,
      asOf: baseline.asOf[currency] ?? null,
    }
  }
  const changedModels = new Set()
  for (const comparison of Object.values(comparisons)) {
    for (const difference of comparison.differences) changedModels.add(difference.model)
  }

  const officialMultiplier = {}
  for (const currency of CURRENCIES) {
    officialMultiplier[currency] = results[currency].ok === true ? results[currency].peakMultiplier : null
  }
  const officialValues = CURRENCIES.map(currency => officialMultiplier[currency]).filter(Number.isFinite)
  const multiplierConsistent = officialValues.length > 0
    && officialValues.every(value => Math.abs(value - officialValues[0]) <= EPSILON)
  const configMultiplier = baseline.ok ? baseline.peakMultiplier : null
  const multiplierMismatch = configMultiplier !== null && officialValues.length > 0
    && officialValues.some(value => Math.abs(value - configMultiplier) > EPSILON)

  const parsedByCurrency = Object.fromEntries(CURRENCIES.map(currency => (
    [currency, results[currency].ok === true ? results[currency] : null]
  )))

  const report = {
    generatedAt: new Date().toISOString(),
    date,
    timeZone: OFFICIAL_TZ,
    ok: CURRENCIES.every(currency => results[currency].ok === true),
    baseline,
    results,
    comparisons,
    peakMultiplier: {
      config: configMultiplier,
      official: officialMultiplier,
      officialValues,
      consistent: multiplierConsistent,
      mismatch: multiplierMismatch,
    },
    changedModelCount: changedModels.size,
    revisionYaml: revisionYaml(parsedByCurrency, baseline, date),
  }

  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderHuman(report)}\n`)
  }
  if (report.ok !== true) process.exitCode = 1
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`price refresh failed unexpectedly: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
