# Neo ECharts 6 基础封装

关联 Issue：#198。对应重构方案 P3 和方向七的按需图表封装；业务统计接线由后续任务完成。

## 使用边界

- Web 固定 `echarts@6.1.0`，Legacy 根包仍是 `echarts@5.6.0`；只有根 `pnpm-lock.yaml`。
- `NeoChart` 接收实际调用者的 `option`、可读 `label` 及 `loading` / `error` / `empty`。空态必须由调用者根据真实数据决定，不从图形或零数值猜测。
- 本基础封装仅支持平铺的 Line / Bar / Pie 选项；公共类型排除 `baseOption`、时间线 `options` 和响应式 `media` 多配置容器，运行时也拒绝绕过类型传入的容器，显示局部错误反馈。需要这些复杂配置时应先为其合并和动效策略建立独立支持，不能经由嵌套配置绕过减少动效或时长限制。
- 只有可绘制的挂载会动态导入引擎。官方 core 按需注册 Line / Bar / Pie、Grid / Tooltip / Legend / Aria 和 SVGRenderer，不导入 ECharts 全量入口。
- 配色读取 Neo CSS Token；显式系列颜色可用于业务状态。标签和说明应由业务调用者提供，开发示例不能作为业务数据源。
- 仅设置文字字体或字号仍保留 Token 的文字颜色，明确提供 `textStyle.color` 时才覆盖；选项与传入对象不被修改。绘制 host 保持在可访问树中，ECharts AriaComponent 生成的 `role="img"` 和数据描述可被读屏发现；外层 figure 的调用者标签继续覆盖加载、空态和错误的说明。
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

这些原提交证据覆盖开发图表的真实绘制和反馈，不能作为本轮 ARIA 修复的证据；本轮另外核验实际引擎生成的读屏描述。尚未接业务统计，不能替代生产 15 页面完整验收。

本轮 Review 修复的实际 IAB 验证（普通追加修复提交前的当前源码）：

- 三个真实 ECharts host 均生成 `role="img"`，中文完整 `aria-label` 包含系列和数值，没有 `aria-hidden` 或 `hidden` 祖先；点击更新后三个描述随数据同步变化。
- 1440×1000 的三个 SVG 均为 374×260；390×844 均为 293×260，两个视口均没有横向溢出。
- 切换无数据时旧图表 host、`role="img"` 和数据描述全部移除，只保留空态图标 SVG；恢复有数据重新生成三个真实 host。根代理已关闭 tab 并恢复 viewport，预览服务器随后停止。
- 本地截图未提交：`C:/Users/Admin/.codex/visualizations/2026/10/02/01a0fcfb-30a4-7fd3-9f52-b687920a7b97/echarts-current-aria-desktop.png`、`C:/Users/Admin/.codex/visualizations/2026/10/02/01a0fcfb-30a4-7fd3-9f52-b687920a7b97/echarts-current-aria-mobile.png`。

## 生产产物证据

基础封装交付时，`corepack pnpm --filter web exec node scripts/chart-build-evidence.mjs` 读取实际 Vite / Rollup 模块图：先构建生产应用，再在临时目录构建一个仅导出真实 NeoChart 的 ES 库消费者。下列数字属于该阶段的历史证据。Issue #200 已把该脚本改为验证真实 Home 生产消费者、动态引擎和入口的静态依赖；当前接线与产物记录见 [Home 工作台](phase-3-home-workspace.md)。构建仍在内存生成产物，不修改生产入口，不包含虚构业务数据。

- 当前生产应用：33 个 JavaScript chunk，ECharts / zrender 模块数为 **0**，因为 DEV 路由被裁剪。此阶段没有新增生产首屏图表下载。
- 本轮实际消费者探针：入口 `neo-chart-probe.js` 为 93,236 字节 / gzip 18,261，包含 0 个引擎模块，仅动态引用 `echarts-runtime-BavVQwdy.js`。
- 动态引擎 chunk：850,502 字节 / gzip 239,169，包含 270 个 ECharts / zrender 模块；不在入口的递归静态依赖中。
- 上述大小是当时的 ES 库探针产物，不是 Home 实际消费者的新增大小。原生产零引擎断言只适用于基础封装尚未接业务的阶段，已由 Issue #200 的实际生产动态分包断言替代。

## 本地验证

- 本轮 Review 回归：20 passed / 2 files；单独运行后续生命周期用例 1 passed / 18 filter-skipped，shuffle seed 13724 的完整图表专项 20 passed。每例重建模块和 mock 导入 gate，默认可立即完成，只有晚到模块场景明确保持未完成；失败时 teardown 也释放 gate，避免依赖先前用例解锁。
- 原 source 的新增 Review 回归实际 7 failed / 13 passed；独立生命周期用例原实现失败；三个类型边界的 `@ts-expect-error` 原实现均为 unused 错误，新类型检查通过。本轮 frozen offline install、Web typecheck 和 lint 已通过。
- 本轮 `corepack pnpm --filter web test --maxWorkers=1`：534 passed / 45 files，0 skipped；单 worker，39.65 秒。本次运行与另一工作树 #187 的部分 API 验证重叠，发现后立即停止新增重任务，当前测试正常完成且没有放宽超时或性能阈值；构建和产物探针等待其重套件槽释放后执行。
- 本轮 Web lint / typecheck / build、根 TypeScript、根合同（40 passed / 0 skipped）、独立 API URL（3 passed）、changed-format 测试（5 passed）及全部 PR 文件 Prettier / diff-check 通过。build 保留既有 >500KB 主包 warning，未放宽阈值；等后台重槽释放后串行完成 build 和最新产物探针，实际模块图如上，ARIA 浏览器核验使用本轮源码。
- 保留此前普通提交 6cc729d 的全局动效继承修复及回归：旧代码错误地把未指定系列置为 true / 300ms，新代码保留 global false / 60 / 90、显式 true / 800 封顶 400；减少动效仍使全部系列 false / 0。此前 527 个完整 Web 测试和 c65221a 的浏览器截图为历史证据，本轮数字独立记录。
- 不涉及 API / Worker / DB / Config / Contracts 源码、Legacy 源码或迁移；这些模块完整套件及 Legacy 构建 / server unit 未在本任务重复运行，CI 继续执行其配置的基线。

## 回滚

回滚本 PR 即移除 Neo 封装、开发预览和 Web 依赖 / 根锁记录；没有数据库、API、业务任务或 Legacy 依赖变化。
