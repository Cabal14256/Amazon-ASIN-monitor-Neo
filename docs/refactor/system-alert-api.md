# 系统公告 API

关联 #111。Neo 提供公开 `GET /api/v1/system/alert`，供登录前后读取系统公告；不要求认证或业务权限。Legacy 入口保留。

响应沿用 `{ success: true, data: { message, type }, errorCode: 0 }`，使用 `Cache-Control: no-store`。只读取进程启动时通过共享配置加载的两个环境值，不读取请求中的公告参数，也不记录公告正文。

- `GLOBAL_ALERT_MESSAGE`：默认空字符串。原样保留空白、多行和 Unicode；空消息时响应类型固定为 `info`。
- `GLOBAL_ALERT_TYPE`：默认 `info`，空字符串同样回退 `info`。保留 Legacy 的自定义类型和空白语义，不在 API 层限制为 UI 类型枚举。
- 修改根目录 `.env.neo` 后重启 Neo API 生效；此接口不提供写入或热重载。旧 Express 的配置仍由 `server/.env` 管理。

这两个值是公开公告内容，客户端按文本展示。自动测试执行实际 Legacy 配置和控制器，比较完整 HTTP 结果及公开路由、默认值和响应头。

本次不涉及数据库迁移。回滚应用提交即可恢复原 Neo 路由状态；Legacy 公告不受影响。应用壳显示公告的迁移和生产配置验证在后续阶段完成。
