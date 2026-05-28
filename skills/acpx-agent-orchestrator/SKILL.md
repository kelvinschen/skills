---
name: acpx-agent-orchestrator
description:  当明确需要使用 acpx  来编排专用 coding agents 时使用此技能。它涵盖 acpx 设置、基于 session 的委派、flow-first 编排，以及在已注册 acpx agents（例如：`aiden`、`trae`、 `claude`、`codex`、`pi` 等）之间路由工作。
---

# ACPX Agent Orchestrator

将 `acpx` 作为编排边界。当前 agent 应负责协调、检查和决策；可行时，implementation 应委派给专用 ACP agents。多 agent 编排优先使用随附的 `acpx flow` templates，以非阻塞方式运行长 flow，并在添加 shell 机制前优先使用 acpx-native capabilities。

## 核心规则

- 假设 `acpx` 已就绪且 registered agents 可用。示例使用 `aiden` 和 `trae`。常规工作中不要预先运行 validation。
- 阅读 [references/acpx-capabilities.md](references/acpx-capabilities.md) 了解 command 边界，阅读 [references/agent-routing.md](references/agent-routing.md) 了解 routing 细节。
- 修改 acpx config 前，先阅读 [references/acpx-config.md](references/acpx-config.md)。`trae` 是 native；只保留 acpx 不提供的 custom agents。
- `status` 只用于本地 process/session-owner 健康状态，不可作为 prompt 或 flow 已完成的证明。
- 如果首次 delegation 失败，只检查失败路径：`command -v acpx`、`acpx config show` 以及相关 `<agent> --help`。仅在可用性失败原因不清楚时使用 `scripts/acpx-healthcheck.sh` 或 `scripts/acpx-e2e-validate.sh`。

## Routing 与 SOP

| 阶段 | 默认做法 | 必需输出/检查 |
| --- | --- | --- |
| Intake | Orchestrator 在 delegation 前检查 `git status --short`、可能相关文件、manifests 和 tests。 | 重述任务、deliverables、constraints 和 risk。只询问无法从 repo 推导出的 product intent。 |
| Plan | 以 read-only mode 使用已注册 planning agent。 | Target behavior、可能 edits、risks 和 tests。 |
| Implement | 优先使用非阻塞 flow templates。仅对 flow 之外的轻量、有界工作使用 direct implementation agent session。 | 保持 scope 有界；高风险 repos 使用 worktrees 或明确 stop points。 |
| Review | 以 read-only mode 使用已注册 review agent。 | 按 severity 排序的 findings，并包含 file references 和具体 fixes。 |
| Verify | 要求 implementer 运行已约定 checks，然后直接检查。 | 报告 completion 前，确认最终 `git status --short`、相关 diffs 以及 test/build result。 |

Direct lanes 是补充手段，应使用命名 sessions（如 `-s plan`、`-s impl`、`-s review`）以保持连续性。

### one-shot mode
**对于不需要 reusable session 或 flow artifacts 的 stateless fire-and-forget tasks，使用 acpx one-shot mode：**

```bash
AGENT=aiden
acpx --cwd /repo "$AGENT" exec "总结当前 package structure。"
```

保持 one-shot prompts 有界且可丢弃。当 continuity、monitoring、review 或 recovery 重要时，使用 named sessions 或 flows。

## 非阻塞 Flow-First 编排

常规 delegation 优先使用随附 flow templates，并通过 `scripts/acpx-flow-run` 启动，以便每条 lane 使用其 role agent。选择与任务风险匹配的最轻量 template，然后以非阻塞方式启动。不要通过增大 `--timeout` 来修复 main-agent bash timeouts；长 flow work 必须把控制权交还给 orchestrator，并通过 run artifacts 监控。

| Flow | 适用场景 | 行为 |
| --- | --- | --- |
| `quick-bugfix` | 小型、明确、低风险 fixes。 | 实现并独立测试；无 auto-fix。 |
| `simple-feature` | 本地 feature work。 | 规划、实现并独立验证；最多一轮 fix。 |
| `complex-feature-refactor` | 跨文件 features、refactors、migrations、高风险 changes。 | 增加 plan review 和 independent validation；最多两轮 fix。 |

```bash
FLOW=simple-feature
FLOW_LOG=/tmp/acpx-flow-$FLOW.log
FLOW_RUN_OUTPUT=$(scripts/acpx-flow-run "$FLOW" \
  --input-file "flows/examples/$FLOW.input.json" \
  --log "$FLOW_LOG")
echo "$FLOW_RUN_OUTPUT"
```

