import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'


const host = await import('../index.js')
const prices = await import('../prices.js')
if (typeof prices.fetchOfficialPrices !== 'function') throw new Error('prices.js missing')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const dir = mkdtempSync(join(tmpdir(), 'scp-host-'))
const statePath = join(dir, 'state.json')

function harness(stateFile) {
  const registrations = []
  const ctx = {
    sessionProjections: {
      register(definition) {
        registrations.push(definition)
        return () => {}
      },
    },
    effect(callback) {
      const disposer = callback()
      return disposer
    },
  }
  return { ctx, registrations }
}
const OFFPEAK = Date.parse('2026-10-25T18:00:00.000Z') // Monday 02:00 Beijing
const PEAK = Date.parse('2026-10-26T02:00:00.000Z') // Monday 10:00 Beijing
const ev = (seq, type, data, time) => ({ seq, type, data, time })
const sampleEvents = (turn, step, time, usage) => [
  ev(seqCounter++, 'request/header', { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } }, reason: 'initial' }),
  ev(seqCounter++, 'step/start', { turn, step }, time),
  ev(seqCounter++, 'assistant/message', {
    turn, step,
    message: { source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } },
    stream: [], usage,
  }, time + 3000),
]
let seqCounter = 1

const BASE_CONFIG = {
  currency: 'CNY',
  pricesAsOf: '2026-10-28',
  prices: {
    CNY: {
      'deepseek-flash': [
        { from: '2026-10-01', hit: 0.02, miss: 1, output: 4 },
        { from: '2026-10-20', hit: 0.01, miss: 0.5, output: 2 },
      ],
    },
  },
  autoCheck: { enabled: false },
  statePath,
}

// 1. Price revision selected by sample time (off-peak, no peak multiplier).
{
  const { ctx, registrations } = harness()
  host.apply(ctx, BASE_CONFIG)
  const def = registrations[0]
  let state = def.init({}, 0)
  for (const e of sampleEvents(1, 1, Date.parse('2026-10-10T18:00:00.000Z'), { inputTokens: 1_000_000, outputTokens: 0 })) state = def.apply(state, e)
  const oldView = def.wire.view(state)
  let state2 = def.init({}, 0)
  for (const e of sampleEvents(2, 1, Date.parse('2026-10-24T18:00:00.000Z'), { inputTokens: 1_000_000, outputTokens: 0 })) state2 = def.apply(state2, e)
  const newView = def.wire.view(state2)
  console.log('1. history selection old=¥' + (oldView.costNano / 1e9) + ' (expect 1) new=¥' + (newView.costNano / 1e9) + ' (expect 0.5)',
    oldView.costNano === 1_000_000_000 && newView.costNano === 500_000_000)
}

// 2. Peak multiplier still applies on top of the revision.
{
  const { ctx, registrations } = harness()
  host.apply(ctx, BASE_CONFIG)
  const def = registrations[0]
  let state = def.init({}, 0)
  for (const e of sampleEvents(1, 1, PEAK, { inputTokens: 1_000_000, outputTokens: 0 })) state = def.apply(state, e)
  // Baseline revision effective on 10-26: miss 0.5 => ¥0.5; peak doubles it.
  console.log('2. peak x2:', def.wire.view(state).costNano === 1_000_000_000, 'got', def.wire.view(state).costNano)
}

// 3. Legacy flat (undated) config still reads as one always-effective revision.
{
  const { ctx, registrations } = harness()
  host.apply(ctx, {
    ...BASE_CONFIG,
    statePath: join(dir, 'unused.json'),
    prices: { CNY: { 'deepseek-flash': { hit: 0.02, miss: 2, output: 4 } } },
  })
  const def = registrations[0]
  let state = def.init({}, 0)
  for (const e of sampleEvents(1, 1, OFFPEAK, { inputTokens: 100, outputTokens: 0 })) state = def.apply(state, e)
  console.log('3. legacy flat config:', def.wire.view(state).costNano === 200_000)
}

