# ACPX Capabilities

此技能应复用 acpx native capabilities，而不是在 local helper scripts 中重建它们。

## Native Command Matrix

| Need | Native acpx capability |
| --- | --- |
| Persistent multi-turn work | `acpx <agent> -s <name> "prompt"` |
| Idempotent session setup | `acpx <agent> sessions ensure -s <name>` |
| Fresh session | `acpx <agent> sessions new -s <name>` |
| One-shot task | `acpx <agent> exec "prompt"` |
| Prompt file or stdin | `-f <path>` 或 `-f -` |
| Agent-session async queueing | `--no-wait` |
| Cancel in-flight work | `acpx <agent> cancel -s <name>` |
| Session metadata | `acpx --format json <agent> sessions show <name>` |
| Recent/full output | `sessions history --limit <n>` 和 `sessions read --tail <n>` |
| Cleanup and portability | `sessions close/export/import/prune` |
| Permissions | `--approve-all`、`--approve-reads`、`--deny-all`、`--allowed-tools`、`--no-terminal` |
| Multi-agent workflow | 使用 `acpx/flows` 的 `acpx flow run <file>`；per-lane agent profiles 使用 `scripts/acpx-flow-run` |

## Status Boundary

`acpx <agent> status -s <name>` 报告 local queue owner 和 agent process health。它适合诊断 session owner 是否存在、是否存活，或是否没有 active session。

不要单独使用 `status` 作为某个特定 prompt turn 已完成的证明。对于 task output 和 completion evidence，优先使用 token-effective reads：

```bash
AGENT=trae
acpx --format json "$AGENT" sessions read --tail 3 impl
acpx --format json "$AGENT" sessions history --limit 5 impl
```

对于 long-running multi-step orchestration，优先使用 `acpx flow run`，它会把 run state、node outputs、traces 和 artifacts 记录到 `~/.acpx/flows/runs/<runId>/` 下。不要在受限 main-agent shell 中把 `acpx flow run` 当作 foreground long wait 使用。应以非阻塞方式启动长 flows，并监控 run bundle。

One-shot 和 named session prompts 应使用 `nohup` 包裹 acpx-native commands 后台启动，避免阻塞 main agent shell；通过 PID、log、compact session reads 和最终 repo/check state 跟踪。`--no-wait` 是 agent-session queueing，用于类似 `acpx <agent> --no-wait -s impl ...` 的 prompts，但本 skill 的标准启动模式仍是 `nohup ... &`。

## Token-Effective Tracking

不要直接 tail `.stream.ndjson`。它是 low-level event log，包含大量 protocol detail。Main-agent tracking 应使用 acpx projections 和 compact session reads。

Flow run status：

```bash
RUN=~/.acpx/flows/runs/<runId>
cat "$RUN/projections/live.json"
```

`live.json` 暴露 flow `status`、current node details 和 `sessionBindings`。当 binding 包含：

```json
{
  "handle": "impl",
  "agentName": "<agent>",
  "cwd": "/repo",
  "name": "simple-feature-impl-..."
}
```

读取该 agent 的 recent output：

```bash
AGENT=trae
acpx --cwd /repo --format json "$AGENT" sessions read --tail 3 simple-feature-impl-...
```

`sessions read --tail` 返回一个小 JSON envelope，其中 `entries[]` 包含 `role`、`timestamp` 和 `textPreview`。这通常足够 token-effective，能让 main agent 了解 progress，而无需 custom formatter。

对于 per-lane flow orchestration，使用 `scripts/acpx-flow-run` materialize static node profiles 并启动 workflow：

```bash
FLOW_LOG=/tmp/acpx-flow-simple-feature.log
FLOW_RUN_OUTPUT=$(scripts/acpx-flow-run simple-feature \
  --input-json "{\"task\":\"<user request>\",\"cwd\":\"$PWD\"}" \
  --log "$FLOW_LOG")
echo "$FLOW_RUN_OUTPUT"

RUN=$(printf '%s\n' "$FLOW_RUN_OUTPUT" | awk -F= '$1=="runDir"{print $2}')
LIVE=$(printf '%s\n' "$FLOW_RUN_OUTPUT" | awk -F= '$1=="live"{print $2}')
echo "run=$RUN"
[ -n "$LIVE" ] && cat "$LIVE"
```

Launcher 默认 background execution 和 flow-level `--approve-all`。Background launch output 包含 `pid`、`log`、`flow`、`input`、`command`，并在 startup lookup 成功时包含 `runLookup=matched`、`runId`、`runDir`、`manifest`、`live`、`runProjection`、`steps`、`trace`、`sessionsDir` 和 `artifactsDir`。Flow templates 提供默认 profiles。Input role fields 覆盖 template defaults，环境变量覆盖 input role fields。Flow input 可以设置 `handoffDir`；否则默认 handoff path 为 `<repo>/tmp/flow_handoffs/<runId>/<node>.md`，shared memory index 为 `<repo>/tmp/flow_handoffs/<runId>/flow-memory.md`。

`flows/examples/*.input.json` 只用于 smoke/demo，因为其 `task` 和 `cwd` 都是占位值。真实用户任务应使用 `--input-json` 或生成 task-specific input file，并显式传入当前 repo `cwd`。

```bash
PLAN_AGENT=aiden PLAN_REVIEW_AGENT=trae IMPLEMENT_AGENT=trae VALIDATE_AGENT=aiden \
  scripts/acpx-flow-run complex-feature-refactor \
    --input-json "{\"task\":\"<user request>\",\"cwd\":\"$PWD\"}"
```

