# Neo literal catalog detail reads

Issue #242 adds independent read-only routes:

| Domain | Route | Query | Permission |
| --- | --- | --- | --- |
| Primary | `GET /api/v1/catalog/variant-groups/detail` | `groupId` | `asin:read` |
| Competitor | `GET /api/v1/competitor/catalog/variant-groups/detail` | `groupId` | `asin:read` |

Each query contains exactly one `groupId` field. The existing Neo persisted-ID validator accepts 1-50 Unicode code points, including whitespace-only IDs, padding, `.`, `..`, `/`, `?`, `#`, `\\`, and Unicode. Empty IDs, C0/C1 controls, malformed UTF-8/percent encoding, lone surrogates, duplicate keys, bracket keys, and additional fields return 400. IDs retain their original value; the server does not trim, shorten, or fold case. Clients pass the raw ID through `HttpClient` query options so the shared URL normalizer continues to deduplicate `/api`.

Both routes use the existing authentication and permission guards, then recheck the current user, session owner/status/expiry, password state, and `asin:read` permission under the existing transaction locks. Responses use the existing group schemas and `Cache-Control: no-store`; a missing exact group returns 404. Existing response size, child count, concurrency, and database deadline limits still apply.

The PostgreSQL detail mode compares the original group key and every child `variant_group_id` with the deterministic `C` collation. Case, accent, and PADSPACE neighbors do not select a group or attach a child. The competitor route uses the independent competitor database while authorizing against the primary database. No schema, index, migration, write route, or frozen Legacy endpoint changes are required. The original `GET .../variant-groups/:groupId` routes keep their existing matching behavior; real IDs `detail` and `by-id` remain reachable there.

The Web typed detail services use these Neo query routes. Generic `HttpClient` path-segment protection and all record mutation paths retain their existing behavior.

## Verification

Run from the repository root with its lockfile:

```powershell
corepack pnpm --workspace-concurrency=1 --filter @asin-monitor/api... build
corepack pnpm --filter @asin-monitor/api exec vitest run test/catalog-literal-detail.test.ts test/asin-query.test.ts test/asin-query-values.test.ts test/asin-query-mapper.test.ts test/competitor-query.test.ts test/competitor-query-mapper.test.ts --maxWorkers=1
corepack pnpm --filter @asin-monitor/web exec vitest run src/services/catalog-literal-detail.test.ts src/pages/catalog/catalog-literal-detail-page.test.tsx src/services/asin.test.ts src/services/competitor-asin.test.ts src/services/asin-canonical-network.test.ts src/pages/catalog/primary-canonical-actions.test.tsx src/pages/catalog/competitor-actions.test.tsx --maxWorkers=1
```

The integration workflow explicitly runs `apps/api/test/catalog-literal-detail.integration.test.ts` after both database baselines and competitor matching migration `0010` are applied. It covers actual Fastify HTTP, PostgreSQL SQL, and Redis guard caching, including precise children, old path compatibility, permission revocation, foreign/revoked sessions, database isolation, and dependency failures.

Native integration requires `RUN_INTEGRATION_TESTS=true`, `INTEGRATION_ALLOW_DROP_DATABASES=true`, and `TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE=amazon_asin_monitor_ci`, with PostgreSQL URLs pointing to the exact local disposable databases `amazon_asin_monitor_ci` and `amazon_competitor_monitor_ci`, and a local Redis URL for database `15`. A guard verifies these targets before opening pools or connecting to Redis. The fixture creates isolated private schemas and removes them afterward. Do not enable these flags against any production service.

```powershell
corepack pnpm --filter @asin-monitor/api exec vitest run test/catalog-literal-detail.integration.test.ts --maxWorkers=1
```

Without the integration flags, these 22 cases are skipped. A skipped local run is not evidence of native PostgreSQL behavior; the explicit integration CI result is required.

## Oracle Preservation

The original four Issue #242 test sources and original RED logs are retained as local verification artifacts. The mounted catalog fixture now uses the formal `createAppRouter`, including its `beforeLoad` identity gate. Its original custom router omitted this gate and briefly mounted the old catalog match after navigating to `/403`. Both permission cases pass with the formal router without any product permission change. The detail query now checks both responsive layouts with `findAllByRole` and `within`, retaining the original literal-ID, child, cache, permission, and session assertions.

The Home linked-group chain belongs to Issue #228. Any cross-PR verification must use preserved source copies in an isolated temporary fixture and restore them afterward; #242 must keep `main` as its PR base. Only the mock transport route changes from a path segment to the new query entry, while the original link and raw-ID assertions remain intact.

## Rollback

Revert the #242 code and typed-service changes together. No data rollback is needed. Production rollout, database cutover, and Legacy retirement remain behind their existing migration gates.
