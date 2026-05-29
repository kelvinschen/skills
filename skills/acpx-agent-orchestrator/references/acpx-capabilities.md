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
| Agent-friendly state tracking | `scripts/acpx-inspector sessions/snapshot/read/diagnose/follow` |

## Status Boundary

`acpx <agent> status -s <name>` 报告 local queue owner 和 agent process health。它适合诊断 session owner 是否存在、是否存活，或是否没有 active session。

不要单独使用 `status` 作为某个特定 prompt turn 已完成的证明。对于 task output、progress 和 completion evidence，优先使用 inspector 的 agent-friendly projections：

```bash
AGENT=${AGENT:-trae}
scripts/acpx-inspector snapshot --cwd "$PWD" --agent "$AGENT" --name impl
scripts/acpx-inspector read --cwd "$PWD" --agent "$AGENT" --name impl --tail 40 --budget 1200
scripts/acpx-inspector diagnose --cwd "$PWD" --agent "$AGENT" --name impl
```

对于 long-running multi-step orchestration，优先使用 `acpx flow run`，它会把 run state、node outputs、traces 和 artifacts 记录到 `~/.acpx/flows/runs/<runId>/` 下。不要在受限 main-agent shell 中把 `acpx flow run` 当作 foreground long wait 使用。应以非阻塞方式启动长 flows，并用 `scripts/acpx-inspector follow --run-id <runId>` 或 `--run-dir <runDir>` 监控 run bundle。

One-shot 和 named session prompts 应使用 `nohup` 包裹 acpx-native commands 后台启动，避免阻塞 main agent shell；PID/log 只用于 process lifecycle，session/flow state 使用 inspector，最终 completion 仍检查 repo/check state。`--no-wait` 是 agent-session queueing，用于类似 `acpx <agent> --no-wait -s impl ...` 的 prompts，但本 skill 的标准启动模式仍是 `nohup ... &`。

## Inspector-Centered Tracking

不要直接 tail `.stream.ndjson`。它是 low-level event log，包含大量 protocol detail。Main-agent tracking 应使用 `scripts/acpx-inspector` 的 compact projections。

Routine session tracking：

```bash
AGENT=${AGENT:-trae}
scripts/acpx-inspector sessions --cwd "$PWD" --limit 20
scripts/acpx-inspector snapshot --cwd "$PWD" --agent "$AGENT" --name impl
scripts/acpx-inspector read --cwd "$PWD" --agent "$AGENT" --name impl --tail 40 --budget 1200
scripts/acpx-inspector diagnose --cwd "$PWD" --agent "$AGENT" --name impl
```

Active session follow：

```bash
AGENT=${AGENT:-trae}
scripts/acpx-inspector follow --cwd "$PWD" --agent "$AGENT" --name impl --duration 10m --interval 60s --events 2
```

`snapshot` 用于 status、evidence 和 next actions；`read` 用于 budgeted recent history；`diagnose` 用于 stale/stuck/queue/process 异常；`follow` 用于 active polling。旧的 `sessions read/history/show`、`status`、`live.json` 和 raw stream reads 只作为 fallback/debug。

对于 per-lane flow orchestration，使用 `scripts/acpx-flow-run` materialize static node profiles 并启动 workflow：

```bash
FLOW_LOG=/tmp/acpx-flow-simple-feature.log
FLOW_RUN_OUTPUT=$(scripts/acpx-flow-run simple-feature \
  --input-json "{\"task\":\"<user request>\",\"cwd\":\"$PWD\"}" \
  --log "$FLOW_LOG")
echo "$FLOW_RUN_OUTPUT"

RUN=$(printf '%s\n' "$FLOW_RUN_OUTPUT" | awk -F= '$1=="runDir"{print $2}')
RUN_ID=$(printf '%s\n' "$FLOW_RUN_OUTPUT" | awk -F= '$1=="runId"{print $2}')
if [ -n "$RUN_ID" ]; then
  scripts/acpx-inspector follow --run-id "$RUN_ID" --duration 10m --interval 60s --events 2
elif [ -n "$RUN" ]; then
  scripts/acpx-inspector follow --run-dir "$RUN" --duration 10m --interval 60s --events 2
fi
```

Launcher 默认 background execution 和 flow-level `--approve-all`。Background launch output 包含 `pid`、`log`、`flow`、`input`、`command`，并在 startup lookup 成功时包含 `runLookup=matched`、`runId`、`runDir`、`manifest`、`live`、`runProjection`、`steps`、`trace`、`sessionsDir` 和 `artifactsDir`。Flow templates 提供默认 profiles。Input role fields 覆盖 template defaults，环境变量覆盖 input role fields。Flow input 可以设置 `handoffDir`；否则默认 handoff path 为 `<repo>/tmp/flow_handoffs/<runId>/<node>.md`，shared memory index 为 `<repo>/tmp/flow_handoffs/<runId>/flow-memory.md`。

`flows/examples/*.input.json` 只用于 smoke/demo，因为其 `task` 和 `cwd` 都是占位值。真实用户任务应使用 `--input-json` 或生成 task-specific input file，并显式传入当前 repo `cwd`。

```bash
PLAN_AGENT=${PLAN_AGENT:-claude} PLAN_REVIEW_AGENT=${PLAN_REVIEW_AGENT:-aiden} IMPLEMENT_AGENT=${IMPLEMENT_AGENT:-trae} VALIDATE_AGENT=${VALIDATE_AGENT:-aiden} \
  scripts/acpx-flow-run complex-feature-refactor \
    --input-json "{\"task\":\"<user request>\",\"cwd\":\"$PWD\"}"
```

