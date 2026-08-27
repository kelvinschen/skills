# UML Class Diagram（UML 类图）

**适用场景：** 展示对象模型的静态结构：类拥有的属性与操作、继承/实现关系，以及对象之间的拥有、关联和依赖。

**独有关系：** Operations compartment 与带类型语义的关系端点。若问题只涉及实体、字段与基数，使用 ER；若需要 SQL 类型、主外键和索引，使用 Database Schema。

## 1. 类框与成员区

- 一个类使用单个圆角矩形，由横向 hairline 分为最多三段：名称、属性、操作。各段高度随内容决定，不为对齐而填充空白。
- 名称居中；接口在名称上方增加 `.mono` 的 `«interface»`，抽象类名称使用斜体。
- 属性使用 `.mono` 左对齐：`+ name: Type`；操作使用 `.mono` 左对齐：`+ method(arg): Return`。
- 可见性固定为 `+` public、`-` private、`#` protected。没有内容的属性或操作区直接省略。
- 属性与类型写在同一行，不能画成 ER/数据库表常见的字段—类型双列。

## 2. 关系词汇

| 关系 | 线型 | 目标 / 所有者端点 |
| --- | --- | --- |
| Inheritance（extends） | 实线 | 空心三角 |
| Realization（implements） | `5,4` 虚线 | 空心三角 |
| Composition（生命周期绑定） | 实线 | 所有者端实心菱形 |
| Aggregation（可独立存在） | 实线 | 所有者端空心菱形 |
| Association | 实线 | 开放箭头；两端标基数 |
| Dependency（uses） | `4,3` 虚线 | 开放箭头 |

- 关系先于类框绘制；优先直线或单次正交圆角转折，多个锚点间距 ≥12px。
- 基数（`1`、`0..*`、`1..*`）贴近对应类框边缘，并与连线错开 4~8px；空间不足时移动锚点或拆开线段留出真实间隙，不使用不透明底色遮线。
- 焦点色用于正在实现/扩展的类；其同组入站实现边可以同时强调，其他关系保持中性。

## 3. 复杂度预算与反模式

- 单图最多 7 个类、8 条关系；每个 compartment 最多 5 个成员，溢出用 `…`，常规目标为 4～5 个类。
- 关系过多时按 package 拆图，不用大量跳线维持一张“全量模型”。
- 不罗列 getter/setter 或完整头文件；只保留支撑当前结论的属性与行为。
- Composition 表示部件随整体销毁，不能与 Aggregation 互换。
- Association 不省略基数；没有操作且不关心 UML 关系词汇时，不使用类图。
- 图例应展示本图采用的端点词汇；需要把示例当作完整语法参考时，可列出全部六种关系。

## 4. 示例产物

- SVG 几何示例：[`assets/diagrams/example-uml-class.svg`](../assets/diagrams/example-uml-class.svg)
