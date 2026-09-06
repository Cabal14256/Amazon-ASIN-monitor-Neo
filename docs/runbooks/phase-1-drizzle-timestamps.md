# D8：Drizzle 北京时间映射

关联 Issue：#42。主库和竞品库继续使用 `timestamp without time zone` 保存北京时间，JavaScript `Date` 表示一个绝对时刻。此修复只改变 ORM 编解码，不改变 PostgreSQL 类型、默认值、基线 DDL、ETL 规则或已存储行。

## 问题与修复

原生 pg 查询可通过连接池 OID 1114 parser 使用北京时间；Drizzle 的 Node PostgreSQL session 会覆盖这一 parser，让自己的 timestamp 列 mapper 读取原始字符串。所锁定版本的原生 timestamp mapper 按 UTC 解释无时区字段，写入 `Date` 时发送 UTC ISO 字符串；PostgreSQL 无时区列忽略字符串中的时区信息，因而也写入了错误墙上时间。

例如：

| 路径 | 正确结果 | 修复前 ORM 结果 |
| --- | --- | --- |
| 读取数据库 `2026-09-06 12:30:15.123` | `2026-09-06T04:30:15.123Z` | `2026-09-06T12:30:15.123Z` |
| 写入 `Date('2026-09-06T04:30:15.123Z')` | 数据库 `2026-09-06 12:30:15.123` | 数据库 `2026-09-06 04:30:15.123` |

仅用同一套 ORM 写入后读回会使两个偏差相互抵消，不能证明与 Legacy/ETL/数据库默认时间一致。会话和密码到期时间、监控范围查询、审计展示都必须使用同一边界。

双库 schema 统一使用 `src/timestamps.ts` 中的 Drizzle `customType`，pg OID parser 也复用这个模块的解析函数，schema 不反向依赖连接池模块。读取按 D8 的固定 UTC+8 转为 `Date`，写入与比较谓词将 `Date` 转为北京时间无时区字符串。SQL 类型仍返回 `timestamp`，数据库 catalog 仍为 `timestamp without time zone`；NULL 由 ORM 保留。非法 Date/不支持的无限时间值直接报错，错误不包含原始字段内容。

这是明确的 ORM 类型转换，不依赖 Node 宿主时区或数据库连接的时区来猜测参数含义。数据库的 `LOCALTIMESTAMP` 默认值仍依赖数据库时区，部署必须保留 `Asia/Shanghai` 配置。JS Date 保留毫秒精度，与此前接口精度一致；不要用 Date 读写循环重存要求保留微秒精度的历史字段。

参考：[Drizzle 自定义类型的 fromDriver/toDriver](https://orm.drizzle.team/docs/custom-types)、[PostgreSQL 日期时间类型](https://www.postgresql.org/docs/current/datatype-datetime.html)。实现以仓库锁定的 Drizzle API 为准，未升级依赖。

## 验证

```sh
corepack pnpm --filter db test
corepack pnpm build:db
corepack pnpm --filter api test
corepack pnpm build:api
corepack pnpm build:worker
```

新增 9 项 ORM 测试，覆盖双库实际 result mapper、写入/查询参数、空值、全部 timestamp 列、UTC/上海/纽约宿主时区及跨日/跨年边界。修复前其中 4 项能稳定复现八小时偏移，修复后通过。

隔离集成 CI 的 `pnpm --filter @asin-monitor/db test:integration` 增加 `timestamp.integration.test.ts`：用原生 SQL 写入后由 Drizzle 读取、由 Drizzle 插入/更新后用原生 SQL 检查墙上时间、精确时间范围查询、竞品库与已到期 Session。测试事务全部回滚，连接失败也释放连接池；不改生产库、不清空表。

原有 schema/ETL/持续聚合/存储策略对拍必须继续通过，确保类型 catalog、迁移元数据和 Timescale 行为没有变化。

## 数据核查与回滚

这项代码修复不能证明现有业务数据已经符合 D8。如果某个环境运行过旧 Neo ORM 日期写入，原生 SQL 默认值、ETL 导入和 ORM 写入可能混在同一张表甚至同一行，不能统一加减八小时。

在该环境切换前，应按写入来源和已知业务事件核查会话到期、密码到期、最后检查和创建/更新时间，保留核查证据；必要的纠偏或会话失效操作必须单独确定记录范围与回滚步骤。当前提交没有自动纠偏脚本，也没有执行任何生产数据变更。

回滚代码时可撤销本提交恢复旧映射，但旧映射本身存在偏差；优先将相应业务流量回切仍保留的 Legacy 入口，避免继续混用两种 ORM 日期写入方式。P1/P2 的正式出口仍需实际数据与回滚验收。