如果 `runLookup=pending`，使用输出的 `runSearchRoot`、`runSearchFlow` 和 `runSearchFlowName` values，待 bundle 出现后定位它。只把 newest run directory 作为 fallback debugging aid。

随附 flow templates 指示每个 lane agent 写入自己的 handoff file，并向 `flow-memory.md` 追加 compact index entry。下游 prompts 接收 memory file 和 handoff files 的 compact references，而不是完整上游 agent output。监控时优先使用 flow outputs、`flowMemoryPath`、memory index 和 handoff paths；只有需要更深检查时才使用完整 session reads。
随附 flows 的 shared prompt wording 位于 `flows/shared/prompt-templates.ts`，shared handoff/path helpers 位于 `flows/shared/flow-helpers.ts`；在 individual flow templates 中复制通用 prompt 或 helper 逻辑前，先更新 shared files。

Active work 的 recommended polling cadence：

| Phase | Interval | Count |
| --- | ---: | ---: |
| Early long-task window | 120s | 2 |
| Narrowing window | 90s | 3 |
| Steady tracking | 60s | 4 |
| Extended tracking | 60s | repeat as needed |

每次 poll 时，读取 `live.json` 或相关 `sessions read --tail 3` output。默认不要以快于 60s 的频率 poll；只有用户明确需要 near-real-time monitoring 时才缩短。

### Named Session Tracking

对于普通 named sessions，用 `nohup` 后台启动 prompt，然后用 compact reads 跟踪：

```bash
REVIEW_AGENT=aiden
IMPLEMENT_AGENT=trae
LOG=/tmp/acpx-review.log
nohup acpx --cwd /repo "$REVIEW_AGENT" -s review --approve-reads --no-terminal \
  "Review 当前 diff，查找 bugs、regressions 和 missing tests。" >"$LOG" 2>&1 &
echo "pid=$! log=$LOG"
acpx --cwd /repo --format json "$REVIEW_AGENT" sessions read --tail 3 review
acpx --cwd /repo --format json "$IMPLEMENT_AGENT" sessions read --tail 3 impl
```

需要 short history index 时使用 `sessions history --limit 5`。只有明确需要 metadata 或 full messages 时才使用 `sessions show`；它比 `read --tail` 重得多。

对于低频 post-run audit reports，见 [audit-visualization.md](audit-visualization.md)。

## Recommended Patterns

### Simple Planning Or Review

```bash
REVIEW_AGENT=aiden
LOG=/tmp/acpx-review.log
nohup acpx "$REVIEW_AGENT" -s review --approve-reads --no-terminal --cwd /repo \
  "Review 当前 diff，查找 bugs、regressions 和 missing tests。" >"$LOG" 2>&1 &
echo "pid=$! log=$LOG"
acpx --cwd /repo --format json "$REVIEW_AGENT" sessions read --tail 3 review
```

### Bounded Implementation

```bash
IMPLEMENT_AGENT=trae
LOG=/tmp/acpx-impl.log
nohup acpx "$IMPLEMENT_AGENT" -s impl --approve-all --cwd /repo -f task.md >"$LOG" 2>&1 &
echo "pid=$! log=$LOG"
acpx --cwd /repo --format json "$IMPLEMENT_AGENT" sessions read --tail 3 impl
```

### One-Shot Bounded Stateless Task

```bash
AGENT=aiden
LOG=/tmp/acpx-one-shot-$AGENT.log
nohup acpx --cwd /repo "$AGENT" exec "总结当前 package structure。" >"$LOG" 2>&1 &
echo "pid=$! log=$LOG"
```

对于不需要 session continuity、flow artifacts 或 recovery routing 的 bounded stateless tasks，使用 `exec`，但仍用 `nohup` 后台启动，并通过 PID/log 跟踪 completion。

### Inspect Recent Output

```bash
AGENT=trae
acpx --format json "$AGENT" sessions read --tail 3 impl
```

### Flow Run

当 coding task 应通过 agents 委派时，选择 multi-complexity workflow。长 flow runs 应以非阻塞方式启动。不要依赖 foreground `--timeout` values 让执行时间超过 main agent 的 shell limit：

```bash
FLOW=quick-bugfix
FLOW_LOG=/tmp/acpx-flow-$FLOW.log
scripts/acpx-flow-run "$FLOW" \
  --input-json "{\"task\":\"<user request>\",\"cwd\":\"$PWD\"}" \
  --log "$FLOW_LOG"
```

`quick-bugfix` 是短 implementation 加 independent test lane。`simple-feature` 增加 planning、independent validation review，以及最多一轮 automatic fix。`complex-feature-refactor` 增加 plan review、independent validation review，以及最多两轮 automatic fix。这些 templates 都不使用 infinite loops。

Agent validation 是 quality signal，不是 live tracking mechanism。Feature-flow validation 在 independent validation lane 中运行，并具有与 run 其余部分相同的 flow-level permissions，因此其“do not edit production code in validation”规则依靠 prompt discipline 和 post-run audit 执行，而不是单独的 acpx permission boundary。完成后使用 `scripts/acpx-visualize` 检查 validation tools、commands、file writes 和 outputs。

随附 flows 会在调用 ACP agents 前创建 target `cwd`，因为 agent subprocesses 无法以缺失的 working directory 启动。
