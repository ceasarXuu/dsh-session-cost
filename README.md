# dsh-session-cost

**Session API cost inside the DSH composer usage line.** It keeps the official token count and
cache-hit reading byte-identical to the shipped pill and inserts the money segment between them:

```
⟳ 3 turns 237 steps · 205 tok/s    🗄 122K tok · ¥0.003 · 缓存命中 98%    ◔ 47%
                                    ↑ shipped usage pill with the API cost inserted
```

![Schematic preview of the composer usage line](docs/preview.png)

The token dialog keeps its shipped rows and adds **消费金额** (cost), **价格表** (price-table
snapshot / newest applied revision) and **价目自动检查** (last official-page check). A failed check
marks the amount with `!` and shows a dismissible notice.

> This is a third-party plugin. It is not an official DeepSeek / DeepSeek Harness component.
> The amount is a **token cost** (official billed tokens × official published prices) — a lower
> bound of real spend, not an official invoice.

## Install

Requires **DSH 0.2.1-rc.2 or newer (below 0.3.0)** with the Web/Desktop surface, and Node ≥ 22.
Verified on DSH 0.2.1-rc.3; the DSH 0.2.1-rc.2 API surface was checked statically (projection wire
views, slot shadowing, locale registration, session-list projections).

- **Plugin Manager:** Plugins → Add → `@ceasarxuu/dsh-session-cost` → install and keep it enabled.
- **CLI:** `dsh plugin --profile <profile> add @ceasarxuu/dsh-session-cost`

A fresh install starts working immediately: it replaces the composer `usage` cell, and on first
load it performs the first official price check. Disable the bundle and the shipped pill returns
unchanged. `plugin_manager` `install_bundle` accepts the same package name/spec.

## What it shows

| Segment | Source |
|---|---|
| `<n> tok` | the official `tokenUsage` session projection (unchanged) |
| `¥0.003` / `$0.16` | this plugin: the same billed token buckets × official prices, per request |
| `缓存命中 98%` | the official cache-hit rule (unchanged, including the never-round-to-100% behavior) |

The money segment hides itself when no price is configured for the route (for example a
third-party provider); the dialog then says “未配置价格” instead of inventing a number.

## How the amount is computed

The host half registers a `sessionCost` session-projection unit that folds the exact events the
official `tokenUsage` unit folds (`assistant/message` / `assistant/attempt` usage samples,
`llm/retry-started` replacement semantics), so the amount always belongs to the tokens next to it.

- **Per sample, per route:** each sample is attributed to its model
  (`assistant/message.data.message.source`); a retried attempt inherits the latest
  `request/header` route.
- **Per sample, per tariff:** official DeepSeek prices are peak/off-peak. Peak is exactly 2× off-peak
  and applies Beijing Mon–Fri 09:00–12:00 and 14:00–18:00, excluding Chinese statutory holidays.
  Each sample uses the tariff of its own request-start time.
- **Per sample, per price revision:** the price table is dated history, so a session recorded before
  an official price change keeps the old rate.
- **Exact integer arithmetic** in nano-currency units:

  ```
  cost_nano = Σ samples ( uncachedInput×miss + cacheRead×hit + cacheWrite×miss + output×output ) × tariff
  cost      = cost_nano / 1e9
  ```

  `reasoningTokens` are already inside `outputTokens`; `totalTokens` is ignored (the buckets are
  disjoint).

The result is session-cumulative over the whole durable log, including fork-inherited prefixes.

## Price updates and the auto check

Official prices change over time. The plugin:

- ships the official off-peak snapshot of 2026-10-28 (CNY and USD tables), and
- fetches the official pricing page **at most once per 7 days** (`autoCheck.intervalDays`),
  parses it fail-closed (rowspan-aware table parsing, currency-marker validation, plausibility
  checks, evidence-based peak multiplier) and:
  - records the check timestamp when prices are unchanged;
  - appends a **new price revision dated today** for changed models when the validated page differs,
    then re-registers the projection so new requests use the new rate while old sessions keep the
    old one;
  - reports a failure (instead of silently changing anything) when the fetch or parse fails, or
    when the official peak multiplier no longer matches the configured tariff. The UI then shows the
    `!` marker, a “失败 / 建议手动核对” dialog row, and a dismissible frame-wide notice.

