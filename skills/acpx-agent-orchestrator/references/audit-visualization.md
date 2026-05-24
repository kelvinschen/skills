# Audit Visualization

Use `scripts/acpx-visualize` for ended flow/session audit reports. It is intentionally not a state tracker, helper index, poller, or wrapper around live agent work.

## Supported Inputs

```bash
scripts/acpx-visualize --flow-run ~/.acpx/flows/runs/<runId>
scripts/acpx-visualize --flow-run latest --output /tmp/acpx-audit.html
scripts/acpx-visualize --session-json session-show.json --output /tmp/acpx-session-audit.html
scripts/acpx-visualize --agent <agent> --cwd /repo --session impl
```

## Data Sources

The tool reads acpx-native artifacts: flow `manifest.json`, `projections/run.json`, `projections/steps.json`, session bindings, and session `record.json`; for standalone sessions it reads captured `sessions show` JSON or runs `acpx --format json <agent> sessions show <name>` once. For flow reports, it also reads the referenced shared `flow-memory.md` file when the run output or input identifies one.

It does not parse `.stream.ndjson`, does not poll, and does not modify or close sessions.

## Report Semantics

Flow reports are accepted only when the flow is terminal: `completed`, `failed`, `timed_out`, or `cancelled`. Standalone session reports can be generated before close, but the report includes a warning that the audit represents only the captured state.

The generated HTML is a single local file with embedded CSS and JavaScript. It shows the flow timeline, shared flow memory, session panels, user/assistant output, and inline tool calls with 1,000-character input/result previews, duration, and errors. It intentionally omits raw tool result JSON and a separate tool audit table so long-task reports stay compact.

Use this for post-run audit, not live progress tracking. Live tracking should still use `projections/live.json` and `sessions read --tail 3`.
