 
# Better Show Me 协作规则

在设计风格产生变更时，必须和用户同步。因为当前的Design Token 已经经过了验证，不能瞎改。

## Agent Benchmark

Benchmark 用于验证 skill 的可观察行为，按完整迭代批次执行，不跟随每个文字或 CSS 小改动。

适合执行的节点：

- 关系路由、原语系统或模板构图发生结构性变化后。
- 一组相关修改已经通过静态检查，准备判断该轮迭代是否成立时。
- 需要区分“skill 诱导”与“特定 agent 能力”时。

基准题选择与当前改动样例无关的独立小机制，并提供冻结的中性事实而非现成说明文。默认参考题是 React 的一个 Suspense 边界如何通过 `renderToPipeableStream()` 完成 SSR：服务端生成 shell、挂起子树先输出 fallback、`onShellReady` 开始传输、子树完成后追加 segment 并替换 fallback。题目范围保持为一条主关系和少量独有辅助关系。

Benchmark 统一使用 Acpus 编排。每个 one-shot 执行器对应一个独立 Agent 节点；先通过 `acpus agent presets` 选择与任务匹配的 Preset，再由 `acpus workflow run` 注入。一次运行只安排一个真实请求和一个 Agent；结果异常、重要里程碑或需要归因时，才固定 skill 快照、prompt、输入范围和交付格式增加另一运行。

一次性 benchmark 使用 HEREDOC 工作流，产物写入独立临时目录；事实材料通过 workflow input、可见 artifact 或 Agent 可读路径传入。运行后先查看一次 Summary；未终止且无需输入时，对决定性目标使用一次 `--await-decision`。终止后查看 Timeline，并通过 `runs artifacts --target <agent>` 读取 `turn-<NNN>.json`；其中提供 `sessionProjectionPath` 时再读取 ACP session projection。Timeline 与 settled turn 构成基础 Agent trace，session projection 作为可用时的补充。观察期间不轮询，不以沉默、耗时或 token 用量触发干预。

Trace 重点观察 Agent 如何界定读者问题、读取 skill 与必要参考、选择主关系和原语、组织正文、使用工具与发生返工；产物继续检查真实 HTML、首屏截图和页面结构，判断主关系是否闭环、辅助视图是否承载独有关系、是否泄漏模板元信息，以及页面高度和重复容器数量。措辞差异不单独作为 benchmark 结论。

概念题可在 prompt 中明确输入边界与网络范围，以隔离 skill 的组织能力。独立 benchmark 保持 one-shot，避免历史上下文影响对照。