Peak windows and the Chinese holiday calendar cannot be derived from the pricing page — update
`tariffs.holidays` yearly. Manual helpers:

```sh
node scripts/refresh-prices.mjs   # read-only: fetch both pages, diff against the config, print a
                                  # paste-ready dated revision block; exit 1 on failure
```

The check state lives in `~/.dsh/plugin-data/session-cost/price-state.json` (override with
`config.statePath`). Delete it to make the next start check again.

## Configuration

Defaults are in the bundle's `cordis.patch.yml`; override them in your profile's
`cordis.patch.yml` (a patch for row id `session-cost` replaces the whole `config`, so restate every
key you need). HMR recomposes without restarting Desktop.

| Key | Default | Meaning |
|---|---|---|
| `currency` | `CNY` | Display currency; `CNY` and `USD` tables ship with the plugin. Prices are never FX-converted. |
| `prices` | official snapshot | Dated revisions per currency/model: `{ from, hit, miss, output }` per 1M tokens, off-peak. |
| `pricesAsOf` | `2026-10-28` | Snapshot label shown in the dialog. |
| `tariffs` | official schedule | `peakMultiplier`, `utcOffsetMinutes`, `peakWindows`, `weekdays`, `holidays`. |
| `autoCheck` | `{ enabled: true, intervalDays: 7 }` | Bounded official-page check; `intervalMs` overrides the interval. |
| `pricingUrls` | official docs | Page per currency. |
| `statePath` | `~/.dsh/plugin-data/session-cost/price-state.json` | Persisted check state / auto revisions. |

Routes resolve by `provider/model`, then `*/model`, then bare `model`.

## Privacy and network

- One HTTPS GET to `api-docs.deepseek.com` at most once per 7 days. No API keys, no session content
  and no prompts are sent.
- No telemetry.
- Local state is limited to the check timestamps, auto-detected price revisions and a
  localStorage dismissal key in the Web UI.
- All numbers are computed locally from your session log and the price table.

## Known limits

- **Lower bound, not an invoice:** auxiliary calls that the official `tokenUsage` fold does not
  log (compaction summaries, session-title calls, auxiliary web-search model calls, Search/Fetch
  fees) are excluded on purpose.
- **Price history starts at the shipped 2026-10-28 snapshot.** Earlier official prices were not
  published in a machine-readable history here, so nothing is fabricated; every change detected
  from now on is preserved as a dated revision.
- **Peak windows / holidays are manual** (yearly refresh). A peak-multiplier change is detected and
  reported for manual review.
- **Unpriced routes** (third-party providers without official prices) show the token reading and a
  `≈`/“未配置价格” marker.
- **DSH internal APIs:** this plugin relies on session projections, slot shadowing, locale
  registration and session-list projections. It is version-gated by `engines.dsh`; a DSH upgrade
  below 0.3.0 future-versions may still require an update.
- Historical sessions before a price change keep the old revision only after the plugin has
  recorded both revisions; the initial snapshot cannot reconstruct unknown past prices.

## Development

Plain JavaScript, no build step, no runtime npm dependencies.

```sh
node test/prices.test.mjs       # 33 fail-closed parser/fetch tests against real-page fixtures
node test/host-fold.test.mjs    # 11 host fold + auto-check tests (offline, local HTTP fixture)
node --check index.js && node --check client.js
npm pack --dry-run             # inspect the packed file list
```

Layout: `index.js` host half (projection + price check), `client.js` browser half (pill + dialog +
notice), `prices.js` official-page parser/fetcher, `cordis.patch.yml` defaults, `scripts/` manual
price diagnostics, `test/` suites and fixtures, `locale/` Plugin Manager metadata.

## License

MIT — see [LICENSE](LICENSE). Portions of the UI are derived from DeepSeek Harness (MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Chinese README: [README.zh.md](README.zh.md).
