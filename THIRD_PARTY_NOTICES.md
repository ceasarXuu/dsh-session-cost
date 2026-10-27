# Third-party notices

This package is a third-party plugin. It is not part of DeepSeek Harness and is not
published, endorsed, or supported by DeepSeek.

## DeepSeek Harness (DSH)

The composer usage pill markup, stylesheet, formatting helpers and click-open token dialog
behavior in `client.js` are ported from the DSH client UI (`@deepseek-ai/dsh-client-ui-chat`),
which is distributed under the MIT License:

```
MIT License

Copyright (c) 2026 DeepSeek
```

Source: <https://github.com/deepseek-ai/deepseek-harness>

The port keeps the shipped behavior (token formatting, the cache-hit percentage rule, dialog
placement and dismissal) so every official figure stays identical; it does not bundle or import
DSH packages.

## Model pricing data

Default prices and tariff windows are facts taken from DeepSeek's official "Models & Pricing" page:

- <https://api-docs.deepseek.com/quick_start/pricing/>
- <https://api-docs.deepseek.com/updates>

They are used as configuration defaults and re-checked at runtime (at most once per 7 days). No
page content is redistributed; only numeric prices, currency, and the peak/off-peak schedule are
referenced.

## Icons and screenshots

`icon.svg` is original artwork for this plugin, licensed under the same MIT license as the package.
`docs/preview.png` is a schematic render with sample values, not a capture of a real session.
