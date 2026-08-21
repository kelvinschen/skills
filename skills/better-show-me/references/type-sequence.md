# Sequence (时序交互图)

**适用场景：** 请求/响应往返、服务间协议交互、时序事件流、OAuth2/JWT 认证流程、分布式事务流转。

## 1. 布局与图元规范

- **参与者 (Actors)**：
  - 顶部水平排列的矩形卡片（`rx=6`，高 36~44px，底色 `#ffffff`，描边 `1px solid #2d3142`）。
  - 主标签居中 12px 600（`JetBrains Mono`），副标签 9px（`JetBrains Mono`）。
- **生命线 (Lifelines)**：
  - 从每个参与者底部中心向下垂直延伸的虚线：`<line stroke="rgba(45,49,66,0.20)" stroke-dasharray="3,3"/>`。
- **激活条 (Activation Bar)**：
  - 在生命线上方覆盖的细长矩形（宽 8px，居中覆盖生命线，`rx=2`，底色 `rgba(45,49,66,0.06)`，描边 `#4f5d75` 0.8px），表示该实体持有控制权的处理区间。
- **消息箭头类型**：
  - **同步调用 (Sync Call)**：实线箭头，水平指向目标生命线。
  - **返回消息 (Return)**：**虚线** + **实心箭头**（`stroke-dasharray="4,3"`），从右向左返回。
  - **异步消息 (Async / Fire-and-Forget)**：虚线 + **空心箭头**（Open Arrowhead）。
  - **自调用 (Self Message)**：U 型弯折返回自身生命线。
- **消息文本标注**：
  - 消息文字直接居中放置在箭头线上方 4~6px（如箭线位于 `y="105"`，则文本设置 `y="99"`，`text-anchor="middle"`）。

## 2. 条件分支片段 (Combined Fragment: `alt` / `opt` / `loop`)

- 当时序存在分支判断（如 Token 有效 vs 过期、重试循环）时，使用**分支框架 (Fragment Frame)**：
  - 浅色半透明背景矩形包裹参与分支的生命线（`fill="rgba(45,49,66,0.02)" stroke="rgba(45,49,66,0.22)"`）。
  - 左上角操作符标签（如 `ALT`、`OPT`、`LOOP`，使用 `JetBrains Mono` 8px）。
  - `alt` 多分支使用虚线水平分割线分隔，并注明 Guard 守卫条件（如 `[token valid]` 与 `[else]`）。

## 3. 视觉焦点控制

- 焦点色（`accent` 橙色 `#d9531e`）全图限 **1~2 处**，通常用于：
  - 核心成功返回链路（Headline Happy-Path Return）。
  - 当前需要特别强调的关键鉴权/业务回调。

## 4. 复杂度与流向建议

- 参与者数建议 ≤5 个，交互消息数 ≤12 条，分支片段 ≤1 个。
- 交互时间线严格保持从上至下线性流动。

## 5. 示例产物

- 参考示例：[`assets/example-sequence.html`](../assets/example-sequence.html)
