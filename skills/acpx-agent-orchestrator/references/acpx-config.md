# ACPX Configuration

当前机器上的已知 local facts：

- 预期 `acpx` 已安装在 `PATH` 上。
- Global config path：`~/.acpx/config.json`。
- `aiden` 可通过 custom command `aiden acp` 使用。
- `omp` 可通过 custom command `omp acp` 使用。
- 此技能可使用任何 registered acpx agent，例如 `claude`、`codex`、`aiden`、`trae`、`omp` 和 `pi`。

## Minimal Config Shape

编辑 `~/.acpx/config.json` 时，保留所有 existing keys。只添加缺失 aliases：

```json
{
  "agents": {
    "aiden": {
      "command": "aiden acp"
    },
    "omp": {
      "command": "omp acp"
    }
  }
}
```

Recommended global config defaults。它们不是 flow lane defaults；flow lane defaults 由 templates、input JSON 或 env role variables 决定：

```json
{
  "defaultAgent": "trae",
  "defaultPermissions": "approve-all",
  "nonInteractivePermissions": "deny",
  "authPolicy": "skip",
  "ttl": 300,
  "queueMaxDepth": 16,
  "format": "text"
}
```

不要覆盖 local auth 或 unrelated agent aliases。

## Commands

使用这些 commands 检查和管理 acpx agents：

```bash
AGENT=${AGENT:-trae}
acpx config show
acpx "$AGENT" sessions
acpx "$AGENT" sessions ensure --name impl
acpx "$AGENT" status
```

当你不想保存 session 时，使用 one-shot prompts：

```bash
AGENT=${AGENT:-pi}
LOG=/tmp/acpx-one-shot-$AGENT.log
nohup acpx --approve-reads --no-terminal "$AGENT" exec "用五个 bullets 总结 repo。" >"$LOG" 2>&1 &
echo "pid=$! log=$LOG"
```

真实工作使用 persistent sessions：

```bash
AGENT=${AGENT:-trae}
LOG=/tmp/acpx-impl.log
nohup acpx --approve-all "$AGENT" -s impl "实现 accepted plan..." >"$LOG" 2>&1 &
echo "pid=$! log=$LOG"
```

## End-to-End Session Validation

使用 named sessions 证明 agent 可以启动并对话。只有在真实 tool call 失败后，或明确要求诊断可用性时才运行：

```bash
scripts/acpx-e2e-validate.sh claude codex aiden trae omp pi
scripts/acpx-e2e-validate.sh <agent>
```
