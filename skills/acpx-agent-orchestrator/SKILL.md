---
name: acpx-agent-orchestrator
description:  当明确需要使用 acpx 来编排专用 coding agents 时，或新建/管理 coding agents 的会话时，使用该技能。它涵盖 acpx 设置、one-shot、named session、flow 编排，以及在已注册 acpx agents（例如：`claude`、`codex`、`aiden`、`trae`、`omp`、`pi` 等）之间路由工作。
---

# ACPX Agent Orchestrator

将 `acpx` 作为编排边界。当前 agent 应负责协调、检查和决策；可行时，implementation 应委派给专用 ACP agents。根据任务目标在 one-shot、named session 和 flow 三种 acpx-native 编排方式中选择；复杂、长耗时、需要 handoff/recovery/audit 的任务推荐使用 flow。在添加 shell 机制前优先使用 acpx-native capabilities。

## 核心规则

- 假设 `acpx` 已就绪且所需 registered agents 可用。常规工作中不要预先运行 validation。
- 阅读 [references/acpx-capabilities.md](references/acpx-capabilities.md) 了解 command 边界，阅读 [references/agent-routing.md](references/agent-routing.md) 了解 routing 细节。
- 修改 acpx config 前，先阅读 [references/acpx-config.md](references/acpx-config.md)。只保留 acpx 不提供的 custom agents。
- `status` 只用于本地 process/session-owner 健康状态，不可作为 prompt 或 flow 已完成的证明。
- 如果首次 delegation 失败，只检查失败路径：`command -v acpx`、`acpx config show` 以及相关 `<agent> --help`。仅在可用性失败原因不清楚时使用 `scripts/acpx-healthcheck.sh` 或 `scripts/acpx-e2e-validate.sh`。

## Agent 选择摘要

### Claude / Codex

适合复杂任务、规划、架构判断和深度 review。Flow planning 默认使用 `claude`。

### Aiden / Trae / Omp

适合快速实施、局部改动和 scope 明确的 coding work。Flow implementation 默认使用 `trae`，review/test/validate 默认使用 `aiden`。

### Pi

适合简单、短小、低风险任务。

## Routing 与 SOP

| 阶段 | 默认做法 | 必需输出/检查 |
| --- | --- | --- |
| Intake | Orchestrator 在 delegation 前检查 `git status --short`、可能相关文件、manifests 和 tests。 | 重述任务、deliverables、constraints 和 risk。只询问无法从 repo 推导出的 product intent。 |
| Plan | 以 read-only mode 使用已注册 planning agent。 | Target behavior、可能 edits、risks 和 tests。 |
| Implement | 根据目标选择 one-shot、named session 或 flow。复杂、长耗时、需要 handoff/recovery/audit/independent validation 的工作推荐非阻塞 flow；轻量连续工作使用 named session；短小 stateless 工作使用 one-shot。 | 保持 scope 有界；高风险 repos 使用 worktrees 或明确 stop points。 |
| Review | 以 read-only mode 使用已注册 review agent。 | 按 severity 排序的 findings，并包含 file references 和具体 fixes。 |
| Verify | 要求 implementer 运行已约定 checks，然后直接检查。 | 报告 completion 前，确认最终 `git status --short`、相关 diffs 以及 test/build result。 |

## 编排方式选择

主 agent 可根据任务目标自由选择以下 acpx-native 编排方式。Flow 是复杂/可恢复/需审计任务的推荐默认，但 one-shot 和 named session 也是一等可用路径。

### One-Shot

适用于 stateless、短小、可丢弃任务；不需要 reusable session 或 flow artifacts。必须用 `nohup` 后台启动，并通过 PID、log 和最终 repo/check state 跟踪。

```bash
AGENT=${AGENT:-pi}
LOG=/tmp/acpx-one-shot-$AGENT.log
nohup acpx --cwd /repo "$AGENT" exec "总结当前 package structure。" >"$LOG" 2>&1 &
PID=$!
echo "pid=$PID log=$LOG"
```

