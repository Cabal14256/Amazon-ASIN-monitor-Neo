# P2：共享 Legacy SP-API 备用客户端

关联 Issue #79。`LegacySpApiClient` 用现有 `SpApiClient`、`LwaTokenService` 和宿主提供的 `QuotaExecutor`/`Transport` 组合出备用请求形态，不另建 HTTPS、令牌刷新或配额实现。旧生产客户端保留；此提交没有连接业务回退管线、REST 或 Worker。

## 显式启用与资源所有权

宿主创建一个长期实例，提供当前配置来源、项目 logger、与标准客户端共用的配额执行器和有界 transport。生产应使用 `NodeHttpTransport` 或具有等价 I/O 上限的实现。

```ts
const legacy = new LegacySpApiClient({
  config,
  quota,
  transport,
  logger,
  isEnabled: (signal) => readCurrentLegacyFallbackFlag(signal),
});
const data = await legacy.call('GET', catalogPath, country, query, null, {
  priority: 2,
  signal,
});
legacy.close();
```

`isEnabled` 应读取 `ENABLE_LEGACY_CLIENT_FALLBACK`，省略时关闭；仅严格 true 允许请求。每次调用（包括令牌命中缓存）重新读开关，失败或取消不会回退旧值。检查处在共享客户端的 64 个活动调用、总期限和取消范围内，并在真正调用共享 quota.execute 之前完成，因此关闭或读取失败不扣上游配额、不读凭据、不发 HTTP。忽略取消的读取仍占用名额直到底层 Promise 结束。

默认总期限 120 秒，调用选项可在现有客户端允许的 1 ～ 900000ms 内明确调整；覆盖开关、配额等待、配置、令牌和请求。继承共享客户端的 1MiB 请求体、响应解析、取消/关闭和安全错误。外部 transport 的实际响应上限与请求期限仍由其配置负责，不能用一个无界注入替代默认运行约束。

`close()` 关闭内部客户端和令牌服务，不关闭宿主的配置池、Redis/配额或 transport。宿主应按调用 → 配额 → 传输/数据库的顺序停止资源。标准和备用客户端各有自己的有界 LWA 缓存（每区一个），不会自动跨实例共享令牌刷新；两者必须共用账号配额。LWA 刷新不另扣 Catalog 配额。

## 兼容与改进

- 固定 US/EU Amazon 端点和六国映射；备用始终不做 SigV4，即使权威配置开启签名。配置先校验后复制，未修改标准客户端的签名开关或凭据。
- Catalog 请求头保留 Legacy 的 `x-amz-access-token`、固定 user-agent，JSON 请求体时加 content-type；不带签名、AWS session token、日期等标准客户端额外头。OAuth 请求保持共享 LWA 原始格式。
- 数组使用重复键（`includedData=summaries&includedData=relationships`），保留调用方键顺序和普通值中的空白。已有 query 的 path 优先并忽略另传 params，与 Legacy 一致。键和值都按规范编码，防止旧实现未编码键导致参数注入。
- 新增有限输入边界：100 个键、键 256 字符、单数组 256 项、总 1024 个非空值、单值 4096 字符；路径连同查询最长 8192 字符，整体 URL 仍受 16384 字符限制。null/undefined 省略，空字符串保留；不支持对象/嵌套数组/非有限数字，未知国家和跨域路径拒绝。
- 默认 priority=2，可传 1/2/3。每次实际 Catalog 请求走同一个共享配额；备用不重试 Catalog 429，调用方不能通过 maxRetries 重新打开此重试。LWA 遇到 401/invalid_client/invalid_grant 时仍保留共享服务重读开关/配置并恢复一次的既有语义。
- `call()` 返回解码后的 data，保持 Legacy 调用者形态；内部安全元数据仍送 quota.observe。继承严格 `404 + NOT_FOUND` 终止规则，HTML/无效 JSON 的“成功响应”明确 INVALID_RESPONSE，不再像旧实现直接返回原文。有效 false/0 JSON 请求体按共享客户端发送；旧实现按 truthiness 忽略此类 body，不保留这一缺陷。

日志沿用共享 logger 固定字段，不记录 URL、ASIN、凭据、token 片段或响应体。业务管线后续决定主 → 备用 →HTML 的回退条件、统计单位与持久化，不能将此客户端的存在当成自动启用了备用。

## 验证与回滚

测试直接 VM 加载实际 Legacy 模块并 stub HTTPS、配置、调度、配额，逐国比较 URL、重复参数、简化请求头、优先级与数据。其它用例验证签名隔离、关闭开关、配置失败、401 轮换、429 不重试、终止规则、64 个忽略取消的读取仍占位、期限和关闭。

实际 `SpApiQuotaExecutor` 与标准/备用客户端组合测试验证第二个调用等待同一秒桶补充；两个 LWA 刷新不会扣四次 Catalog 额度，关闭的备用也不扣额。内存快照 used 是补充后的当前消费量，不是累计请求数，测试不把它误当累计计数。所有上游数据均为虚构 transport，没有请求真实 Amazon。

根目录执行共享包 `test`、`typecheck`、`build` 和仓库完整 17 项基线。request/export 的 URL 契约回归继续检查没有重复 `/api`。无 DDL、依赖或生产开关变更，回滚提交即可；后续宿主接线另行验收。