// 4. Persisted auto revision overrides the baseline from its date on.
{
  writeFileSync(statePath, JSON.stringify({
    version: 1, lastCheckAt: 1, lastCheckOk: true, lastSuccessAt: 1, lastError: null,
    revisions: { CNY: { 'deepseek-flash': [{ from: '2026-10-22', hit: 0.04, miss: 2, output: 8, auto: true }] } },
  }))
  const { ctx, registrations } = harness()
  host.apply(ctx, { ...BASE_CONFIG, autoCheck: { enabled: false } })
  const def = registrations[0]
  let before = def.init({}, 0)
  for (const e of sampleEvents(1, 1, Date.parse('2026-10-20T18:00:00.000Z'), { inputTokens: 1_000_000, outputTokens: 0 })) before = def.apply(before, e)
  let after = def.init({}, 0)
  for (const e of sampleEvents(2, 1, Date.parse('2026-10-23T18:00:00.000Z'), { inputTokens: 1_000_000, outputTokens: 0 })) after = def.apply(after, e)
  const view = def.wire.view(after)
  console.log('4. overlay revision: before=¥' + (def.wire.view(before).costNano / 1e9) + ' (0.5) after=¥' + (view.costNano / 1e9) + ' (2) revisionAt=' + view.priceRevisionAt,
    def.wire.view(before).costNano === 500_000_000 && view.costNano === 2_000_000_000 && view.priceRevisionAt === '2026-10-22')
  rmSync(statePath, { force: true })
}

