# Releasing

Target: publish this bundle as the public npm package **`@ceasarxuu/dsh-session-cost`** and,
optionally, list it in a DSH plugin-market index.

## One-time prerequisites

- npm account that owns the `@ceasarxuu` scope, logged in locally: `npm login` (then `npm whoami`).
- GitHub repository `ceasarXuu/dsh-session-cost` (public). The package metadata and README already
  point at it, so create it before announcing the npm package:
  `gh repo create ceasarXuu/dsh-session-cost --public --source=. --push`

## Release checklist

```sh
# 1. Version: bump for every published change (npm rejects a reused version)
npm version patch --no-git-tag-version     # or minor/major

# 2. Tests and packed file list
node test/prices.test.mjs
node test/host-fold.test.mjs
node --check index.js && node --check client.js
npm pack --dry-run                         # confirm files, size, and that no private data is included

# 3. Publish (first release: public access; scoped packages default to restricted)
npm publish --access public

# 4. Source repository + tag
git push
git tag "v$(node -p "require('./package.json').version")"
git push --tags
```

Post-publish checks:

- `npm view @ceasarxuu/dsh-session-cost version dist-tags` shows the new version under `latest`.
- On a clean DSH profile: Plugin Manager → Add → `@ceasarxuu/dsh-session-cost`, or
  `dsh plugin --profile smoke add @ceasarxuu/dsh-session-cost`. The composer pill must show the cost
  segment, and `~/.dsh/plugin-data/session-cost/price-state.json` must appear after the first check.
- Check the Plugin Manager card: localized title/description (`locale/en.json`, `locale/zh.json`) and
  the icon.
- If this release changes `engine.dsh`, re-run the install smoke test on the oldest supported DSH
  version.

## Compatibility policy

- `engines.dsh` currently allows `>=0.2.1-rc.2 <0.3.0`. Widen it only after actually installing and
  running the plugin on the older version; narrow it when a DSH API change breaks the fold, the
  composer slot, locale registration, or session-list projections.
- The plugin intentionally uses only public DSH runtime seams (session projections with a wire view,
  slot shadowing, locale registration, session-list projections). If an upstream change removes one,
  bump the minor version and state the tested DSH version in the README.

## Plugin market index (optional)

`market/index.json` is a format-1 index with one npm entry; `market/icons/session-cost.svg` is its
icon. Regenerate the timestamp after publishing:

```sh
python3 - <<'PY'
import json, time
p = 'market/index.json'
data = json.load(open(p))
data['plugins'][0]['versions'][0]['publishTimestamp'] = int(time.time())
json.dump(data, open(p, 'w'), indent=2, ensure_ascii=False)
open(p, 'a').write('\n')
PY
```

Host the `market/` directory on any static HTTPS host (GitHub Pages, object storage) and users add
`https://<host>/index.json` as an index source in Plugins → Discover. Validate the format first with
the DSH `@deepseek-ai/dsh-plugin-market-index` validator if available.

## Rollback

- Wrong metadata but correct code: publish a patch version.
- Broken release: `npm deprecate @ceasarxuu/dsh-session-cost@<version> "reason"` and publish a fixed
  version. `npm unpublish` within the registry's grace window is possible but disruptive; prefer a
  forward fix.