如果 `runLookup=pending`，使用输出的 `runSearchRoot`、`runSearchFlow` 和 `runSearchFlowName` values，待 bundle 出现后定位它，再交给 `scripts/acpx-inspector follow --run-dir <runDir>`。只把 newest run directory 作为 fallback debugging aid。

随附 flow templates 指示每个 lane agent 写入自己的 handoff file，并向 `flow-memory.md` 追加 compact index entry。下游 prompts 接收 memory file 和 handoff files 的 compact references，而不是完整上游 agent output。监控时优先使用 inspector；只有 inspector 无法回答或需要 deeper audit/debug 时才读取 flow outputs、`flowMemoryPath`、memory index、handoff paths 或完整 session reads。
随附 flows 的 shared prompt wording 位于 `flows/shared/prompt-templates.ts`，shared handoff/path helpers 位于 `flows/shared/flow-helpers.ts`；在 individual flow templates 中复制通用 prompt 或 helper 逻辑前，先更新 shared files。

Active work 的 recommended polling cadence：

| Phase | Interval | Count |
| --- | ---: | ---: |
| Early long-task window | 120s | 2 |
| Narrowing window | 90s | 3 |
| Steady tracking | 60s | 4 |
| Extended tracking | 60s | repeat as needed |

每次 poll 时，使用 `scripts/acpx-inspector follow` 或单次 `snapshot/read/diagnose`。默认不要以快于 60s 的频率 poll；只有用户明确需要 near-real-time monitoring 时才缩短。

### Named Session Tracking

对于普通 named sessions，用 `nohup` 后台启动 prompt，然后用 inspector 跟踪：

```bash
REVIEW_AGENT=${REVIEW_AGENT:-aiden}
IMPLEMENT_AGENT=${IMPLEMENT_AGENT:-trae}
LOG=/tmp/acpx-review.log
nohup acpx --cwd /repo "$REVIEW_AGENT" -s review --approve-reads --no-terminal \
  "Review 当前 diff，查找 bugs、regressions 和 missing tests。" >"$LOG" 2>&1 &
echo "pid=$! log=$LOG"
scripts/acpx-inspector snapshot --cwd /repo --agent "$REVIEW_AGENT" --name review
scripts/acpx-inspector read --cwd /repo --agent "$REVIEW_AGENT" --name review --tail 40 --budget 1200
```

只有明确需要 native metadata、full messages 或 source debugging 时才使用 `sessions history/read/show`；它们不再是 routine tracking path。

对于低频 post-run audit reports，见 [audit-visualization.md](audit-visualization.md)。

## Recommended Patterns

### Simple Planning Or Review

```bash
REVIEW_AGENT=${REVIEW_AGENT:-aiden}
LOG=/tmp/acpx-review.log
nohup acpx "$REVIEW_AGENT" -s review --approve-reads --no-terminal --cwd /repo \
  "Review 当前 diff，查找 bugs、regressions 和 missing tests。" >"$LOG" 2>&1 &
echo "pid=$! log=$LOG"
scripts/acpx-inspector snapshot --cwd /repo --agent "$REVIEW_AGENT" --name review
scripts/acpx-inspector read --cwd /repo --agent "$REVIEW_AGENT" --name review --tail 40 --budget 1200
```

### Bounded Implementation

```bash
IMPLEMENT_AGENT=${IMPLEMENT_AGENT:-trae}
LOG=/tmp/acpx-impl.log
nohup acpx "$IMPLEMENT_AGENT" -s impl --approve-all --cwd /repo -f task.md >"$LOG" 2>&1 &
echo "pid=$! log=$LOG"
scripts/acpx-inspector snapshot --cwd /repo --agent "$IMPLEMENT_AGENT" --name impl
scripts/acpx-inspector follow --cwd /repo --agent "$IMPLEMENT_AGENT" --name impl --duration 10m --interval 60s --events 2
```

### One-Shot Bounded Stateless Task

```bash
AGENT=${AGENT:-pi}
LOG=/tmp/acpx-one-shot-$AGENT.log
nohup acpx --cwd /repo "$AGENT" exec "总结当前 package structure。" >"$LOG" 2>&1 &
echo "pid=$! log=$LOG"
```

对于不需要 session continuity、flow artifacts 或 recovery routing 的 bounded stateless tasks，使用 `exec`，但仍用 `nohup` 后台启动，并通过 PID/log 跟踪 completion。

### Inspect Recent Output

```bash
AGENT=${AGENT:-trae}
scripts/acpx-inspector read --cwd "$PWD" --agent "$AGENT" --name impl --tail 40 --budget 1200
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

Use the printed `runId` or `runDir` with inspector for progress:

```bash
scripts/acpx-inspector follow --run-id <runId> --duration 10m --interval 60s --events 2
```

`quick-bugfix` 是短 implementation 加 independent test lane。`simple-feature` 增加 planning、independent validation review，以及最多一轮 automatic fix。`complex-feature-refactor` 增加 plan review、independent validation review，以及最多两轮 automatic fix。这些 templates 都不使用 infinite loops。

Agent validation 是 quality signal，不是 live tracking mechanism。Feature-flow validation 在 independent validation lane 中运行，并具有与 run 其余部分相同的 flow-level permissions，因此其“do not edit production code in validation”规则依靠 prompt discipline 和 post-run audit 执行，而不是单独的 acpx permission boundary。完成后使用 `scripts/acpx-inspector report flow` 或 `scripts/acpx-visualize` 检查 validation tools、commands、file writes 和 outputs。

随附 flows 会在调用 ACP agents 前创建 target `cwd`，因为 agent subprocesses 无法以缺失的 working directory 启动。
