---
name: better-show-me
description: 通过紧凑的代码形态、直观的辅助图表与聚焦的 HTML 页面，帮助用户以可视化方式理解当前的技术方案、系统架构、逻辑流转与重构决策。
---

通过聚焦的自包含 HTML 单文件为用户可视化呈现代码形态、架构分层、运行时调用流及变更 Diff。**只产出独立 HTML 文件**，生成后选择合适的方式（如 open / xdg-open / start 或静态 server）展示。代码形态为主视觉，图表为辅助配角。

## 代码结构与架构形态 (核心主视觉)

- **算法与业务逻辑（伪代码）**：用缩进文本展现分支与算法步骤，省略冗余语法：
```text
on(save)
  if content is unchanged
    return cached result
  write new content
  invalidate cache
  return fresh result
```

- **运行时控制流（调用树）**：用缩进体现执行顺序与调用栈：
```text
submitForm
  createSession
    persistPrompt
    launchAgent
  navigateToSession
    subscribeToEvents
```

- **UI 结构与状态边界（组件树）**：标注组件层级、文件归属与核心 Hook/状态：
```tsx
<SessionPage> (apps/example/src/routes/session.tsx)
  useSessionEvents()
  <SessionToolbar>
    <RunSkillButton> (packages/ui)
  <SessionTimeline>
    <SkillResultCard>
```

- **模块职责与目录边界（浅层文件树）**：仅列关键文件并标注职责注释：
```text
src/
├── commands/       # 解析并扩展用户指令
├── sessions/       # 负责会话生命周期与状态持久化
└── transport/      # 底层 API 与 SSE 流式通信
```

- **局部增量演进（Diff 模式）**：用 `+` / `-` 聚焦改动点，形态精准匹配主题（组件、目录树、调用栈或状态变更）：
```diff
 <SessionToolbar>
+  <RunSkillButton />
```

- **完整实现（代码块）**：仅在全新实现或用户需要完整可复制内容时展示。

- **表达指导准则 (Guidance)**：
  - **真实数据与文案**：使用真实业务标签、函数名与数据，杜绝 `foo`/`bar`/`Lorem ipsum` 占位符。
  - **适度克制**：聚焦当前核心问题，单页选取最匹配的 1~2 种形态即可，切忌堆砌造成认知过载。

## 视觉与排版美学规范

- **字体与微排版 (Typography)**：
  - 标题/展示：`LXGW WenKai`（大标题 H1 收紧字距 `-0.02em` 与行高 `1.15~1.2`）
  - 正文/叙述：`Noto Sans` + `Noto Sans SC`（行高 `1.55~1.6`，文本左对齐，数值与金额右对齐）
  - 代码/等宽：`JetBrains Mono`（代码形态、调用树；微型 Tag 全大写并放宽字距 `0.12~0.18em`）
- **色彩与材质 (Palette & Surface)**：
  - 纸张底色：`paper` (`#f5f5f5` 主画布)、`paper-card` (`#ffffff` 卡片)、`paper-code` (`#f0f1f3` 代码底色)
  - 墨色与线条：`ink` (`#2d3142` 正文与主边框)、`muted` (`#4f5d75` 次要文字与连线)、`soft` (`#7a8399` 辅助弱化)
  - 焦点克制：`accent` (`#eb6c36` 珊瑚橙，全图严格限制 1~2 处)、`accent-tint` (`rgba(235, 108, 54, 0.08)`)
  - 外部与状态：`link` (`#2e5aa8` API/调用)、`diff-add` (`#1e7e34` 新增)、`diff-del` (`#c82333` 删除)、`warn` (`#b86a04` 警告)
- **几何与空间秩序 (Geometry & Space)**：
  - 4px 栅格：所有坐标、宽高、Padding、Margin 均为 4 的倍数；卡片圆角 6px，标签圆角 2~4px。
  - 弃用阴影：禁用 `box-shadow`，统一以 1px 细线边框 + 微弱底色差表达层级。
  - 亲密性间距：标题距下方内容间距必须显著小于与上方模块的间距。
  - 呼吸间隙：连线文字必须带不透明背景遮罩并与连线保留 6~10px 间距，严禁线条穿透文字。

## 模板与图表路由

- **基础 HTML 模板与示例**（存放于 [`assets/`](assets/)，生成时按需读取并填充）：
  - 综合模板（代码+Diff+辅助图表+卡片，默认主力）：[`assets/template-show-me.html`](assets/template-show-me.html)
  - 纯图表视图模板：[`assets/template-diagram.html`](assets/template-diagram.html)
  - 参考示例：各图表代表性实现参见 `assets/example-*.html`（如 [`assets/example-architecture.html`](assets/example-architecture.html) 等）。
- **辅助图表与图元索引**（存放于 [`references/`](references/)，绘制 Inline SVG 时按需读取）：
  - 系统组件拓扑：[`references/type-architecture.md`](references/type-architecture.md)
  - 多实体时序交互：[`references/type-sequence.md`](references/type-sequence.md)
  - 逻辑分支与流程：[`references/type-flowchart.md`](references/type-flowchart.md)
  - 状态机与生命周期：[`references/type-state.md`](references/type-state.md)
  - 实体模型与表结构：[`references/type-db-schema.md`](references/type-db-schema.md)
  - 管道数据流转：[`references/type-data-flow.md`](references/type-data-flow.md)
  - 常用技术图标库 (SVG)：[`references/primitive-icons.md`](references/primitive-icons.md)
  - 优雅图注注释 (Callout)：[`references/primitive-annotation.md`](references/primitive-annotation.md)
- **辅助脚本工具**（存放于 [`scripts/`](scripts/)）：
  - 自检工具：`python3 scripts/self_check.py <file>`（验证生成 HTML 的单文件安全性与可访问性）。
  - Mermaid 提取器：`python3 scripts/mermaid_extract.py <input>`（辅助从现有 Mermaid 代码提取结构）。

## 执行工作流

1. **提炼核心**：识别核心矛盾与主线，确定代码形态与 1~2 处 `accent` 橙色焦点。
2. **构建主视觉**：选取伪代码、调用树、组件树、文件树或 Diff 模式直观表达。
3. **选配图表（可选）**：若拓扑/时序复杂，按需加载对应 `references/type-*.md` 绘制轻量 Inline SVG。
4. **生成文件**：读取 [`assets/template-show-me.html`](assets/template-show-me.html) 填充内容，保存为 `show-me-{topic}.html`（可运行 `python3 scripts/self_check.py` 验证）。
5. **交付展示**：根据运行环境选择合理方式展示页面，并在对话中附带文件链接与 1~2 句结论。