// 9. Same-day duplicate auto revisions: the merge keeps the last one.
{
  rmSync(statePath, { force: true })
  const today = (() => { const d = new Date(Date.now() + 8 * 3600_000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` })()
  writeFileSync(statePath, JSON.stringify({ version: 1, lastCheckAt: 1, lastCheckOk: true, lastSuccessAt: 1, lastError: null,
    revisions: { CNY: { 'deepseek-flash': [{ from: today, hit: 0.02, miss: 7, output: 4, auto: true }, { from: today, hit: 0.02, miss: 9, output: 4, auto: true }] } } }))
  const { ctx, registrations } = harness()
  host.apply(ctx, { ...BASE_CONFIG, autoCheck: { enabled: false } })
  const def = registrations[0]
  let state = def.init({}, 0)
  for (const e of sampleEvents(1, 1, Date.now(), { inputTokens: 1_000_000, outputTokens: 0 })) state = def.apply(state, e)
  console.log('9. same-day duplicate merge keeps last:', def.wire.view(state).costNano === 9_000_000_000, 'got', def.wire.view(state).costNano / 1e9)
}

// 10. Malformed event safety and same-step replacement.
{
  const { ctx, registrations } = harness()
  host.apply(ctx, { ...BASE_CONFIG, statePath: join(dir, 'unused2.json'), autoCheck: { enabled: false } })
  const def = registrations[0]
  let state = def.init({}, 0)
  state = def.apply(state, ev(1, 'assistant/message', null, 1))
  const stateBefore = state
  state = def.apply(state, ev(2, 'tool/call', { turn: 1, step: 1 }, 2))
  console.log('10. malformed safe + unchanged ref:', state === stateBefore, state === stateBefore)
}

rmSync(dir, { recursive: true, force: true })

// 11. Auto-check end-to-end against a local HTTP server serving the real
//     official-page fixture (offline; exercises fetch + parser + append +
//     projection re-registration + the interval gate and failure path).
{
  const { createServer } = await import('node:http')
  const fixture = readFileSync(new URL('./fixtures/pricing-cny.html', import.meta.url))
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(fixture)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/pricing`
  const localConfig = {
    currency: 'CNY',
    pricesAsOf: '2026-10-28',
    prices: { CNY: { 'deepseek-flash': [{ from: '2026-10-28', hit: 0.02, miss: 1, output: 4 }], 'deepseek-v4-pro': [{ from: '2026-10-28', hit: 0.15, miss: 4.5, output: 13.5 }] } },
    pricingUrls: { CNY: url },
    autoCheck: { enabled: true, intervalDays: 7 },
    statePath,
  }
  const today = (() => { const d = new Date(Date.now() + 8 * 3600_000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` })()
  const fetchCount = () => requests
  try {
    // 11a. Matching baseline: success, no revision, no re-registration.
    rmSync(statePath, { force: true })
    requests = 0
    {
      const { ctx, registrations } = harness(statePath)
      host.apply(ctx, localConfig)
      await new Promise(resolve => setTimeout(resolve, 2600))
      const persisted = JSON.parse(readFileSync(statePath, 'utf8'))
      const view = registrations.at(-1).wire.view(registrations.at(-1).init({}, 0))
      console.log('11a. local auto-check match:', persisted.lastCheckOk === true && JSON.stringify(persisted.revisions) === '{}' && registrations.length === 1 && view.checkStatus === 1 && fetchCount() === 1)
    }
    // 11b. Changed baseline: the validated fixture appends today's revision.
    rmSync(statePath, { force: true })
    requests = 0
    {
      const wrong = { ...localConfig, prices: { CNY: { 'deepseek-flash': [{ from: '2026-10-28', hit: 0.02, miss: 9, output: 4 }] } } }
      const { ctx, registrations } = harness(statePath)
      host.apply(ctx, wrong)
      await new Promise(resolve => setTimeout(resolve, 2600))
      const persisted = JSON.parse(readFileSync(statePath, 'utf8'))
      const revision = persisted.revisions?.CNY?.['deepseek-flash']?.at(-1)
      const def = registrations.at(-1)
      let state = def.init({}, 0)
      const now = Date.now()
      for (const event of [
        { seq: 1, type: 'request/header', data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } }, reason: 'initial' }, time: now },
        { seq: 2, type: 'step/start', data: { turn: 1, step: 1 }, time: now },
        { seq: 3, type: 'assistant/message', data: { turn: 1, step: 1, message: { source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } }, stream: [], usage: { inputTokens: 1_000_000, outputTokens: 0 } }, time: now + 1 },
      ]) state = def.apply(state, event)
      const view = def.wire.view(state)
      console.log('11b. local auto revision:', 'from=' + revision?.from + ' miss=' + revision?.miss + ' auto=' + revision?.auto, '| re-registered:', registrations.length === 2, '| cost=¥' + view.costNano / 1e9,
        revision?.from === today && revision?.miss === 1 && revision?.auto === true && registrations.length === 2 && view.costNano === 1_000_000_000)
    }
    // 11c. Recent lastCheckAt: the interval gate skips the fetch entirely.
    rmSync(statePath, { force: true })
    writeFileSync(statePath, JSON.stringify({ version: 1, lastCheckAt: Date.now(), lastCheckOk: true, lastSuccessAt: Date.now(), lastError: null, revisions: {} }))
    requests = 0
    {
      const { ctx } = harness(statePath)
      host.apply(ctx, localConfig)
      await new Promise(resolve => setTimeout(resolve, 2600))
      console.log('11c. interval gate skips fetch:', fetchCount() === 0)
    }
    // 11d. Unreachable URL: failure recorded, no revision, checkStatus failed.
    rmSync(statePath, { force: true })
    {
      const failing = { ...localConfig, pricingUrls: { CNY: 'http://127.0.0.1:9/pricing' } }
      const { ctx, registrations } = harness(statePath)
      host.apply(ctx, failing)
      await new Promise(resolve => setTimeout(resolve, 2600))
      const persisted = JSON.parse(readFileSync(statePath, 'utf8'))
      const view = registrations.at(-1).wire.view(registrations.at(-1).init({}, 0))
      console.log('11d. failure recorded:', persisted.lastCheckOk === false && typeof persisted.lastError === 'string' && JSON.parse(readFileSync(statePath, 'utf8')).revisions !== undefined && view.checkStatus === 2)
    }
    // 11e. Disabled auto check never fetches.
    rmSync(statePath, { force: true })
    requests = 0
    {
      const { ctx } = harness(statePath)
      host.apply(ctx, { ...localConfig, autoCheck: { enabled: false } })
      await new Promise(resolve => setTimeout(resolve, 2600))
      console.log('11e. disabled never fetches:', fetchCount() === 0)
    }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}
