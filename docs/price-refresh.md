# Official price refresh (`prices.js`)

`prices.js` is the only code in this bundle that reads DeepSeek's official
"Models & Pricing" pages. The host half calls it from the bounded auto check;
nothing else should parse pricing HTML. The module is plain ESM with **zero npm
dependencies** and uses Node 20+ globals only (`fetch`, `AbortController`).

## How the auto check uses it

`index.js` (`resolveConfig` → `startAutoCheck`):

1. At most once per `config.autoCheck.intervalDays` (7 by default, with a
   6-hour wake-up and a 1-hour retry floor) the host calls

   ```js
   fetchOfficialPrices({
     currency: config.currency,          // 'CNY' by default
     url: config.pricingUrls[currency],  // else PRICING_URLS[currency]
     timeoutMs: 20_000,
   })
   ```

2. On `{ ok: true }` the host compares `result.table` (off-peak prices, per 1M
   tokens, in the display currency) with the **effective** price revision for
   today. Only when a value differs does it append an auto revision dated today
   (Asia/Shanghai) to the persisted price history and re-register the session
   projection, so old Sessions keep their old rates.
3. On `{ ok: false }` nothing is written to the price data. The error string is
   stored in the persisted check state (`priceCheckError`) and the Client
   renders the check status as "manual check may be needed".

`peakMultiplier` is returned as evidence (e.g. `2`), but the host currently
charges peak hours with `config.tariffs.peakMultiplier`. A change *only* in the
official peak multiplier therefore is not auto-applied — see
[Known limits](#known-limits).

## API

```js
export const PRICING_URLS = {
  CNY: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  USD: 'https://api-docs.deepseek.com/quick_start/pricing/',
}

parsePricingHtml(html, currency)
// { ok: true, table: { 'deepseek-flash': { hit, miss, output }, 'deepseek-v4-pro': {...} }, peakMultiplier: 2 }
// { ok: false, error: 'human readable reason' }
// table values are OFF-PEAK prices per 1M tokens in `currency`. Never throws.

fetchOfficialPrices({ currency, url, timeoutMs = 20000, fetchImpl })
// { ok: true, currency, table, peakMultiplier, url, fetchedAt }
// { ok: false, currency, url, error, fetchedAt }
// AbortController timeout; non-2xx is a failure; network/parse errors are caught. Never throws.

tablesEqual(left, right, epsilon = 1e-9)
// Symmetric model-key + hit/miss/output comparison; true only for the same
// model set with every value within epsilon. Non-numeric/absent values → false.
```

## Current official values (snapshot 2026-10-28, per 1M tokens)

| model | currency | hit off-peak/peak | miss off-peak/peak | output off-peak/peak |
|---|---|---|---|---|
| `deepseek-flash` | CNY | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | CNY | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |
| `deepseek-flash` | USD | 0.003 / 0.006 | 0.15 / 0.30 | 0.60 / 1.20 |
| `deepseek-v4-pro` | USD | 0.022 / 0.044 | 0.66 / 1.32 | 1.98 / 3.96 |

The parser only returns the off-peak numbers; the peak numbers above are the
page's second value of each pair, used to prove `peakMultiplier = 2` (the
multiplier is computed from all 12 peak/off-peak ratios, never assumed).

## Golden fixtures

`test/prices.test.mjs` runs fully offline against the real pages committed as
fixtures:

| fixture | source | fetched (UTC) | bytes | sha256 |
|---|---|---|---|---|
| `test/fixtures/pricing-cny.html` | `PRICING_URLS.CNY` | 2026-10-27T17:59Z | 26182 | `556097caba8adfeeed6455714bffd731c7f60db520fcee06a922eba5840663a3` |
| `test/fixtures/pricing-usd.html` | `PRICING_URLS.USD` | 2026-10-27T17:59Z | 26043 | `b856a6e93fa4793ecc8f3fd03a01bb7d8f7572f78a4739da8ce6dbdb09328d66` |

Run the suite with either:

```bash
node --test test/prices.test.mjs
node test/prices.test.mjs
```

### Refreshing the fixtures

Fixtures are a parser golden snapshot, not a live price feed — the 7-day check
fetches the live pages itself. Refresh them when the page structure changes
(that is the moment the parser must be adapted and re-proven), or when you want
the snapshot to be recent:

