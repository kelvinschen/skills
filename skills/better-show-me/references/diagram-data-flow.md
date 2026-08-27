# Data Flow (管道与数据流图)

**适用场景：** 数据流水线、消息生产/消费链路、ETL 批流处理、跨角色/职责的数据流转与访问边界。

## 1. 结构与参数契约

数据流图通常由**横向角色泳道 (Lanes)** 与**纵向处理阶段 (Steps)** 构成的二维矩阵：

```yaml
lanes:                              # 横向职责泳道 (从上到下，通常 2~4 条)
  - { name: ["DATA", "ADMINS"],     key: "ADM" }
  - { name: ["DATA", "ENGINEERS"],  key: "ENG" }
  - { name: ["DATA", "SCIENTISTS"], key: "SCI" }
  - { name: ["DATA", "CONSUMERS"],  key: "CON" }

steps:                              # 纵向处理阶段 (从左到右，通常 3~6 步)
  - { number: "01", label: "COLLECT" }
  - { number: "02", label: "STORE" }
  - { number: "03", label: "TRANSFORM" }
  - { number: "04", label: "ANALYZE",  focal: true }   # 焦点阶段 (accent 填充)
  - { number: "05", label: "PUBLISH" }

nodes:                              # 单元格内具体处理节点
  - { lane: "ENG", step: 0, title: "Source Ingest",   sub: "ext. sources → raw", tool: "NiFi · SFTP" }
  - { lane: "ENG", step: 1, title: "Raw Store",       sub: "landing bucket",     tool: "MinIO raw" }
  - { lane: "ENG", step: 2, title: "Clean & Stage",   sub: "raw → table",        tool: "Trino ETL" }
  - { lane: "SCI", step: 3, title: "Explore & Model", sub: "model training",     tool: "JupyterHub", focal: true }

arrows:                             # 数据流转连线
  - { from: {lane: "ENG", step: 0}, to: {lane: "ENG", step: 1}, style: "muted" }
  - { from: {lane: "ENG", step: 1}, to: {lane: "ENG", step: 2}, style: "muted" }
  - { from: {lane: "ENG", step: 2}, to: {lane: "SCI", step: 3}, style: "accent", label: "dataset" }
```

## 2. 布局与图元规范

- **泳道 (Lanes)**：
  - 左侧固定宽度的角色标识栏（`ADM`, `ENG`, `SCI` 等，使用 `JetBrains Mono` 8px 加粗）。
  - 泳道之间使用浅色虚线分割：`<line stroke="rgba(30,41,59,0.12)" stroke-dasharray="4,4"/>`。
- **阶段列 (Steps)**：
  - 顶部水平排列的序号与大写阶段名（如 `01 COLLECT`，使用 `JetBrains Mono` 9px）。
- **节点卡片 (Nodes)**：
  - 放置在对应泳道与阶段交叉网格内，尺寸通常为 130~160px 宽，52~64px 高。
  - 包含左上角角色 Tag、节点标题（`JetBrains Mono` 12px 600）、处理说明与工具栈标注。
- **连线 (Arrows)**：
  - 同一泳道内横向流动使用平直或正交圆角折线；跨泳道流动使用正交折线向下/向上接入。

## 3. 视觉焦点控制

- 焦点色（`accent` 橙色 `#d9531e`）全图限 **1~2 处**（如核心分析阶段 Step Header、跨泳道的核心数据交接节点或关键流转连线）。

## 4. 示例产物

- SVG 几何示例：[`assets/diagrams/example-data-flow.svg`](../assets/diagrams/example-data-flow.svg)
