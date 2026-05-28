# Agent Routing

Orchestrator 负责 product judgment、decomposition、status 和 final acceptance。Specialist agents 负责有界 work packets。

## Lanes

Planning lane：

- Purpose：将模糊的 user intent 转换为 implementation plan。
- Agent：任何适合 planning 的 registered acpx agent。
- Example：`aiden`。
- Permissions：`--approve-reads --no-terminal`。
- Required output：target behavior、可能涉及的 files/modules、risks、test plan。

Implementation lane：

- Purpose：应用已接受的 code changes。
- Agent：任何适合 code edits 的 registered acpx agent。
- Example：`trae`。
- Permissions：scope accepted 后使用 `--approve-all`。
- Required output：change summary、tests run、unresolved issues。

Review lane：

- Purpose：发现 regressions、missed requirements、unsafe edits 和 missing tests。
- Agent：任何适合 review 的 registered acpx agent。
- Example：`aiden`。
- Permissions：`--approve-reads --no-terminal`。
- Required output：findings first，按 severity 排序，并包含 file references。

Verification lane：

- Purpose：运行 tests/builds 并收集 final evidence。
- Preferred agent：与 implementation lane 相同。
- Orchestrator 仍必须直接检查 final git state。

## Prompt Contracts

Planning prompt 必须包含：

- User request。
- 已发现的 relevant repo facts。
- Constraints：no edits、no commands that mutate tracked files、concise plan。

Implementation prompt 必须包含：

- Accepted plan。
- 精确 scope 和 out-of-scope items。
- 只编辑 necessary files 的 permission。
- 不得 revert unrelated user changes 的要求。
- 需要运行的 verification commands。

Review prompt 必须包含：

- Intended behavior summary。
- Current diff 或检查 current working tree 的 instructions。
- 优先关注 bugs 和 regressions，而非 style 的要求。

## Parallelism

只有工作彼此独立时才使用 parallel agents：

- 一个 planning lane 可检查 architecture，另一个可总结 tests。
- 每个 disjoint subsystem 最多一个 implementation lane。
- 永远不要让两个 implementation agents 同时编辑相同 files。
- Review 在 implementation 后运行，不要与 writes 并发。

## Stop Conditions

出现以下情况时，停止 delegating 并收回控制：

- Agent 询问 product intent。
- 同一 lane 连续两次 prompts 失败。
- Agent 想把 scope 扩大到 accepted plan 之外。
- Working tree 出现 unexpected unrelated edits。
