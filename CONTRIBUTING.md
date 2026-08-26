# 分支与合并约定

本仓库采用受保护的 `main` + 短生命周期分支模式。除 `main` 外，不保留长期开发、发布或个人分支。

当前处于新旧系统并行重构期。旧系统位于根 `src/` 与 `server/`，Neo 系统位于 `apps/*` 与 `packages/*`。两套代码持续小步合入 `main`；旧系统冻结新增功能但仍接受必要 bugfix，任何旧路径删除都必须等到对应阶段出口 gate，并使用独立退役 PR。

## 分支生命周期

- 从最新 `main` 创建分支，一个分支只处理一个明确任务。
- 分支使用 `feat|fix|docs|refactor|test|chore|codex/<issue>-<slug>`，其中 `<issue>` 为数字 GitHub Issue 编号。
- 只有不改变运行行为的小型文档或维护修正可以使用 `docs/no-issue-*` 或 `chore/no-issue-*`；功能、修复、重构、测试和 CI 改动必须关联 Issue。
- 所有 PR 均直接以 `main` 为目标，不把功能分支作为长期或层叠 PR 的合并目标。
- 禁止直接推送、强制推送或删除 `main`。
- PR 合并后由 GitHub 自动删除源分支；关闭但不合并时，应注明替代 PR 或放弃原因后立即删除分支。

## PR 与合并

- PR 默认先创建为 Draft，并完整填写仓库模板中的中文章节。
- CI 通过后请求 Codex Review；修复意见后重新运行相关检查并再次请求 Review。
- P0/P1/P2 禁止带入合并；P3 仅可在创建并关联后续 Issue 后延期。
- 标记 Ready 前，最新提交必须通过 CI 和 Codex Review，且所有阻塞评论及 Review Thread 已解决。
- 合并前必须将分支同步到最新 `main`。
- 仓库统一使用 Squash merge；Squash 提交标题应准确概括完整 PR。
- 当前为单维护者仓库，不要求额外审批；管理员绕过规则仅用于修复分支规则或 CI 本身导致的紧急锁定。

## PR 粒度

出现以下任一情况时，PR 必须在“PR 粒度说明”中解释为什么不能拆分：

- 修改文件超过 15 个；
- 新增与删除合计超过 1000 行；
- 跨越 3 个以上独立模块。

每个 PR 只处理一个 Issue，所有 PR 直接面向 `main`，不使用长期或层叠功能分支作为目标。

## 必需检查

CI 使用 Node.js 20 与根目录单一 `pnpm-lock.yaml`。本地从仓库根执行：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test:contracts
corepack pnpm --filter contracts test
corepack pnpm --filter api test
corepack pnpm --filter worker test
corepack pnpm --filter web build
corepack pnpm --filter api build
corepack pnpm exec tsc --noEmit --pretty false
git diff --check
```

同时运行所有受影响包的补充检查，例如 `web test/lint`、`config test/build`、`db build` 或旧 `server` 单测。CI 还执行 PR 策略、变更文件格式、旧前端构建与 Monorepo 全包验证；`pr-policy` 校验分支、Issue、中文章节和粒度说明。任何必需检查失败都不得合入 `main`。

## 双系统开发

- 旧业务系统：`npm --prefix server run dev`（3001）与 `npm run dev`（8000）。
- Neo 骨架：`corepack pnpm dev:api`（3100）、`corepack pnpm dev:worker`、`corepack pnpm dev:web`（5173）。
- Neo Web 在双跑期仍把 `/api` 和 `/ws` 代理到旧后端 3001；业务域逐项迁移后再按路由切到 3100。
- 环境配置分离：旧后端读取 `server/.env`，Neo API/Worker 读取根 `.env.neo`。不要复制真实凭据到 Issue、PR、日志或 fixture。
