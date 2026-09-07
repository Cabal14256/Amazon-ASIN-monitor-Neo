# P2：有界 HTML 商品关系兜底

关联 Issue #77。`@asin-monitor/sp-api` 提供 `HtmlVariantClient` 与纯解析函数，API/Worker 可以共用。此提交尚未接入宿主业务、数据库开关或任务处理器，没有生产流量切换。Legacy HTML 服务继续保留。

## 使用与生命周期

宿主创建单例，传入项目 `logger`，通过 `isEnabled(signal)` 显式读取当前 HTML 兜底开关；省略回调时默认关闭。回调只接受严格 `true`，读取失败、超时或其它返回值均失败，不使用旧开关缓存。后续接入应继续尊重 `ENABLE_HTML_SCRAPER_FALLBACK` 及完整业务回退策略，不能仅构造此客户端便打开流量。

```ts
const html = new HtmlVariantClient({
  logger,
  isEnabled: (signal) => readCurrentHtmlFallbackFlag(signal),
});
const result = await html.checkVariants(asin, country, signal);
// 宿主停止时调用；外部传入的 transport 仍由调用方关闭。
html.close();
```

`checkVariants` 返回 Legacy 形态：`hasVariants`、`variantCount`、`details.{asin,parentAsin,variantAsins,source,duration}`。source 固定 `html_scraper`，duration 为本次调用毫秒耗时。父 ASIN 存在或数组非空即 hasVariants=true；variantCount 只计算去重后的数组长度，父 ASIN 不额外加一，保持旧行为。

默认原生 `NodeHttpTransport` 使用固定六个国家商品域名（US/UK/DE/FR/IT/ES）与 `/dp/<ASIN>` 路径。输入 trim/uppercase 后验证十位字母或数字，拒绝未知国家和路径注入。保留 Legacy 对应的 Accept-Language，使用固定可识别 User-Agent；不附加凭据、Cookie，不轮换身份，不跟随重定向，也不重试或绕过验证码。HTML 请求独立于 SP-API 的 quota/operation 调度，不能把 HTML 流量计成一次 Catalog API 尝试。

| 边界      | 值与行为                                                     |
| --------- | ------------------------------------------------------------ |
| 活动调用  | 默认 2，可配置整数 1 ～ 8；无等待队列，满额 CAPACITY         |
| 总期限    | 默认 15 秒，可缩短到 1 ～ 15000ms；包括开关读取、HTTP 和解析 |
| 响应      | 原生流式读取最多 2MiB；解析前再次按 UTF-8 字节数检查         |
| 元数据块  | 最多 64 个源标记，每块最多 65536 字符                        |
| 变体      | 单数组最多 4096 项，去重后最多 2000 个；超出明确失败，不截断 |
| HTML 标记 | 最多 100000 个，每个最多 8192 字符；游标单向前进             |

取消、期限或 close 会及时拒绝调用并中止自有 HTTP I/O。外部注入的开关读取/transport 若忽略 signal，仍保留其活动名额直到底层 Promise 真正结束；迟到结果不会计为成功。外部 transport 必须自行限制实际网络 I/O；生产默认实现已经限制 socket/request、字节和期限。构造/导入不产生网络请求，也无周期 timer。

## 解析兼容和明确失败

父 ASIN 保留 `parentAsin`、`parent_asin`、`data-asin-parent` 三种格式，覆盖旧 twisterJsInit/variationDisplayData 包含的字段。变体数组保留这两个源块中的 JSON `variationASINs`，按旧源优先顺序去重。关系值沿用旧规则：十位、首位字母，其余字母或数字。旧实现在无效父值后可能把十字符键名提取成 `PARENTASIN`；新实现只读取捕获的值并继续寻找有效候选。

解析器要求可见 h1/span 的 productTitle 文本证据，以及匹配的 ASIN input 或当前国家 HTTPS canonical 商品链接；任何显式身份冲突都拒绝。注释和 script/style/textarea/template 内的商品标记不能作为身份依据，嵌套 template、未闭合原始文本块等不支持形态保守失败。本实现是受限格式解析器，不执行 JavaScript，也不声称涵盖 Amazon 的所有页面格式；页面结构变化可能增加失败率，后续必须用脱敏 fixture 扩充，不能自动放宽为“无变体”。

仅接受 HTTP 200、text/html 和无压缩或 identity 编码。挑战提示（Robot Check、validateCaptcha 等）、空/错误页面、缺商品证据、身份不符、非法父值、畸形/未知来源的 variationASINs 均 INVALID_RESPONSE。多个数组中有一个无法确认时整次失败，不能返回部分集合。带有效商品证据且没有关系元数据的页面才可返回无变体。

所有 HTTP 错误仅保留固定错误码和合法状态，不复制响应体、Location、上游原始消息或 Amazon 业务码。因此 HTML 404 **不会**满足 Catalog 的 `404 + NOT_FOUND` 终止规则。日志使用 logger，仅固定事件、国家、数量、耗时或固定失败原因，不输出 URL、ASIN、HTML、用户标识或原始异常。

## 验证

测试直接 VM 加载实际 Legacy HTML 模块（axios/logger 均为 stub），对照六国 URL、父字段、两个变体源的顺序与去重，并固定复现 PARENTASIN 问题。其它用例覆盖页面身份、挑战、畸形元数据、部分集合、字节/块/数组边界、迟到结果、开关失败、取消/期限后容量、固定头及日志脱敏。

真实 HTTP 测试仅访问 127.0.0.1 的随机端口：测试适配器把已断言的固定商品 URL 映射到本机 fixture，生产没有可配置的 HTML baseURL。覆盖连接复用、重定向不跟随、流式超限断开、停滞期限、实际取消和截断响应。没有请求真实 Amazon 或使用真实凭据。

根目录执行 `corepack pnpm --filter sp-api test`、`corepack pnpm --filter sp-api typecheck`、`corepack pnpm --filter sp-api build`，并执行仓库规定的完整基线。request/export 的既有 URL 归一化契约测试继续验证无重复 `/api`。

## 回滚

无 DDL、依赖或环境变量变化。回滚此提交即可移除共享 HTML 模块；尚无宿主接线，旧生产路径不受影响。后续真正启用时先按域灰度，并将开关读取、回退顺序、统计单位、取消传播与结果持久化作为独立验收内容。
