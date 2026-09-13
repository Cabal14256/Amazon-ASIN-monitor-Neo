# 共享飞书通知服务

关联 #117。`@asin-monitor/notify` 为 API/Worker 提供主营与竞品的完整卡片、单次发送、单国重试发送和批量发送。该包交付可调用的真实 PostgreSQL/HTTP 实现；监控触发、实际监控 Processor、调度和进度广播继续在各自迁移任务中接入。不会因包初始化而自动发送通知。

## 调用和兼容行为

宿主使用 `createFeishuNotifications({ primaryPool, competitorPool, authority, logger })` 创建实例，`authority()` 返回当前认证数据权威源。生产构造器使用双库当前配置及真实 HTTPS 传输。关闭宿主时调用实例的 `close()`，再由宿主关闭两个数据库池。

- `sendOnce(domain, region, data, signal?)` 只发送一次，按原始 region 查询配置；不会自动把 UK 映射为 EU。
- `sendCountry(domain, country, data, signal?)` 把精确大写 UK/DE/FR/IT/ES 映射为 EU，保留国家显示名。主营单国完整结果与 Legacy 相同；竞品也提供同一调用方式，供后续宿主复用。
- `sendBatch(domain, countries, signal?)` 按输入国家顺序，每批两个国家并发；整批完成后等待 500ms 才开始下一批。这不是每个 HTTP 请求之间的全局间隔。
- 重试最多三次总尝试，只对 `Number(errorCode) === 11232` 重试，前两次等待 `2000 + floor(random * 2000)` 毫秒。HTTP/网络的其他失败不自动重试。
- 仅 HTTP 200 且响应 code 为数字 0 才成功。保留数字错误码及有界数字字符串；非数字任意响应文本不作为 errorCode 返回，以免泄漏上游内容。非 JSON 响应沿用旧行为，回退为 HTTP 状态码。
- 未配置、空 Webhook、禁用或 NULL enabled 均不发送。单国结果仍为 `success:false, skipped:false`，批量的总 skipped 保持 0；正常国家也发送“全部正常”通知。批量保留完整 total/success/failed/countryResults。

主营卡片保留国家状态标题、异常分类、人工来源与原因、无 ASIN 的异常组、组 ID 优先的分组和 Amazon 链接。竞品保留自己的标题、组顺序与品牌展示。Date 按 UTC+8 格式化，字符串时间原样保留；无时间或无效 Date 使用当前时间。字典查询只匹配自身键，未知国家或状态按原字符串处理，不读取 JavaScript 原型成员。

## 当前配置、双库和事务

`PgNotificationConfigSource` 将主营请求交给主库 `feishu_config`，竞品请求交给竞品库 `competitor_feishu_config`。两者拥有独立读取器；生产宿主必须传入正确的 D6 两库连接池。Legacy 权威源模式明确失败。

每一次尝试都重新读取启用配置，不使用凭据缓存、不回退环境变量或旧值。读取在只读事务内取得同库共享管理锁，再按大小写、重音和尾空格等值规则查询；重复等值行（即使有一行禁用）明确失败。返回前事务提交并复核取消状态。轮换、禁用、删除在下次读取时生效；已发出的 HTTP 请求无法被配置修改追溯撤回。

连接获取、SQL 和总读取都有期限。取消或超时会销毁已经借出的连接；尚未完成的池获取保留容量名额，迟到连接直接释放，不执行 SQL。读取器关闭不会关闭宿主池。

## 升级与回滚

发送前在**两个数据库**应用 `0009_notification_country_collation.sql`。该升级仅创建并验证 ICU 比较规则，不改配置行、唯一约束或显示文本，可重复执行。现有主库的 0005 比较规则不能代替竞品库升级。

```sh
corepack pnpm db:upgrade:notification-collation
```

Compose 提供脚本与升级/回滚 SQL 的只读挂载。脚本先验证两个数据库名并禁止二者相同，再逐库执行。两库不是分布式事务：若第二库失败，先修复原因并重跑，不能只凭主库成功启动双域发送。已有同名比较规则定义或 ICU 版本不符时拒绝继续，避免静默改变相等关系。

回滚时先停止或回退 Neo 通知消费者，再用相同脚本传入回滚 SQL，作用于两个数据库：

```sh
docker compose --env-file .env.neo -f compose.neo.yml exec -T timescaledb sh /opt/asin-monitor/apply-notification-country-collation.sh /opt/asin-monitor/0009_notification_country_collation.rollback.sql
```

回滚使用 `DROP COLLATION ... RESTRICT`，不删除配置或级联删除外部对象。若有人创建了依赖该规则的索引，回滚会拒绝，需要先单独处理依赖。

## 资源限制、取消和日志

- 每实例最多 4 个发送操作、8 个尚未实际结束的配置/网络/等待依赖；不建立无界等待队列。自定义适配器即使忽略取消，也继续占用名额直到真正结束。
- 默认单次配置读取 2 秒、单条 SQL 1.5 秒、HTTP 10 秒、完整操作 12 分钟。自定义构造器可缩短操作/配置/HTTP 期限；不能扩大这些上限。
- 单国输入累计字符串最多 1 MiB、数组成员合计最多 10,000；单批最多 32 国家、输入快照合计最多 8 MiB；完整 HTTP 请求最多 1 MiB，响应最多 64 KiB。超限不截断卡片或凭据。
- 生产只接受 HTTPS，拒绝 URL 用户名/密码，不跟随重定向。传输复用共享的有界 Node HTTP 实现；通知请求使用 `Connection: close`，避免不同 Webhook 来源长期积累空闲套接字。本机 HTTP 只在显式测试适配器选项中开放。
- 取消、关闭与完整操作超时以固定 `NotificationError` 拒绝操作，停止后续批次和重试；迟到配置/HTTP 结果被丢弃。其他发送失败返回 Legacy 风格失败结果。调用者传入的任意取消原因不会被直接传播。
- 输入在异步读取前复制，调用者之后改动数据不会改变进行中的重试。日志只含固定原因、域和尝试序号；不含 Webhook、卡片、用户文本、SQL 或驱动异常。11232 用 warn，成功用 info，外部失败用 error。

`getDiagnostics()` 返回进程内发送尝试、成功、失败、限频重试及当前工作计数。它不是跨进程业务统计。网络错误可能发生在服务端已经接收通知之后；该服务不会承诺 exactly-once，后续监控宿主必须明确任务重试和重复通知的处理方式。

## 验证方式

卡片与发送轨迹测试直接加载原 Legacy 服务，对照完整请求卡片、读取顺序、地区映射、重试时刻与返回结果。真实 loopback 测试验证 Node 传输、超时/断线/超限、取消、关闭及轮换路径，不调用真实 Webhook。

Integration 在 D6 两个 PostgreSQL 数据库的私有 schema 中验证当前配置、相等规则、歧义、权限管理锁、SQL 取消与恢复，再将真实 PG 来源接到 loopback HTTP 验证重试前轮换。额外一次性数据库执行原始升级/回滚 SQL 并验证不兼容定义；工作流还在两个基线数据库重复升级与回滚。隔离测试不能代替生产数据、真实规模和阶段切流验收。
