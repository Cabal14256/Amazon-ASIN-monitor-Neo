# Project Instructions

- Server-side logging must use `logger` instead of `console.*`.
- Log levels:
  - `debug`: verbose diagnostics (SQL, cache hits, flow tracing).
  - `info`: normal business events (task start/finish, scheduler, success paths).
  - `warn`: recoverable issues and policy violations (rate limit, retries, fallback).
  - `error`: failures that need attention (exceptions, external API failures).
- Environment strategy:
  - Development can log `debug`/`info`.
  - Production must avoid noisy `debug`; rely on `info`+ for operational events.
  - Use `LOG_LEVEL` env to control verbosity (default INFO).
- Sensitive data:
  - Never log raw secrets, tokens, passwords, or PII.
  - Use `logger` sanitization (mask keys like `password`, `token`, `secret`, `authorization`).
  - For error objects, log `message` and minimal context; avoid full payload dumps.

## API URL Rules

- Avoid direct URL concatenation like `${baseURL}${path}` without normalization.
- Always normalize `baseURL` (remove trailing `/`) before request/export URL assembly.
- When `baseURL` already ends with `/api` and request path also starts with `/api`, dedupe one `/api` prefix to prevent `/api/api/...`.
- Keep request-layer and export-layer URL merge logic consistent to avoid environment-specific regressions.
- Any API-related change should include a quick verification that request and export endpoints do not produce duplicated `/api` prefixes.

## Refactor Monorepo Structure

- The repository is in a dual-system migration period. Both systems live on `main`; do not use a long-lived rewrite branch.
- Legacy production paths remain active until their phase gate is passed:
  - `src/` + `.umirc.ts`: React 18 / Umi frontend.
  - `server/`: Express 4 / MySQL / Bull backend and worker roles.
- Neo target paths are:
  - `apps/web`: React 19 / Vite / TanStack / Tailwind frontend.
  - `apps/api`: NestJS 11 / Fastify HTTP API, default port 3100.
  - `apps/worker`: BullMQ worker process.
  - `packages/contracts`: shared REST/WS Zod contracts and permissions.
  - `packages/db`: PostgreSQL / TimescaleDB Drizzle schema and migrations.
  - `packages/config`: shared environment validation.
- During migration, preserve legacy behavior and checks while adding Neo coverage. Remove a legacy path only in the explicit retirement PR for its phase.
- Run workspace commands from the repository root with the root `pnpm-lock.yaml`; do not create package-local lockfiles.

## Git and Branch Workflow

- Treat `main` as protected. Never develop or commit directly on it.
- Before starting a change, switch to `main`, fast-forward from `origin/main`, and create one short-lived branch for one task.
- Use `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `docs/<issue>-<slug>`, `refactor/<issue>-<slug>`, `test/<issue>-<slug>`, `chore/<issue>-<slug>`, or `codex/<issue>-<slug>` according to the task type.
- Features, fixes, refactors, tests, CI changes, and other runtime-affecting work must use a numeric GitHub Issue. `no-issue` is allowed only for small `docs/*` or `chore/*` changes that do not alter runtime behavior.
- Every pull request must target `main`. Do not use feature branches as long-lived or stacked PR targets.
- Before opening or merging a pull request, run the relevant checks. The default baseline is:
  - `corepack pnpm test:contracts`
  - `npm --prefix server run test:unit`
  - `npm run build`
  - `corepack pnpm --filter contracts test`
  - `corepack pnpm --filter config test`
  - `corepack pnpm --filter api test`
  - `corepack pnpm --filter worker test`
  - `corepack pnpm --filter web test`
  - `corepack pnpm --filter web lint`
  - `corepack pnpm --filter web build`
  - `corepack pnpm build:api`
  - `corepack pnpm build:worker`
  - `corepack pnpm build:db`
  - `corepack pnpm exec tsc --noEmit --pretty false`
  - `npm run test:changed-format`
  - `git diff --check`
- Also run package-specific checks for every touched module (for example `web test/lint`, `config test/build`, `db build`, or the legacy server unit suite). Record any intentionally skipped command and reason in the PR `验证` section.
- If a check cannot be run, record the command and reason in the PR's `验证` section.
- Open pull requests as Draft by default. After CI passes, trigger Codex Review and keep the PR unmerged until the latest head commit has been reviewed.
- P0/P1/P2 findings block merge. P3 findings may be deferred only with an explicitly linked follow-up Issue.
- After addressing review feedback, rerun relevant checks, trigger Codex Review again, and resolve every review conversation.
- Mark a PR Ready only when the required CI succeeds, Codex Review covers the latest head commit, and all blocking review conversations are resolved. Use Squash merge only.
- After a merge, sync local `main` and delete the local task branch; GitHub deletes the merged remote branch automatically.
- If a pull request is abandoned, document its replacement or the reason, close it, and delete both local and remote branches.
- Administrator bypass is only for recovering broken branch protection or CI, not for normal development.
- Keep human-facing collaboration guidance in `CONTRIBUTING.md`; this section is the execution contract for repository agents.

## Pull Request Size

- A PR that changes more than 15 files, has more than 1000 additions plus deletions, or spans more than 3 independent modules must explain why it cannot be split.
- Keep one branch and one PR focused on one Issue. Do not use stacked PR targets; every PR targets `main`.

## PR Content Format

- All PR descriptions should follow this structure in Markdown:

```md
## 关联 Issue

Closes #<issue>

## 背景与问题

- 说明业务背景、用户可见问题、根因（如果已定位）。

## 本次修复

### 1) <修复点一标题>

- 变更点
- 变更点

### 2) <修复点二标题>

- 变更点
- 变更点

## 影响范围

- 文件/模块
- 文件/模块

## 风险与回滚

- 风险
- 回滚方式

## PR 粒度说明

- 是否超过警戒线：是 / 否
- 如超过，为什么不能拆分：

## 验证

- 已执行的检查（命令 + 结果）
- 未执行项及原因（如有）

## 截图或日志

- 截图、脱敏日志，或不适用原因

## 回归建议

- 建议回归场景 1
- 建议回归场景 2

## 检查清单

- [ ] 已关联 Issue，或属于允许的 no-issue 小型文档/维护修正
- [ ] 本 PR 只处理一个明确任务
- [ ] 已补充或更新测试
- [ ] 已更新相关文档，或说明不需要更新
- [ ] 未提交密码、Token、Cookie、真实账号或其他敏感数据
- [ ] 数据库变化包含升级和回滚说明，或不涉及数据库
- [ ] CI 已通过
- [ ] Codex Review 已覆盖最新提交
- [ ] 所有 P0/P1/P2 意见和 Review Thread 已处理
```

- Keep section headings in Chinese exactly as above.
- Ensure every listed section is present. Fill in non-applicable sections with a concise reason instead of deleting them.
