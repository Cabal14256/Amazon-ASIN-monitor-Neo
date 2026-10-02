# Neo ECharts 6 基础封装

关联 Issue：#198。对应重构方案 P3 和方向七的按需图表封装；业务统计接线由后续任务完成。

## 使用边界

- Web 固定 `echarts@6.1.0`，Legacy 根包仍是 `echarts@5.6.0`；只有根 `pnpm-lock.yaml`。
- `NeoChart` 接收实际调用者的 `option`、可读 `label` 及 `loading` / `error` / `empty`。空态必须由调用者根据真实数据决定，不从图形或零数值猜测。
- 只有可绘制的挂载会动态导入引擎。官方 core 按需注册 Line / Bar / Pie、Grid / Tooltip / Legend / Aria 和 SVGRenderer，不导入 ECharts 全量入口。
- 配色读取 Neo CSS Token；显式系列颜色可用于业务状态。标签和说明应由业务调用者提供，开发示例不能作为业务数据源。
- 未指定动效的系列继承全局 animation / duration / update duration；显式系列配置优先。全局和系列更新动画均封顶 400ms；数值动画时间限制为 0–400ms，函数式时间回退为 300ms；减少动效时动画与延迟归零。用户在运行中更改系统设置会更新现有实例。
- 相同实例使用 `notMerge` 替换选项，移除的系列不会残留。容器尺寸为零时等待 ResizeObserver，另保留 window resize 兼容；卸载立即解除监听与 dispose，晚到的动态模块不会初始化已卸载节点。
- 加载或绘制异常显示局部反馈；绘制重试重建实例。调用者查询错误由调用者恢复，封装不发请求、不重试业务写入。

## 官方依据

- [ECharts 按需导入与 ComposeOption](https://echarts.apache.org/handbook/en/basics/import/)：core、charts、components、renderer 分别引入，显式注册 SVG 渲染器。
- [ECharts 6 新特性](https://echarts.apache.org/handbook/en/basics/release-note/v6-feature/) 与 [Apache 6.1.0 release](https://github.com/apache/echarts/releases/tag/6.1.0)：仅 Neo 使用 6.x。
- [容器尺寸、resize 与 dispose](https://echarts.apache.org/handbook/en/concepts/chart-size/)：容器获得尺寸后初始化，移除节点时释放实例。
- 包管理器核验：`corepack pnpm view echarts version` 返回 `6.1.0`。

## 开发预览与实际浏览器证据

从根运行 `corepack pnpm --filter web dev --host 127.0.0.1 --port 5178`，访问 `/__dev/design-system` 底部图表区。仅开发路由提供标注为虚构示例的折线、柱状、饼图，不需要身份或业务服务 fixture。

2026-10-03 的根代理真实 IAB 验证（原提交 c65221a）：

- 1440×900：三个 SVG 均为 374×260，分别有 26 / 17 / 10 条 path；更新按钮使三个 SVG 实际内容变化；卸载后 SVG 为零，重新挂载恢复三个。
- 390×844：三个 SVG 宽度 293，与 host 一致；body 宽度 375（竖向滚动条占 15px），无横向溢出。
- 加载状态移除所有 SVG，并显示三个 status；空态 / 查询失败各显示三个局部反馈，恢复有数据后重新绘制。
- 截图保存在本地，未提交图片：
  - `C:/Users/Admin/.codex/visualizations/2026/10/02/01a0fcfb-30a4-7fd3-9f52-b687920a7b97/echarts-desktop.png`
  - `C:/Users/Admin/.codex/visualizations/2026/10/02/01a0fcfb-30a4-7fd3-9f52-b687920a7b97/echarts-mobile.png`

这些证据覆盖开发图表的真实绘制和反馈；后续动效继承修复没有修改交互结构或尺寸，新增情形由专项与完整测试验证，未重复浏览器 QA。尚未接业务统计，不能替代生产 15 页面完整验收。

## 生产产物证据

运行 `corepack pnpm --filter web exec node scripts/chart-build-evidence.mjs`。脚本读取实际 Vite / Rollup 模块图：先构建当前生产应用，再在临时目录构建一个仅导出真实 NeoChart 的 ES 库消费者。两次构建均在内存生成产物，不修改生产入口，不包含虚构业务数据。

- 当前生产应用：33 个 JavaScript chunk，ECharts / zrender 模块数为 **0**，因为 DEV 路由被裁剪。此阶段没有新增生产首屏图表下载。
- 实际消费者探针：入口 `neo-chart-probe.js` 为 93,071 字节 / gzip 18,162，包含 0 个引擎模块，仅动态引用 `echarts-runtime-BavVQwdy.js`。
- 动态引擎 chunk：850,502 字节 / gzip 239,169，包含 270 个 ECharts / zrender 模块；不在入口的递归静态依赖中。
- 上述大小是 ES 库探针产物，不是当前生产页面的新增大小。实际业务消费者上线后应重新检查其产物和首屏网络请求；脚本当前生产零引擎断言适用于本任务未接业务图表的阶段。

## 本地验证

- 生命周期 / Token / 动效 / 加载失败专项：13 passed / 2 files。继承回归旧代码实际失败（未指定系列被错误置为 true / 300ms），新代码保留 global false / 60 / 90、显式 true / 800 封顶 400；减少动效仍使全部系列 false / 0。
- `corepack pnpm --filter web test --maxWorkers=1`：527 passed / 45 files，0 skipped；单 worker，62.87 秒。
- 动效修复后 Web lint / build / typecheck、根 TypeScript、产物探针、独立 API URL（3 passed）、changed-format 测试（5 passed）通过。原提交的 frozen offline install 与根合同（40 passed）已通过，修复未改变依赖 / 锁 / 合同，未重复这两项；首次未生效的 cap 参数运行不作为最终单 worker 证据。
- 不涉及 API / Worker / DB / Config / Contracts 源码、Legacy 源码或迁移；这些模块完整套件及 Legacy 构建 / server unit 未在本任务重复运行，CI 继续执行其配置的基线。

## 回滚

回滚本 PR 即移除 Neo 封装、开发预览和 Web 依赖 / 根锁记录；没有数据库、API、业务任务或 Legacy 依赖变化。
