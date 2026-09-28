# P2：Legacy / Neo 只读接口双跑差异报告

关联 Issue #180。`scripts/shadow-read-diff.mjs` 使用冻结的 `packages/contracts` 端点注册表校验清单，分别登录 Legacy 和 Neo，然后对同一组 `GET /api/v1` 请求比较完整 JSON 响应。默认清单是 `scripts/shadow-read-manifest.json`；根命令为 `corepack pnpm shadow:read:diff`。本工具只提供隔离环境的响应证据，不切换代理或生产流量，也不退役 Legacy。

## 运行条件

先从仓库根目录构建契约：

```sh
corepack pnpm --filter @asin-monitor/contracts build
```

在两个独立、数据已同步且可访问的非生产环境中配置 `LEGACY_BASE_URL`、`NEO_BASE_URL` 和两套测试账号：`SHADOW_LEGACY_USERNAME`、`SHADOW_LEGACY_PASSWORD`、`SHADOW_NEO_USERNAME`、`SHADOW_NEO_PASSWORD`。账号应具备清单目标所需的读取权限。工具分别调用两边的 `/api/v1/auth/login` 获取各自会话；登录会创建会话或审计记录，因此只在隔离环境运行。不要将真实账号、Cookie、Token、密码或包含它们的命令输出提交到仓库。

```sh
corepack pnpm shadow:read:diff
corepack pnpm shadow:read:diff --manifest scripts/shadow-read-manifest.json --report-dir artifacts/shadow-read-diff --timeout-ms 15000 --max-bytes 4194304
```

基址须为 HTTP(S) URL，可带 `/api` 前缀或尾部斜杠；脚本与契约录制器使用同一 URL 合并规则，避免 `/api/api`。`--timeout-ms` 是单次请求超时，默认 15000、最大 610000；`--max-bytes` 是单个响应体上限，默认 4 MiB、最大 16 MiB。命令行也可用 `--legacy-base`、`--neo-base` 覆盖两个基址。参数不应含凭据。

默认只允许 localhost、127.0.0.1 和 [::1]，避免误把账号提交到远程服务。确认目标是隔离的迁移环境后，才显式追加 `--allow-remote`；这不会改变请求内容或绕过认证。例如：`corepack pnpm shadow:read:diff --allow-remote`。

## 目标清单

清单 JSON 以 `targets` 数组为根，至少 1 项、最多 50 项。每项必须有唯一的 `name` 和冻结注册表中的 `path`，例如 `/variant-groups`；不要写 `/api/v1` 前缀。只允许已登记、未废弃、无特殊流式/下载标记的 GET。可选字段如下：

```json
{
  "targets": [
    {
      "name": "variant-groups",
      "path": "/variant-groups",
      "query": { "current": "1", "pageSize": "10" },
      "requiredDataPath": ["data", "list"],
      "ignorePaths": []
    },
    {
      "name": "known-group",
      "path": "/variant-groups/:groupId",
      "params": { "groupId": "fixture-group-id" }
    }
  ]
}
```

`query` 的键和值均为字符串，值不能是空字符串；`params` 必须逐一提供路径占位符，脚本会编码参数。`requiredDataPath` 是从信封根开始的字段段数组；指定的值在两边都必须非空，适合要求预置记录的夹具。默认清单对角色和权限要求非空，目录列表可以为空，所以默认结果不能证明目录数据已迁移。`ignorePaths` 是受限的斜线分隔字段路径列表，如 `/data/generatedAt`；仅在已登记、确实不可稳定对比的字段上使用，不支持完整 JSON Pointer 转义语法。字段在任一响应中缺失会使目标失败；不要忽略整个业务对象、权限字段或错误信封。

默认目标包含角色、权限、全部角色及主营/竞品变体组首页。扩展历史或详情目标时，先同步固定数据并提供真实、两库对应的 ID；监控历史应指定已封闭的上海时间范围和有限分页，避免新写入使两次请求跨越不同快照。用户、任务、审计、配置和实时仪表盘不属于默认目标；其中部分含敏感内容，部分会随请求或时钟变化。`AUTH_DATA_AUTHORITY` 不是 PostgreSQL 时，Neo 业务读端点可能明确返回 503，不能把它当作对拍通过。

## 判定与报告

每个响应必须是 HTTP 200、JSON Content-Type、非空响应体以及 `{ success: true, data: ... }` 信封；超时、网络错误、重定向、非 JSON、超过响应体上限、夹具为空或任何字段差异都使运行失败。比较完整 JSON 值；只将清单中明确指定的易变字段替换为固定标记。状态码与错误类别也进入报告。

报告原子写入 `artifacts/shadow-read-diff/report.json` 和 `report.md`，可用 `--report-dir` 调整。报告仅包含冻结注册表路径、两边 HTTP 状态/耗时、响应结构形状、每次运行随机密钥计算的摘要、结果与首个差异路径。业务字段名在差异路径中可能被摘要化；摘要只适合同一次运行两边互比，不能跨运行对照。报告不保存清单名称、请求值、原始响应、Cookie、Token、密码或用户资料。尽管如此，仍将报告作为内部迁移证据管理。

退出码 `0` 表示全部目标通过；`1` 表示登录、请求、校验、差异、清单或运行配置失败。缺失契约构建产物会报 `CONTRACTS_NOT_BUILT`。出现失败时先确认两边指向同一冻结数据、账号权限与时间窗口，再根据首个差异路径调查；不要通过扩大 `ignorePaths` 消除真实业务差异。

## 验收边界

同一环境、同一夹具的零差异用于验证对拍器和清单；跨 Legacy/Neo 的零差异只证明本次清单与输入下的响应一致。它不能证明 117 个端点全部迁移、数据库全量对账、并发写行为、性能指标或生产切换门禁。生产最终同步、灰度、队列排空、流量切换与 Legacy 退役继续按 Issue #48 的暂缓安排执行。