保持 one-shot prompts 有界且可丢弃。

### Named Session

适用于需要连续上下文、轻量 lane、人工可跟踪的 plan/impl/review；不需要完整 flow artifacts。必须用 `nohup` 后台启动 prompt，并通过 PID/log 加 `sessions read --tail` 或 `sessions history --limit` 跟踪。

```bash
IMPLEMENT_AGENT=${IMPLEMENT_AGENT:-trae}
LOG=/tmp/acpx-impl.log
nohup acpx --cwd /repo "$IMPLEMENT_AGENT" -s impl --approve-all -f task.md >"$LOG" 2>&1 &
PID=$!
echo "pid=$PID log=$LOG"
acpx --cwd /repo --format json "$IMPLEMENT_AGENT" sessions read --tail 3 impl
```

需要 continuity 但不需要 flow artifacts 时，选择 named sessions。

### Flow

适用于多阶段、长耗时、需要 handoff、recovery、independent review/validation、self-healing 或 post-run audit 的任务。使用 run bundle、`live.json`、handoff files、`flow-memory.md` 和 audit report 跟踪。

需要 monitoring、handoff、review/validation、recovery 或 audit 时，选择 flow。

## 非阻塞 Flow 编排

当选择 flow 时，优先使用随附 templates，并通过 `scripts/acpx-flow-run` 启动，以便每条 lane 使用其 role agent。选择与任务风险匹配的最轻量 template，然后以非阻塞方式启动。不要通过增大 `--timeout` 来修复 main-agent bash timeouts；长 flow work 必须把控制权交还给 orchestrator，并通过 run artifacts 监控。详细 command surface、launcher output 和 polling 规则见 [references/acpx-capabilities.md](references/acpx-capabilities.md)。

| Flow | 适用场景 | 行为 |
| --- | --- | --- |
| `quick-bugfix` | 小型、明确、低风险 fixes。 | 实现并独立测试；无 auto-fix。 |
| `simple-feature` | 本地 feature work。 | 规划、实现并独立验证；最多一轮 fix。 |
| `complex-feature-refactor` | 跨文件 features、refactors、migrations、高风险 changes。 | 增加 plan review 和 independent validation；最多两轮 fix。 |

```bash
FLOW=simple-feature
FLOW_LOG=/tmp/acpx-flow-$FLOW.log
FLOW_RUN_OUTPUT=$(scripts/acpx-flow-run "$FLOW" \
  --input-json "{\"task\":\"<user request>\",\"cwd\":\"$PWD\"}" \
  --log "$FLOW_LOG")
echo "$FLOW_RUN_OUTPUT"
```

`flows/examples/*.input.json` 仅用于 smoke/demo，不要直接用于真实用户任务；它们的 `cwd` 指向 `/tmp/acpx-...-smoke`。真实任务应传入当前 repo 的 `cwd` 和 task-specific prompt。

Flow templates 包含默认 profiles。`quick-bugfix` defaults 为 `IMPLEMENT_AGENT=trae` 和 `TEST_AGENT=aiden`；`simple-feature` defaults 为 `PLAN_AGENT=claude`、`IMPLEMENT_AGENT=trae` 和 `VALIDATE_AGENT=aiden`；`complex-feature-refactor` 额外包含 `PLAN_REVIEW_AGENT=aiden`。环境变量会覆盖 input role fields。如果 caller 确认了 handoff location，在 flow input 中传入 `handoffDir`；否则节点使用 `<repo>/tmp/flow_handoffs/<runId>/<node>.md`，shared memory index 位于 `<repo>/tmp/flow_handoffs/<runId>/flow-memory.md`。

启动后，使用输出的 `runId`、`runDir` 和 `live` fields 跟踪确切 run bundle：