Flow templates 包含默认 profiles。Feature flow defaults 为 `PLAN_AGENT=aiden`、`PLAN_REVIEW_AGENT=trae`、`IMPLEMENT_AGENT=trae` 和 `VALIDATE_AGENT=aiden`；`quick-bugfix` 还支持 `TEST_AGENT`。环境变量会覆盖 input role fields。如果 caller 确认了 handoff location，在 flow input 中传入 `handoffDir`；否则节点使用 `<repo>/tmp/flow_handoffs/<runId>/<node>.md`，shared memory index 位于 `<repo>/tmp/flow_handoffs/<runId>/flow-memory.md`。

启动后，使用输出的 `runId`、`runDir` 和 `live` fields 跟踪确切 run bundle：

```bash
RUN=$(printf '%s\n' "$FLOW_RUN_OUTPUT" | awk -F= '$1=="runDir"{print $2}')
LIVE=$(printf '%s\n' "$FLOW_RUN_OUTPUT" | awk -F= '$1=="live"{print $2}')
echo "run=$RUN"
[ -n "$LIVE" ] && cat "$LIVE"
```

如果 `runLookup=pending`，使用 launcher output 中的 `runSearchRoot`、`runSearchFlow` 和 `runSearchFlowName`，待 bundle 出现后定位它。只把 newest run directory 作为 fallback debugging aid。

Flow runtime 会将 run state 和 artifacts 持久化到 `~/.acpx/flows/runs/<runId>/`。Lane agents 在配置的 handoff directory 下写入 handoff files，并向 `flow-memory.md` 追加 compact entries。优先使用 flow outputs、`flowMemoryPath`、memory index 和 handoff paths；只有需要更深检查时才读取完整 session output。
随附 templates 会在启动 agent nodes 前创建 input `cwd`。对于 self-healing templates，完成后使用 `scripts/acpx-visualize` 审计 validation behavior。

## Permissions

- Planning、analysis 和 review 使用 `--approve-reads`。
- `scripts/acpx-flow-run` 默认使用 `--approve-all`；仅在需要覆盖 permissions 时，才在 `--` 后传入显式 acpx flags。
- 只有 scope 清晰后，direct implementation sessions 才使用 `--approve-all`。
- 纯 summarization 使用 `--deny-all` 或 `--non-interactive-permissions fail`。
- 避免使用 `--agent` raw command aliases，临时探测过的 commands 除外。

## State Tracking

- 通过 `~/.acpx/flows/runs/<runId>/projections/live.json` 检查 flow progress。
- 对已完成或部分完成的 lanes，先检查 summary output 和 `<handoffRoot>/flow-memory.md`，再打开 node handoff files 或 session tails。
- 要检查当前 flow node output，读取 `live.json.sessionBindings` 中的 `agentName`、`cwd` 和 `name`，然后 tail 该 session：
  ```bash
  acpx --cwd <cwd> --format json <agentName> sessions read --tail 3 <name>
  ```
- 对普通 named sessions，使用 compact reads：
  ```bash
  REVIEW_AGENT=aiden
  IMPLEMENT_AGENT=trae
  acpx --cwd /repo --format json "$REVIEW_AGENT" sessions read --tail 3 review
  acpx --cwd /repo --format json "$IMPLEMENT_AGENT" sessions read --tail 3 impl
  ```
- 使用 `sessions history --limit 5` 获取短 history index。常规 tracking 避免使用 `sessions show` 和 raw `.stream.ndjson`。
- 轮询 active flow/session status 时采用由长到短的 cadence，以避免 stale waiting 和 context waste：120s x 2，然后 90s x 3，然后 60s x 4，之后保持 60s，除非用户要求更快 monitoring。

对于低频 post-run audit reports，阅读 [references/audit-visualization.md](references/audit-visualization.md) 并使用 `scripts/acpx-visualize`。

## Failure Handling

- 如果 session stale，使用 `<agent> sessions` 和 `<agent> sessions ensure --name <lane>`。
- 如果 prompt stuck，使用 `<agent> cancel -s <lane>`，然后用更窄的 prompt 重试一次。
- 如果 agent fails，不要静默路由到无关 agent。仅当 failure reason 不清楚且需要 fresh session probe 时，运行 `scripts/acpx-e2e-validate.sh <agent>`。
- 如果缺少 `acpx`，报告 missing dependency，而不是使用 `npx`。
