# Architecture (系统与服务架构拓扑)

**适用场景：** 系统全景图、微服务调用拓扑、集成网关、基础设施部署分区与网络通信边界。

## 1. 布局与分组规范

- **层级与边界分区**：
  - 按技术分层或安全信任边界（如 Frontend → Gateway → Backend → Storage；Public → Private VPC）从左至右或从上至下分组。
  - 使用区域边框（Zone / Region）圈定同一层级：`<rect rx="8" fill="rgba(45,49,66,0.02)" stroke="rgba(45,49,66,0.18)" stroke-dasharray="6,4"/>`。
  - 区域标签放置在左上角，使用 `JetBrains Mono` 8px 大写标注。
- **绘制层级顺序 (Z-Order)**：
  1. 背景底色（`fill="#f4f5f7"`）
  2. 区域边界（Zone Rect）
  3. 连线层（连线必须先于节点绘制，避免压盖节点）
  4. 节点层（白底矩形卡片）
  5. 文本与 Tag 标注层

## 2. 连线铁律 (Connector Rules)

- **强制正交圆角（Orthogonal Rounded Connectors）**：
  - 非水平/垂直同轴的节点之间，**严禁使用倾斜斜线**。必须使用 90° 直角圆角折线（`r=8`）：
  ```svg
  <!-- 水平转垂直再转水平折线 -->
  <path d="M x1,y1 H mid-8 Q mid,y1 mid,y1+8 V y2-8 Q mid,y2 mid+8,y2 H x2"
        fill="none" stroke="#4f5d75" stroke-width="1.2" marker-end="url(#arrow)"/>
  ```
- **连线文字标注**：
  - 文字直接置于水平/垂直连线上方或侧方 4~6px（`text-anchor="middle"`），保持文字与连线分离。
- **连线交叉与跳线 (Hop / Bridge)**：
  - 两条连线交叉时，次要连线使用半圆弧跨越：
  ```svg
  <!-- 水平跳线 -->
  <path d="M x1,y H cx-8 a 8,8 0 0,1 16,0 H x2"
        fill="none" stroke="#374151" stroke-width="1.2" marker-end="url(#arrow)"/>
  ```
- **多连线锚点均匀分散**：
  - 同一节点同侧引出/接入多条连线时，锚点沿边缘均匀分布（间距 ≥12px），端点清晰独立。

## 3. 视觉焦点控制

- 焦点色（`accent` 橙色 `#d9531e`）全图严格限制 **1~2 处**（如核心 API 入口、关键数据源或当前技术重构的核心服务）。
- 其余节点统一采用中性墨黑（`#1d2129`）描边、纯白底色或轻微半透明底色。

## 4. 节点与区域规模建议

- 单图节点数建议控制在 4~8 个内，超过 6 个节点时合理使用 Zone 区域分组。

## 5. 示例产物

- 参考示例：[`assets/example-architecture.html`](../assets/example-architecture.html)
