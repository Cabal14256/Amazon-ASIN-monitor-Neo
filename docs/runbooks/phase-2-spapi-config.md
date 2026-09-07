# P2：SP-API 配置管理与数据库来源

关联 Issue #71。Neo 增加三个配置管理端点和 API 宿主的配置来源；Legacy 继续运行，生产监控、HTML 兜底和业务调度尚未切换。

## 路由与权限

实际前缀为 `/api/v1`。成功包络仍为 `{success:true,errorCode:0,data:...}`，详情和更新返回 snake_case 数据库记录，列表保留 Legacy 的 19 个显示键、描述、顺序、默认值、掩码和 ISO 日期。三个端点均返回 `Cache-Control: no-store`，避免凭据响应进入浏览器或代理缓存。

| 路由 | 权限与行为 |
| --- | --- |
| `GET /sp-api-configs` | 需要 `settings:read`；当前还拥有 `settings:write` 才返回敏感 `configValue` 原值，否则为空，保留 `displayValue` 掩码和 `hasValue` |
| `GET /sp-api-configs/:configKey` | 需要 `settings:read`；敏感键额外需要当前 `settings:write`；仅查已存数据库记录，缺失返回 404 |
| `PUT /sp-api-configs` | 需要 `settings:write`；一个事务完成整批更新；提供 Origin 时必须与 `CORS_ORIGIN` 完全一致 |

全部路由要求有效登录、会话和密码策略。管理读写均在共享 RBAC advisory lock 后锁操作者和会话，重新查询当前权限，避免缓存权限仍允许读取凭据或修改配置。角色名称不能替代权限判断。敏感键延续 Legacy 的 `SECRET|TOKEN|KEY` 判断并忽略大小写。

冻结契约目录中的 `auth:false` 描述旧路由；Neo 有意收紧权限，不修改该 Legacy 基线。读权限用户不会收到完整敏感值；写权限用户仍可编辑。后续 Settings 页面必须遵循这一差异。

`AUTH_DATA_AUTHORITY=legacy-mysql` 时三个端点返回 503，内部数据库来源也拒绝读 Neo 凭据；只有既有 PostgreSQL 鉴权切换门槛通过后才能使用。

## 写入、显示与凭据解析

- 接受 19 个显示键，以及已有共享客户端支持的通用 `SP_API_SESSION_TOKEN` 和 US/EU 各自的 `ACCESS_KEY_ID`、`SECRET_ACCESS_KEY`、`SESSION_TOKEN`，共 26 个管理键。额外七键可用详情/更新接口管理，列表结构保持 19 项。
- 键去除首尾空白、转大写；拒绝未知键、大小写重复、缺 `configValue`、未知输入字段。值可为字符串、有限数值、布尔或 null，统一为去除首尾空白的字符串；null 表示空串。描述可省略，按 Legacy 写为空串。
- 每批 1 ～ 26 项，值最多 4096 个 UTF-16 码元，描述最多 255 个；规范化后的键/值/描述合计最多 64 KiB UTF-8，拒绝剩余控制字符。单个 HTTP body 仍受 Fastify 的上限约束。
- 复用基线 `sp_api_config` 及 `lower(config_key)` 唯一索引，用参数化 SQL 原子 upsert。旧小写键会规范化但保留 id；失败整批回滚，读回顺序与提交顺序一致。时间沿用 D8 上海无时区列映射，不手动加减八小时。
- 显示规则：数据库明确空串保持为空；数据库 null/缺失才读 ENV；无值时竞品开关默认 true、US/EU 间隔默认 30/60 分钟。
- 凭据解析规则与显示不同：非空 DB 区域值 → DB 通用值 → ENV 区域值 → ENV 通用值。AWS 签名开关在 DB 明确为空/false 时关闭，仅 DB null/缺失回退 ENV。

## 来源、容量和生命周期

`DatabaseConfigSource` 位于共享 `@asin-monitor/sp-api` 包。`get(signal)` 与 `reload(signal)` 每次读取当前已提交数据库快照，无跨进程配置缓存；读取失败会抛固定错误，不使用旧快照或用 ENV 掩盖故障。正常成功读取后，缺失字段仍按上述顺序使用 ENV。

API 的 `ApplicationSpApiConfigSource` 在环境文件加载完成后，只快照 26 个受管 ENV 键，使用主库池和配置仓储。模块关闭时停止来源，数据库池仍由应用生命周期关闭。没有后台轮询，也不会记录凭据快照。共享客户端既有 LWA 缓存以凭据内容区分；后续新调用读取到更新值时会取新令牌。在配置提交前已经拿到快照的调用可能继续完成，不能撤销上游已收到的请求。

| 边界 | 限制 |
| --- | --- |
| API 配置管理 | 每进程最多 8 个活动请求，超出 429 |
| 配置仓储 | 每实例最多 16 个活动操作；使用应用池的连接截止 |
| 数据库事务 | 获取连接后最多 2 秒，SQL 最多 1.5 秒，失败销毁独占连接 |
| 共享来源 | 默认 16 个在途读取，5 秒截止；允许上限 64 个和 10 秒 |
| 取消或超时 | 及时拒绝调用方，底层 reader 未结束前保留准入槽，忽略迟到快照 |
| 数据库读取 | 最多 200 行；在 SQL 中将值截到 4097 字符以检测超限，超限报错而非返回截断配置 |

写入审计沿用现有全局审计管线，`configValue`/`config_value`/`displayValue` 均脱敏，失败不输出驱动 SQL、参数或原始错误。正常日志仅记录更新数量，失败仅固定操作名与原因。

## 已验证与后续门槛

本地测试对拍实际 Legacy 显示控制器，覆盖 HTTP 权限、缓存授权后的复查、Origin、输入边界及固定错误。共享客户端测试覆盖配置更新后的 LWA 刷新、已缓存令牌情况下的数据库故障拒绝，以及取消/超时/关闭的容量保留。

CI 的 `sp-api-config.integration.test.ts` 使用独立 PostgreSQL schema（无 public 搜索回退）和实际 Redis。覆盖小写键原子更新、时间映射、整批回滚、成功/失败审计脱敏、实际 RBAC 锁等待和撤权、数据库凭据轮换、SQL 超时及异常数据。仅使用虚构凭据和模拟 Amazon transport，不访问 Amazon 或生产配置。

根目录命令：

```sh
corepack pnpm --filter api test
corepack pnpm --filter api exec tsc -p tsconfig.json --rootDir . --noEmit --pretty false
corepack pnpm --filter sp-api test
corepack pnpm --filter sp-api typecheck
corepack pnpm --filter sp-api build
# 仅在 RUN_INTEGRATION_TESTS=true 的隔离依赖环境：
corepack pnpm --filter api exec vitest run test/sp-api-config.integration.test.ts
```

本阶段不实现 `/rate-limiter/status`、`/error-stats`，也没有把配额/transport/客户端接入实际 API/Worker 业务。监控间隔、竞品开关和 fallback 配置目前可持久化，后续各业务来源/调度器必须接入当前值，不能把更新成功视为旧调度器已重载。Legacy 仍使用原 MySQL 来源，其配置入口不受此变更影响。

## 风险与回滚

本次无 DDL、无环境权限切换、无生产数据更新。回滚应用提交可移除 Neo 路由与来源；数据库中已由管理员更新的配置保留，如需恢复值应另行经授权修改，不能从审计日志还原密钥。Legacy 路径继续保留。独立完成业务管线、实网 sandbox/灰度、影子对拍和生产回滚门槛后才能切流或退役。
