# P3-T1a 明快作业台组件基础

关联 Issue：#39。按总体计划 §7 的方向七落实设计变量与基础反馈组件，供后续页面迁移复用。这里的开发预览不代表业务页面或 P3 已迁移完成。

## 本阶段范围

- `apps/web/src/index.css`：奶油白背景、青柠主信号、独立的模块色与状态色、shadcn 语义变量、999/20/16/12/8 圆角阶梯、等宽数据字体、键盘焦点和减少动效规则。
- `apps/web/src/components/ui/`：原生按钮、输入框/文本域与表单字段、卡片、模块标记、状态胶囊、筛选 Chip、14px 进度、骨架和空态、成功提示。
- Motion 通过 `LazyMotion` 按需载入基础动画，提供首次挂载入场、数字更新、行变化脉冲和成功对勾；普通悬停/颜色/宽度变化使用 CSS。
- 仅开发模式注册 `/__dev/design-system`，用于真实组件交互与响应式验收。页面数据均为明确标注的虚构示例，任何按钮均不调用业务 API。

TanStack Table、ECharts、AppShell、命令面板、弹出层/Toast、登录叙事及各业务页面属于后续独立任务。此阶段未接通登录、权限路由或真实 ASIN 数据；旧前端仍是生产入口。

## 使用约定

所有组件直接按文件导入，避免无关组件进入路由依赖。原生控件由本项目持有，采用 shadcn 的语义主题和 CVA 变体方式；此阶段没有复制或引入复杂弹层组件。

```tsx
import { Button } from './components/ui/button';
import { Field, Input } from './components/ui/field';
import { Progress } from './components/ui/feedback';

<Field label="变体组名称" hint="使用容易辨认的名称" error={error} required>
  {(control) => <Input {...control} value={name} onChange={handleChange} />}
</Field>;
<Button type="submit" pending={saving}>
  保存
</Button>;
<Progress value={task.progress} label="导出任务" />;
```

- `Button` 默认 `type="button"`；提交表单必须显式传 `type="submit"`。`pending` 同时设置原生禁用和 `aria-busy`，避免重复触发。图标按钮必须传可理解的 `aria-label`。
- `Field` 的 render prop 返回稳定且唯一的控件 ID、错误/帮助描述关系和 required 属性；使用时完整传给 `Input`、`Textarea` 或原生 select。错误通过 `role="alert"` 宣告，业务页面负责验证和必要的错误焦点定位。
- `FilterChip` 使用 `aria-pressed` 表达选择，由调用方控制 `selected` 与回调，原生键盘行为不另行重写。
- `StatusBadge` 始终包含状态文字，图标不重复朗读；模块标记表达所在业务域，不表达成功或失败。
- `Progress` 对有限值限制到 0–100；缺失、NaN 或无穷值使用不确定状态且不设置 `aria-valuenow`，避免把未知进度报告成 0% 或完成。
- `Skeleton` 仅作视觉占位，调用方给容器设置 `role="status"` 与可理解的加载文案；未知结果不能用假业务数据代替。
- `SuccessNotice` 使用礼貌的状态宣告，不主动抢焦点。复杂 Toast 的队列、关闭与弹簧进出将在对应组件任务中实现。

## 动效接入

在应用层包一层 `MotionProvider`，页面通过 `Entrance` 包裹首屏分区；不要给每个长列表记录都设置入场动画。`index` 提供 40ms 错峰，最多延迟 200ms；入场本身为 200ms。Provider 默认弹簧过渡 350ms。

`AnimatedNumber` 在值变化时用 700ms 补间，只向屏幕阅读器提供最终值，非有限值显示未知。`UpdatePulse` 的 `revision` 在真实更新到达时变化，首次数据加载前省略该属性；脉冲 800ms。`SuccessMark` 对勾描边 400ms。

这些数字/实时反馈时长对应方案中单独规定的范围；普通交互过渡不超过 400ms。系统设置减少动态效果时，Motion 使用用户偏好，数字立即更新，入场/脉冲/描边与 CSS 循环/过渡停止。React 18 旧项目与 React 19 Neo 并存时，Provider 的子节点通过 React Fragment 构成元素边界，不改变根项目类型依赖。

## 本地预览与验收

在仓库根目录执行：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter web dev
```

打开 Vite 输出的本地地址并访问 `/__dev/design-system`。

1. 桌面及 390px 窄屏检查卡片、长文案、换行和横向溢出；页面随宽度由两列切为一列。
2. 用 Tab/Space/Enter 操作筛选和表单，检查焦点轮廓、空名称错误、成功提示和清空两个字段。
3. 模拟数据更新、推进/重置进度、切换骨架，确认未知进度与已知进度区分。
4. 在操作系统开启减少动态效果后重新访问，检查 CSS 循环、数字、行脉冲、入场和成功描边均停止；保持文字反馈。
5. 执行 `corepack pnpm --filter web test`、`lint`、`build`。生产构建的 `apps/web/dist/assets/*.js` 不应包含 `B0EXAMPLE01`、开发预览路径或组件预览页代码。

2026-09-06 本地浏览器已验证桌面/390px 布局、Space 筛选、Enter 提交、错误关系、双字段清空、进度和骨架切换，未见浏览器错误。24 项组件行为测试覆盖按钮防重复、表单关联、进度边界和非颜色状态表达；原有 136 项 Web 测试保留。当前浏览器工具未提供系统减少动效开关，步骤 4 的实际系统切换仍需人工验收，不能以静态代码检查替代。

## 风险与回滚

变量作用域只属于 Neo 样式入口；根项目继续使用 React 18/AntD，Neo 使用 React 19。新增 Motion 与 Lucide 依赖固定版本并记入根锁文件。后续页面引用组件时会增加对应生产 bundle，应按路由拆分并持续检查体积。

撤销本阶段提交即可移除组件、样式扩展和开发预览；没有数据库升级、API 地址或生产流量切换，现有请求/导出 URL 拼装测试仍必须通过。