```bash
cd /path/to/.dsh-plugins/session-cost
node --input-type=module - <<'NODE'
import { writeFileSync } from 'node:fs'
import { PRICING_URLS } from './prices.js'
const targets = [
  ['pricing-cny.html', PRICING_URLS.CNY],
  ['pricing-usd.html', PRICING_URLS.USD],
]
for (const [name, url] of targets) {
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-session-cost fixture refresh' } })
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`)
  const html = await response.text()
  writeFileSync(new URL(`./test/fixtures/${name}`, import.meta.url), html)
  console.log(name, response.status, html.length)
}
NODE
node --test test/prices.test.mjs
```

If a refreshed fixture changes the parsed values, update `EXPECTED` in
`test/prices.test.mjs`, the table above and this document's provenance table.
If it fails to parse, adapt the parser — never relax the fail-closed checks
just to make a fixture pass.

## Parser assumptions (page structure contract)

The parser treats the page as follows; each assumption has a matching
fail-closed rule, so a breaking page change produces `ok: false` rather than a
silently wrong price table.

1. **One model table per page.** Both pages also contain an unrelated "Search"
   price table; only a table whose header row names both expected model ids is
   used. If a second table also names them and disagrees, parsing fails as
   ambiguous.
2. **Models are header cells, not hardcoded columns.** The header row looks
   like `<td colspan="3">模型</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro</td>`;
   footnote markers `(N)` are stripped. The result must contain exactly
   `deepseek-flash` and `deepseek-v4-pro` — a renamed, added or removed model
   column fails (the DSH catalog changed, so a human must update the plugin).
3. **`rowspan` layout.** The pricing group uses `rowspan="6"` for the
   `价格` / `PRICING` label and `rowspan="2"` for each billing dimension label,
   with an `空闲时段` / `高峰时段` (`OFF-PEAK` / `PEAK`) window cell per row. The
   parser expands `rowspan`/`colspan` into a grid first, so a peak row without
   its own dimension label still maps to `hit` / `miss` / `output`.
4. **Billing dimensions** are recognised by label text:
   `缓存命中`/`CACHE HIT`, `缓存未命中`/`CACHE MISS`, `输出`/`OUTPUT`. Every
   model needs all six cells (3 dimensions × off-peak/peak); duplicates,
   missing rows and a window-labelled row without an unambiguous dimension
   label fail.
5. **Price cells carry their currency marker** (`0.02元`, `$0.003`). A bare
   number fails (usually a truncated page), and the marker must match the
   requested currency — this is also what catches a locale redirect serving the
   wrong-language page.
6. **Values are plausible per-1M-token prices:** finite, `> 0` and `< 10000`.
7. **Price cells are the non-empty cells to the right of the window label**,
   mapped left-to-right onto the model columns in header order. Do not assume
   fixed grid indices — a test with swapped model columns proves this.
8. **Peak ratio is evidence:** for every dimension and model,
   `peak / off-peak` must agree within `1e-9`; the agreeing value is returned
   as `peakMultiplier`. The current pages prove exactly `2`.

## Fail-closed rules (any → `ok: false`)

- unsupported currency argument (only `CNY`, `USD` exist);
- empty/non-string HTML, no closed `<table>` block;
- no table whose header names both expected models, or a model-column set that
  is not exactly the two expected ids;
- a window-labelled row with no, or multiple, billing dimension labels;
- a missing/duplicate `hit` / `miss` / `output` row for either tariff window;
- a price cell that is not a positive number with the right currency marker, or
  is implausibly large;
- inconsistent peak/off-peak ratios;
- two model tables that disagree (ambiguous page);
- any unexpected parser exception (caught; reported as `ok: false`).

## What a parse failure looks like

Real messages produced by the tests/fixture mutations (they end up in the
host's persisted `priceCheckError`, are shown by the Client as "manual check may
be needed", and are printed verbatim by the refresh script):

```
pricing table with model columns [deepseek-flash, deepseek-v4-pro] not found in page html
model columns mismatch: expected [deepseek-flash, deepseek-v4-pro], found [deepseek-flash, deepseek-v4-max]
pricing row with window label "高峰时段" has no cache-hit/cache-miss/output label: ...
pricing row hit/offpeak has 1 price cell(s); expected 2 (deepseek-flash, deepseek-v4-pro)
price cell "一元" is not a number with a currency marker (row miss/offpeak, model deepseek-flash)
currency mismatch: expected USD but price cell "0.003元" is CNY (row hit/offpeak, model deepseek-flash)
inconsistent peak/off-peak ratio across prices: deepseek-flash/hit=2 vs deepseek-flash/hit=2.5
missing peak hit price for deepseek-flash
```

`fetchOfficialPrices` additionally reports `official pricing page returned HTTP
500`, `pricing page fetch failed: <reason>` and `pricing page fetch timed out
after 20000 ms`.

## Manual refresh / diagnostic CLI

`scripts/refresh-prices.mjs` fetches both locales live, parses them with this
module, compares against the plugin's current baseline read (read-only) from
`cordis.patch.yml`, and prints a ready-to-paste revision block. It never writes
a config or profile state.

```bash
node scripts/refresh-prices.mjs          # human report
node scripts/refresh-prices.mjs --json   # machine-readable report
node scripts/refresh-prices.mjs --help
```

- Exit code `1` when either page failed to fetch/parse (same failure the plugin
  would report); `0` otherwise. Baseline-format problems only warn.
- The baseline reader accepts the shipped dated revision lists
  (`- from: 'YYYY-MM-DD'` + `hit`/`miss`/`output`) and the older flat row form;
  the effective baseline is the newest dated revision per model.
- The printed block is one dated revision (`from: '<today, Asia/Shanghai>'`)
  per model whose **effective** price changed. Append it under the matching
  model in `config.prices` and keep the existing revisions (they are history,
  not replaceable state). A repeat run on the same day is idempotent.
- A peak-multiplier change is reported as a warning: it cannot be expressed by
  a price revision, so `config.tariffs.peakMultiplier` must be updated by hand.
- The comparison baseline is `cordis.patch.yml` only. Revisions the auto check
  already appended live in the plugin-data state file
  (`$DSH_HOME/plugin-data/session-cost/price-state.json`), not in the config;
  if the plugin has auto-updated, inspect that file before pasting a manual
  revision so the same change is not recorded twice.

## Known limits

- **Multiplier-only changes are not auto-applied.** Auto revisions only record
  the parsed off-peak table; `index.js` prices peak hours with
  `config.tariffs.peakMultiplier`. If the official ratio ever changes from 2,
  the script's warning is the detection path, and both the multiplier and (for
  completeness) a revision should be applied manually.
- **Peak-only price changes are invisible to the comparison.** The comparison
  is against off-peak numbers by design (they are the stored baseline); a page
  where only peak values change would still alter the ratio and therefore fail
  the consistency check only if the multiplier changed. The script prints the
  official multiplier so it can be verified.
- **New billing categories without a window label** (e.g. fixed per-request
  prices) are ignored: this plugin only prices token usage. A new *token*
  category with a window label fails closed and needs a plugin change.
- **Network failures are a check failure**, not a price change: the host keeps
  the last known prices and retries no sooner than the retry floor.
