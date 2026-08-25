# Database Schema & Data Model (表结构与数据模型)

**适用场景：** 实体关系模型（ER）、物理数据库表结构、SQL 字段类型、主外键约束（FK）、级联删除与核心索引展示。

## 1. 表结构布局与图元规范

- **表结构卡片 (Table Box)**：
  - 宽度通常为 200~240px，底色 `#ffffff`，圆角 `rx=6`，边框 `1px solid #1d2129`。
  - **表头 (Header)**：包含 Schema 及表名（如 `public.orders`，字号 12px 600 `JetBrains Mono`），配以右上角 `TABLE` 标识。
  - **字段行 (Column Rows)**：每行高度固定为 24px。
    - 左侧：字段名（`JetBrains Mono` 11~12px）。
    - 中间：约束 Tag（`PK`, `FK`, `NN`, `UQ`，使用 `JetBrains Mono` 7~8px `rx=2` 小标签）。
    - 右侧：SQL 类型（`uuid`, `text`, `bigint`, `timestamptz`，使用 `JetBrains Mono` 9px `var(--color-muted)`）。
    - 奇偶行使用微弱底色交替（偶数行 `rgba(30,41,59,0.02)`）增强可读性。
  - **超出字段截断行**：超过预算时，末行注明 `+ N more columns`，严禁无提示截断。
  - **索引分栏 (Indexes)**：底部分隔线下方可简要列出关键索引（如 `idx_orders_customer_id`）。

## 2. 外键关系连线 (Foreign Key Connectors)

- **行对行精准锚定**：
  - 外键连线从源表具体字段行的垂直中心引出，精确连接到目标表主键行的垂直中心。
  - 连线使用正交圆角折线（`r=8`），标注级联动作（如 `ON DELETE CASCADE`、`ON DELETE RESTRICT`），字号 8px `JetBrains Mono`。
  - 当多个外键连接到同一行时，端点沿行垂直中心对称偏移（如 ±8px），避免线头重叠。

## 3. 视觉焦点控制

- 焦点色（`accent` 橙色 `#d9531e`）全图限 1~2 处，通常用于：
  1. 核心业务主表（仅表头高亮 `accent-tint`）。
  2. 关键级联动作（如 `ON DELETE CASCADE` 连线与标签）。

## 4. 复杂度与建模建议

- 单图表数建议 ≤5 张，每表精选核心业务字段（≤8 行），重点展示关键外键关系。
- 外键连线从源字段垂直中心直接引出至目标字段中心。

## 5. 示例产物

- 参考示例：[`assets/example-db-schema.html`](../assets/example-db-schema.html)
