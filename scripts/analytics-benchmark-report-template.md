# Analytics Correctness and Performance Gate

The script generates this report automatically. Do not paste response bodies, tokens, cookies, connection strings, or real account data into a report.

## Metadata

- Status:
- Created at:
- Environment label:
- Synthetic/representative dataset rows:
- Non-sensitive dataset profile:
- Hot and cold windows:
- Warmup / measured runs:
- Required P95 speedup: `3x`

## Gate summary

| Gate                                            | Result |
| ----------------------------------------------- | ------ |
| Complete two-window, hour/day/month matrix      |        |
| Every warmup and measured request succeeded     |        |
| Every target produced the required sample count |        |
| Every normalized old/new response matched       |        |
| Every case achieved old/new P95 >= 3x           |        |

## Case results

| Case | Old P50 | Old P90 | Old P95 | New P50 | New P90 | New P95 | Speedup | Correct | Passed |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: |

## Reproduction

Use the redacted command emitted in the machine report. Supply secrets only at runtime; the generated JSON and Markdown never include authorization headers or raw response bodies.
