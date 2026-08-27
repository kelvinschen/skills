 
# Better Show Me 协作规则

在设计风格产生变更时，必须和用户同步。因为当前的Design Token 已经经过了验证，不能瞎改。

## Agent Benchmark

Benchmark 用于验证 skill 的可观察行为，按完整迭代批次执行，不跟随每个文字或 CSS 小改动。

适合执行的节点：

- 关系路由、原语系统或模板构图发生结构性变化后。
- 一组相关修改已经通过静态检查，准备判断该轮迭代是否成立时。
- 需要区分“skill 诱导”与“特定 agent 能力”时。

默认先选择一个真实请求和一个 one-shot agent；只有结果异常、准备结束重要里程碑，或需要归因时，才保持同一 prompt 增加第二个 agent。跨 agent 对照固定 skill 快照、任务、输入范围与交付格式，只替换执行器。

```bash
agy -p "<prompt>"
traecli exec "<prompt>"
```

概念题可在 prompt 中明确不读取仓库、不搜索网络，以隔离 skill 的组织能力。产物写入独立临时目录，并检查真实 HTML、首屏截图和页面结构；重点判断主关系是否闭环、每个辅助视图是否承载独有关系、是否泄漏模板元信息，以及页面高度和重复容器数量。措辞差异不作为 benchmark 结论。

Herdr 中与 agy 的持续对话适合探索方向和交换灵感；独立 benchmark 使用 one-shot 调用，避免历史上下文影响对照。
