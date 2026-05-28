# Audit Visualization

对已结束的 flow/session audit reports 使用 `scripts/acpx-visualize`。它有意不作为 state tracker、helper index、poller 或 live agent work 的 wrapper。

## Supported Inputs

```bash
scripts/acpx-visualize --flow-run ~/.acpx/flows/runs/<runId>
scripts/acpx-visualize --flow-run latest --output /tmp/acpx-audit.html
scripts/acpx-visualize --session-json session-show.json --output /tmp/acpx-session-audit.html
scripts/acpx-visualize --agent <agent> --cwd /repo --session impl
```

## Data Sources

该工具读取 acpx-native artifacts：flow `manifest.json`、`projections/run.json`、`projections/steps.json`、session bindings 和 session `record.json`；对于 standalone sessions，它读取 captured `sessions show` JSON，或运行一次 `acpx --format json <agent> sessions show <name>`。对于 flow reports，当 run output 或 input 标识了 shared `flow-memory.md` file 时，也会读取该文件。

它不解析 `.stream.ndjson`，不 poll，也不修改或 close sessions。

## Report Semantics

Flow reports 只有在 flow 处于 terminal 状态时才接受：`completed`、`failed`、`timed_out` 或 `cancelled`。Standalone session reports 可以在 close 前生成，但 report 会包含 warning，说明 audit 仅代表 captured state。

生成的 HTML 是一个包含 embedded CSS 和 JavaScript 的单一 local file。它展示 flow timeline、shared flow memory、session panels、user/assistant output，以及带有 1,000 字符 input/result previews、duration 和 errors 的 inline tool calls。它有意省略 raw tool result JSON 和单独的 tool audit table，以保持 long-task reports 紧凑。

此工具用于 post-run audit，不用于 live progress tracking。Live tracking 仍应使用 `projections/live.json` 和 `sessions read --tail 3`。