```bash
RUN=$(printf '%s\n' "$FLOW_RUN_OUTPUT" | awk -F= '$1=="runDir"{print $2}')
LIVE=$(printf '%s\n' "$FLOW_RUN_OUTPUT" | awk -F= '$1=="live"{print $2}')
echo "run=$RUN"
[ -n "$LIVE" ] && cat "$LIVE"
```

Flow runtime 会将 run state 和 artifacts 持久化到 `~/.acpx/flows/runs/<runId>/`。Lane agents 在配置的 handoff directory 下写入 handoff files，并向 `flow-memory.md` 追加 compact entries。优先使用 flow outputs、`flowMemoryPath`、memory index 和 handoff paths；只有需要更深检查时才读取完整 session output。对于 self-healing templates，完成后使用 `scripts/acpx-visualize` 审计 validation behavior。

## Permissions

- Named planning、analysis 和 review sessions 使用 `--approve-reads`。
- `scripts/acpx-flow-run` 默认使用 flow-level `--approve-all`；flow 内 planning/review/validation 的 read-only 约束依靠 prompt contract 和 post-run audit，而不是 per-lane permission boundary。仅在需要覆盖 permissions 时，才在 `--` 后传入显式 acpx flags。
- 只有 scope 清晰后，named implementation sessions 才使用 `--approve-all`。
- 纯 summarization 使用 `--deny-all` 或 `--non-interactive-permissions fail`。
- 避免使用 `--agent` raw command aliases，临时探测过的 commands 除外。

## State Tracking

### One-Shot Tracking

使用 `nohup` 后台 PID 和 log 跟踪；完成后检查 command output、relevant diff、status 和 tests。

### Named Session Tracking

使用 `nohup` 后台 PID/log 加 compact reads：

```bash
LOG=/tmp/acpx-review.log
REVIEW_AGENT=${REVIEW_AGENT:-aiden}
IMPLEMENT_AGENT=${IMPLEMENT_AGENT:-trae}
nohup acpx --cwd /repo "$REVIEW_AGENT" -s review --approve-reads --no-terminal "Review 当前 diff。" >"$LOG" 2>&1 &
echo "pid=$! log=$LOG"
acpx --cwd /repo --format json "$REVIEW_AGENT" sessions read --tail 3 review
acpx --cwd /repo --format json "$IMPLEMENT_AGENT" sessions read --tail 3 impl
```

使用 `sessions history --limit 5` 获取短 history index。常规 tracking 避免使用 `sessions show` 和 raw `.stream.ndjson`。

### Flow Tracking

通过 `~/.acpx/flows/runs/<runId>/projections/live.json` 检查 progress。对已完成或部分完成的 lanes，先检查 summary output 和 `<handoffRoot>/flow-memory.md`，再打开 node handoff files 或 session tails。

要检查当前 flow node output，读取 `live.json.sessionBindings` 中的 `agentName`、`cwd` 和 `name`，然后 tail 该 session：

```bash
acpx --cwd <cwd> --format json <agentName> sessions read --tail 3 <name>
```

### Polling Cadence

轮询 active flow/session status 时采用由长到短的 cadence，以避免 stale waiting 和 context waste：120s x 4，然后 90s x 5，之后保持 60s，除非用户要求更快 monitoring。

对于低频 post-run audit reports，阅读 [references/audit-visualization.md](references/audit-visualization.md) 并使用 `scripts/acpx-visualize`。

## Failure Handling

- 如果 session stale，使用 `<agent> sessions` 和 `<agent> sessions ensure --name <lane>`。
- 如果 prompt stuck，使用 `<agent> cancel -s <lane>`，然后用更窄的 prompt 重试一次。
- 如果 agent fails，不要静默路由到无关 agent。仅当 failure reason 不清楚且需要 fresh session probe 时，运行 `scripts/acpx-e2e-validate.sh <agent>`。
- 如果缺少 `acpx`，报告 missing dependency，而不是使用 `npx`。
