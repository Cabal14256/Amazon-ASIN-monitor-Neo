# P3：Home 工作台

关联 Issue #133。Neo Web 的 `/home` 使用现有仪表盘 API 返回的真实数据，展示总览、六国站点状态、异常列表和最近活动。应用外壳提供响应式导航、侧栏收起、个人中心与退出入口；权限过滤沿用身份上下文和页面策略。未迁移页面在导航中显示“迁移中”，仍不能作为可用功能入口。

## 双跑与数据

- 默认 Vite `/api` 代理连接 Legacy :3001，隔离联调可改为 Neo :3100。请求 URL 使用共享归一化规则，`/api` 只出现一次。
- Home 读取 `/api/v1/dashboard`，以共享契约解析信封；请求上限对齐 Legacy 的 120 秒和 API 的 32 MiB 响应上限。每 30 秒在页面可见时刷新，收到 `stats_update` 或主营 `monitor_complete` WebSocket 消息后立即使缓存失效；进行中的读取结束后，等待服务端 30 秒缓存窗口再补刷，补刷时取消其他进行中的读取。页面隐藏时仅标记旧数据，恢复可见后再读取。手动刷新可立即重试；失败时显示错误，保留已有数据时标明旧数据。
- 国家筛选只作用于接口返回的站点、异常和最近活动；没有业务数据时显示空态。未迁移的完整历史、任务等入口保持占位，不能由首页摘要推断这些页面已完成。
- 强制改密用户仅能看到个人中心导航；登录、权限、退出和换号仍由原 Auth context 负责。

## 首页真实站点图表（Issue #200）

- 站点态势使用已经合入主线的 ECharts 6 按需 `NeoChart`，将 dashboard 的 `normal` / `broken` 真实计数映射为横向堆叠柱状图；文字计数和原有国家筛选继续保留。没有新增接口、轮询或数据库字段，也不从最近活动推导七日趋势。
- 正常 / 异常读取当前 Neo 状态 CSS Token；tooltip 使用 richText，不生成 HTML。读屏说明包含各站点的正常、异常和总数，动效由基础封装统一遵守系统减少动效和 400ms 上限。
- 计数必须是非负安全整数，正常加异常必须等于总数；SQL 聚合字符串只接受整数或全零小数尾部，不能把大整数旁的非零小数舍入为整数。重复站点或不一致分类显示局部错误。全零行仍是真实数据；空范围不挂载图表、不导入引擎。
- 查询保留 `dashboard/home` 失效前缀，并按服务端已验证的用户和会话区分缓存。身份未验证时不展示缓存、不读取 dashboard；换号或同账号新会话会由 Query 自动解除旧观察、取消已消费 signal 的读取，迟到响应不能进入新图表。没有新增全局取消或登出清理。
- 原首次加载 / 读取失败、刷新失败保留旧成功快照的提示、WS 立即失效和完成缓存窗口补刷全部保留。
- 产物检查：`corepack pnpm --filter web exec node scripts/chart-build-evidence.mjs` 直接读取当前生产 Home 的 Rollup 模块图，要求 DEV 示例未进入产物、真实 Home 消费者和图表引擎确实存在、bootstrap 和 Home 自身的递归静态依赖没有 ECharts / zrender，并存在指向引擎的动态边。最终产物为 31 个 JS chunk / 269 个引擎模块，静态引擎模块为 0；Home `assets/index-CKZoHAAW.js` 为 17,995 字节 / gzip 6,776，动态引擎 `assets/echarts-runtime-CdiWvYVd.js` 为 565,527 字节 / gzip 194,946。入口为 547,266 字节 / gzip 154,906；入口和引擎存在 500KB warning，未放宽阈值。
- 自动化回归：旧 Home 的三个 mounted HttpClient / Query 场景因缺少图表实际失败；接线后的完整 Web 为 653 passed / 52 files / 0 skipped（单 worker，53.52 秒）。新增 16 个计数边界和 15 个实际 Home 挂载场景，覆盖两种 API base、真实零值 / 空范围、错误 / 旧快照、状态 Token / 减少动效、国家切换、WS / 缓存补刷、换号 / 同账号换会话迟到读和 StrictMode。
- 最后独立 owner / cache / StrictMode 专项为 4 passed / 11 仅因名称过滤 skipped；完整套件没有 skipped。自动化使用实际 HttpClient / Query / NeoChart，只隔离 AppShell、已验证身份发布与引擎 init 边界，真实 SVG / ARIA 由浏览器另验。最终 frozen offline install、Web lint（0 errors / warnings）/ typecheck / build、根 TypeScript / 40 个合同（含 3 个 URL）/ 5 个 changed-format 与 Prettier / diff 检查通过。
- 根代理在当前源码的真实 IAB 联调：1440×1000 的 figure / SVG 为 463×322，390×844 为 293×322，均无横向溢出；实际填充为 `#176741` / `#b32936`，host 的完整中文 ARIA 包含每站点正常、异常和总数组数。英国零值筛选仍绘制真实 SVG（高 180），可恢复全部站点；空范围移除旧 host / ARIA，无效分类计数显示局部 alert 且没有图表 host。
- 同一次浏览器联调还确认 revision 1 的美国正常 / 异常 / 总数 4 / 4 / 8 同步更新文字与 ARIA；读取失败保留已确认快照并显示刷新失败 status，恢复后清除 status。API 控制页直接导航被浏览器客户端限制，根代理通过明确隔离的 loopback HTTP fixture 控制接口 CLI 切换场景，没有浏览器安全绕过或生产源码改动；两个 tab 已关闭、视口已恢复。
- 本地截图未提交二进制，均记录 ready / revision 0 基线，revision 1 使用另行 DOM 证据：`C:/Users/Admin/.codex/visualizations/2026/10/02/01a0fcfb-30a4-7fd3-9f52-b687920a7b97/home-country-desktop.png`、`C:/Users/Admin/.codex/visualizations/2026/10/02/01a0fcfb-30a4-7fd3-9f52-b687920a7b97/home-country-mobile.png`。
- 联调输入是临时 HTTP fixture，不是真实生产数据库，未写入生产组件、接口或数据库；此证据覆盖 Home 当前消费者，不替代生产 15 页面完整验收。临时 fixture / dev 服务器在验收后停止。本 PR 没有后台 / Legacy 源码、合同、锁或迁移变化，其完整套件和构建没有重复执行，具体跳过命令与原因记录在 PR 验证段。
- 本项回滚只恢复 Home 原来的 CSS 比例条；已经合入的图表基础封装、Legacy 服务和数据库不受影响。

## 验收与回滚

- 自动化检查：Web 测试、类型检查、Lint、构建，以及根级 URL 契约测试；检查 `/api` 前缀去重、权限导航和国家筛选。
- 隔离浏览器联调建议同时覆盖宽屏/窄屏、真实 API 成功与失败、WebSocket 更新、退出及强制改密。此批没有变更生产入口或数据库。
- 回滚本 PR 可恢复 Neo Home 占位页；Legacy 生产路径不受影响。
