# Annotation Callout (优雅图注与边注)

**适用场景：** 架构图或数据图中的手写体重点小注（Editorial Aside / Marginalia），如 *"零配置自动装配"*, *"关键防重入锁"*。

## 1. 语法与 SVG 结构

```svg
<!-- 1. 倾斜手写体文字 (LXGW WenKai / 霞鹜文楷) -->
<text x="904" y="36" fill="#2d3142" font-size="14" font-style="italic"
      font-family="'LXGW WenKai', 'LXGW WenKai', serif" text-anchor="end">无配置·纯原生流式响应</text>

<!-- 2. 贝塞尔曲线指引虚线 (Dashed Bézier Leader) -->
<path d="M 820 44 Q 700 84 520 216" fill="none"
      stroke="rgba(45,49,66,0.40)" stroke-width="1" stroke-dasharray="4,3"/>

<!-- 3. 落点小圆点 (Landing Dot) -->
<circle cx="520" cy="216" r="2.5" fill="#2d3142"/>
```

## 2. 颜色搭配

| 语义意图 | 文字颜色 (`fill`) | 指引虚线 (`stroke`) |
| :--- | :--- | :--- |
| **中性说明 (Neutral Aside)** | `#2d3142` (Ink) | `rgba(45, 49, 66, 0.40)` |
| **核心焦点 (Focal Accent)** | `#eb6c36` (Coral) | `rgba(235, 108, 54, 0.50)` |
| **次要弱化 (Muted Aside)** | `#4f5d75` (Muted) | `rgba(45, 49, 66, 0.30)` |

## 3. 使用规则与反模式

- **位置分布**：放置在图表的留白边缘（如右上角、左下角），严禁直接落在密集的连线或节点上方。
- **数量限制**：全图建议 **≤2 处**，仅用于画龙点睛。
- **反模式**：
  - 使用实线箭头当指引线（容易被误读为数据流箭头）。
  - 用普通等宽或无衬线字体代替文楷手写体（丧失边注的人文调性）。
