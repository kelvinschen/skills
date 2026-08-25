# Annotation Callout (优雅图注与边注)

**适用场景：** 架构图或数据图中的手写体重点小注（Editorial Aside / Marginalia），如 *"零配置自动装配"*, *"关键防重入锁"*。

## 1. 语法与 SVG 结构

```svg
<!-- 1. 倾斜手写体文字 (LXGW WenKai / 霞鹜文楷) -->
<text x="904" y="36" fill="#1d2129" font-size="14" font-style="italic"
      font-family="'LXGW WenKai', 'LXGW WenKai', serif" text-anchor="end">无配置·纯原生流式响应</text>

<!-- 2. 贝塞尔曲线指引虚线 (Dashed Bézier Leader) -->
<path d="M 820 44 Q 700 84 520 216" fill="none"
      stroke="rgba(30,41,59,0.40)" stroke-width="1" stroke-dasharray="4,3"/>

<!-- 3. 落点小圆点 (Landing Dot) -->
<circle cx="520" cy="216" r="2.5" fill="#1d2129"/>
```

## 2. 颜色搭配

| 语义意图 | 文字颜色 (`fill`) | 指引虚线 (`stroke`) |
| :--- | :--- | :--- |
| **中性说明 (Neutral Aside)** | `#1d2129` (Ink) | `rgba(30, 41, 59, 0.35)` |
| **核心焦点 (Focal Accent)** | `#d9531e` (Coral) | `rgba(217, 83, 30, 0.40)` |
| **次要弱化 (Muted Aside)** | `#374151` (Muted) | `rgba(30, 41, 59, 0.25)` |

## 3. 使用规范

- **位置分布**：放置在图表的留白边缘（如右上角、左下角），与主体节点保持视觉呼吸感。
- **指引线规范**：使用纤细的贝塞尔虚线（`stroke-dasharray="4,3"`）配合落点圆点，与实线数据流形成明确区隔。
- **数量建议**：全图建议 **≤2 处**，仅用于画龙点睛的编辑小注。
