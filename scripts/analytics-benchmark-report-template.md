# Analytics Correctness and Performance Gate

The script generates this report automatically. Do not paste response bodies, tokens, cookies, connection strings, or real account data into a report.

Run both targets with isolated caches and their supported cache bypass/disable mode. The 24 database-backed matrix cases must report `meta.cacheHit: false` for every measured response, with the expected source (`raw` for old and `agg` for new by default); cached, raw-fallback, mismatched-source, or missing execution evidence fails promotion.

## Metadata

- Status:
- Created at:
- Environment label:
- Synthetic/representative dataset rows:
- Non-sensitive dataset profile:
- Hot and cold window boundaries (cold must end before hot starts):
- Warmup / measured runs:
- Required P95 speedup: `3x`
- Expected old/new database sources: `raw` / `agg`

## Gate summary

| Gate                                             | Result |
| ------------------------------------------------ | ------ |
| Complete two-window, hour/day/month matrix       |        |
| Every warmup and measured request succeeded      |        |
| Every response used the expected matching status |        |
| Every target produced the required sample count  |        |
| Every case returned non-empty business data      |        |
| Every database case reported `cacheHit: false`   |        |
| Every database case used the expected source     |        |
| Every normalized old/new response matched        |        |
| Every case achieved old/new P95 >= 3x            |        |

## Case results

| Case | Old P50 | Old P90 | Old P95 | New P50 | New P90 | New P95 | Speedup | Non-empty | DB executed | DB source | Correct | Passed |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |

## Reproduction

Use the redacted command emitted in the machine report. Supply secrets only at runtime; the generated JSON and Markdown never include authorization headers or raw response bodies.
