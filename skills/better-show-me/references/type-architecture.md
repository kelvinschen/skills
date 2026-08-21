# Architecture (系统与服务架构拓扑)

**适用场景：** 系统全景图、微服务调用拓扑、集成网关、基础设施部署分区与网络通信边界。

## 1. 布局与分组规范

- **层级与边界分区**：
  - 按技术分层或安全信任边界（如 Frontend → Gateway → Backend → Storage；Public → Private VPC）从左至右或从上至下分组。
  - 使用区域边框（Zone / Region）圈定同一层级：`<rect rx="8" fill="rgba(45,49,66,0.02)" stroke="rgba(45,49,66,0.18)" stroke-dasharray="6,4"/>`。
  - 区域标签放置在左上角纸张底色遮罩上，使用 `JetBrains Mono` 8px 大写标注。
- **绘制层级顺序 (Z-Order)**：
  1. 背景底色（`fill="#f5f5f5"`）
  2. 区域边界（Zone Rect）
  3. 连线层（连线必须先于节点绘制，避免压盖节点）
  4. 节点层（每个节点底部带有白色/纸色不透明遮罩）
  5. 文本与 Tag 标注层

## 2. 连线铁律 (Connector Rules)

- **强制正交圆角（Orthogonal Rounded Connectors）**：
  - 非水平/垂直同轴的节点之间，**严禁使用倾斜斜线**。必须使用 90° 直角圆角折线（`r=8`）：
  ```svg
  <!-- 水平转垂直再转水平折线 -->
  <path d="M x1,y1 H mid-8 Q mid,y1 mid,y1+8 V y2-8 Q mid,y2 mid+8,y2 H x2"
        fill="none" stroke="#4f5d75" stroke-width="1.2" marker-end="url(#arrow)"/>
  ```
- **文字遮罩与间距**：
  - 连线文字必须带不透明背景遮罩（`fill="#f5f5f5"`），且遮罩与连线之间保留 **6~10px** 间隙，严禁文字压住连线。
- **连线交叉与跳线 (Hop / Bridge)**：
  - 两条连线交叉时，次要连线使用半圆弧跨越：
  ```svg
  <!-- 水平跳线 -->
  <path d="M x1,y H cx-8 a 8,8 0 0,1 16,0 H x2"
        fill="none" stroke="#4f5d75" stroke-width="1.2" marker-end="url(#arrow)"/>
  ```
- **多连线锚点均匀分散**：
  - 同一节点同侧引出/接入多条连线时，锚点沿边缘均匀分布（间距 ≥12px），严禁共用单个端点。

## 3. 视觉焦点控制

- 焦点色（`accent` 橙色 `#eb6c36`）全图严格限制 **1~2 处**（如核心 API 入口、关键数据源或当前技术重构的核心服务）。
- 其余节点统一采用中性墨黑（`#2d3142`）描边、纯白底色或轻微半透明底色。

## 4. 反模式 (Anti-patterns)

- 多个服务节点都滥用橙色强调（层次感崩塌）。
- 连线使用直线斜角直连或文字穿透压盖连线。
- 节点过多未进行区域分组（超过 6 个节点应合理划分 Zone）。

## 5. 示例产物

- 参考示例：[`assets/example-architecture.html`](../assets/example-architecture.html)
