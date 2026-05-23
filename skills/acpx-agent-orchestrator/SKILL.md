---
name: acpx-agent-orchestrator
description: Use this skill when a general AI agent needs to orchestrate specialized coding agents through openclaw/acpx and the Agent Client Protocol. It covers acpx setup, session-based delegation, and routing work between the supported trae and aiden agents.
---

# ACPX Agent Orchestrator

Use `acpx` as the orchestration boundary. The current agent should coordinate, inspect, and decide; implementation should be delegated to specialized ACP agents when feasible. Prefer bundled `acpx flow` templates for multi-agent orchestration, run long flows non-blockingly, and use acpx-native capabilities before adding shell mechanics.

## Core Rules

- Assume `acpx`, `trae`, and `aiden` are ready. Do not run validation up front during normal work.
- Read [references/acpx-capabilities.md](references/acpx-capabilities.md) for command boundaries and [references/agent-routing.md](references/agent-routing.md) for routing detail.
- Before changing acpx config, read [references/acpx-config.md](references/acpx-config.md). `trae` is native; keep only custom agents acpx does not provide.
- Use `status` only for local process/session-owner health, not as proof that a prompt or flow completed.
- If first delegation fails, inspect only the failed path with `command -v acpx`, `acpx config show`, and the relevant `<agent> --help`. Use `scripts/acpx-healthcheck.sh` or `scripts/acpx-e2e-validate.sh` only for unclear availability failures.

## Routing And SOP

| Stage | Default | Required output/check |
| --- | --- | --- |
| Intake | Orchestrator inspects `git status --short`, likely files, manifests, and tests before delegation. | Restate task, deliverables, constraints, and risk. Ask only for product intent that cannot be derived from the repo. |
| Plan | Prefer `aiden` in read-only mode. | Target behavior, likely edits, risks, and tests. |
| Implement | Prefer non-blocking flow templates. Use direct `trae -s impl` only for lightweight bounded work outside a flow. | Keep scope bounded; use worktrees or explicit stop points for high-risk repos. |
| Review | Prefer `aiden` in read-only mode. | Findings with file references, severity, and concrete fixes. |
| Verify | Ask the implementer to run agreed checks, then inspect directly. | Final `git status --short`, relevant diffs, and test/build result before reporting completion. |

Direct lanes are supplemental and should use named sessions such as `-s plan`, `-s impl`, and `-s review` for continuity.

## Non-Blocking Flow-First Orchestration

For normal delegation, prefer bundled flow templates over custom helper scripts. Choose the lightest template that matches the task risk, then start it non-blockingly. Do not fix main-agent bash timeouts by increasing `--timeout`; long flow work must return control to the orchestrator and be monitored through run artifacts.

| Flow | Use when | Behavior |
| --- | --- | --- |
| `quick-bugfix` | Small, clear, low-risk fixes. | `trae` implements; `aiden` tests; no auto-fix. |
| `simple-feature` | Local feature work. | `aiden` plans/tests/reviews; `trae` implements; at most one fix round. |
| `complex-feature-refactor` | Cross-file features, refactors, migrations, high-risk changes. | Adds plan review; at most two fix rounds. |

```bash
FLOW=quick-bugfix
FLOW_LOG=/tmp/acpx-flow-$FLOW.log
nohup acpx --approve-all flow run "flows/$FLOW.flow.ts" \
  --input-file "flows/examples/$FLOW.input.json" \
  >"$FLOW_LOG" 2>&1 &
FLOW_PID=$!
echo "pid=$FLOW_PID log=$FLOW_LOG"
```

After launch, record the PID and log path, then identify the newest run bundle. If other flows may be active, correlate the bundle with `flowName`, `startedAt`, and the log path before treating it as the target run:

```bash
RUN=$(ls -td ~/.acpx/flows/runs/* 2>/dev/null | head -1)
echo "run=$RUN"
cat "$RUN/projections/live.json"
```

The flow runtime persists run state and artifacts under `~/.acpx/flows/runs/<runId>/`. Use those artifacts, plus native `acpx sessions read/history`, for monitoring, recovery, and inspection.
The bundled templates create the input `cwd` before starting agent nodes. For self-healing templates, audit test-agent behavior after completion with `scripts/acpx-visualize`.

## Permissions

- Use `--approve-reads` for planning, analysis, and review.
- Use `--approve-all` only for the implementation lane after scope is clear.
- Use `--deny-all` or `--non-interactive-permissions fail` for pure summarization.
- Avoid `--agent` raw command aliases except for temporary, probed commands.

## State Tracking

- Inspect flow progress through `~/.acpx/flows/runs/<runId>/projections/live.json`.
- To inspect the current flow node output, read `live.json.sessionBindings` for `agentName`, `cwd`, and `name`, then tail the session:
  ```bash
  acpx --cwd <cwd> --format json <agentName> sessions read --tail 3 <name>
  ```
- For ordinary named sessions, use compact reads:
  ```bash
  acpx --cwd /repo --format json aiden sessions read --tail 3 review
  acpx --cwd /repo --format json trae sessions read --tail 3 impl
  ```
- Use `sessions history --limit 5` for a short history index. Avoid `sessions show` and raw `.stream.ndjson` for routine tracking.
- Poll active flow/session status with a long-to-short cadence to avoid both stale waiting and context waste: 120s x 2, then 90s x 3, then 60s x 4, then stay at 60s unless the user asks for faster monitoring.

For low-frequency post-run audit reports, read [references/audit-visualization.md](references/audit-visualization.md) and use `scripts/acpx-visualize`.

## Failure Handling

- If a session is stale, use `<agent> sessions` and `<agent> sessions ensure --name <lane>`.
- If a prompt is stuck, use `<agent> cancel -s <lane>`, then retry once with a narrower prompt.
- If `trae` or `aiden` fails, do not silently route to unrelated agents. Run `scripts/acpx-e2e-validate.sh` only when the failure reason is unclear and a fresh session probe is needed.
- If `acpx` is absent, report the missing dependency instead of using `npx`.
