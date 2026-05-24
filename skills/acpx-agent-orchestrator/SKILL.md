---
name: acpx-agent-orchestrator
description: Use this skill when a general AI agent needs to orchestrate specialized coding agents through openclaw/acpx and the Agent Client Protocol. It covers acpx setup, session-based delegation, flow-first orchestration, and routing work across registered acpx agents (eg: `aiden`, `trae`).
---

# ACPX Agent Orchestrator

Use `acpx` as the orchestration boundary. The current agent should coordinate, inspect, and decide; implementation should be delegated to specialized ACP agents when feasible. Prefer bundled `acpx flow` templates for multi-agent orchestration, run long flows non-blockingly, and use acpx-native capabilities before adding shell mechanics.

## Core Rules

- Assume `acpx` is ready and registered agents are available. Examples use `aiden` and `trae`. Do not run validation up front during normal work.
- Read [references/acpx-capabilities.md](references/acpx-capabilities.md) for command boundaries and [references/agent-routing.md](references/agent-routing.md) for routing detail.
- Before changing acpx config, read [references/acpx-config.md](references/acpx-config.md). `trae` is native; keep only custom agents acpx does not provide.
- Use `status` only for local process/session-owner health, not as proof that a prompt or flow completed.
- If first delegation fails, inspect only the failed path with `command -v acpx`, `acpx config show`, and the relevant `<agent> --help`. Use `scripts/acpx-healthcheck.sh` or `scripts/acpx-e2e-validate.sh` only for unclear availability failures.

## Routing And SOP

| Stage | Default | Required output/check |
| --- | --- | --- |
| Intake | Orchestrator inspects `git status --short`, likely files, manifests, and tests before delegation. | Restate task, deliverables, constraints, and risk. Ask only for product intent that cannot be derived from the repo. |
| Plan | Use a registered planning agent in read-only mode. | Target behavior, likely edits, risks, and tests. |
| Implement | Prefer non-blocking flow templates. Use a direct implementation agent session only for lightweight bounded work outside a flow. | Keep scope bounded; use worktrees or explicit stop points for high-risk repos. |
| Review | Use a registered review agent in read-only mode. | Findings with file references, severity, and concrete fixes. |
| Verify | Ask the implementer to run agreed checks, then inspect directly. | Final `git status --short`, relevant diffs, and test/build result before reporting completion. |

Direct lanes are supplemental and should use named sessions such as `-s plan`, `-s impl`, and `-s review` for continuity.

## Non-Blocking Flow-First Orchestration

For normal delegation, prefer bundled flow templates launched through `scripts/acpx-flow-run` so each lane can use its role agent. Choose the lightest template that matches the task risk, then start it non-blockingly. Do not fix main-agent bash timeouts by increasing `--timeout`; long flow work must return control to the orchestrator and be monitored through run artifacts.

| Flow | Use when | Behavior |
| --- | --- | --- |
| `quick-bugfix` | Small, clear, low-risk fixes. | Implements and independently tests; no auto-fix. |
| `simple-feature` | Local feature work. | Plans, implements, tests, reviews; at most one fix round. |
| `complex-feature-refactor` | Cross-file features, refactors, migrations, high-risk changes. | Adds plan review; at most two fix rounds. |

```bash
FLOW=simple-feature
FLOW_LOG=/tmp/acpx-flow-$FLOW.log
scripts/acpx-flow-run "$FLOW" \
  --input-file "flows/examples/$FLOW.input.json" \
  --log "$FLOW_LOG"
```

Flow templates include default profiles. Override lane agents through input fields or environment variables: `PLAN_AGENT`, `IMPLEMENT_AGENT`, `TEST_AGENT`, and `REVIEW_AGENT`. Environment variables override input role fields. If the caller confirms a handoff location, pass `handoffDir` in the flow input; otherwise nodes use `<repo>/tmp/flow_handoffs/<runId>/<node>.md`.

After launch, record the PID and log path, then identify the newest run bundle. If other flows may be active, correlate the bundle with `flowName`, `startedAt`, and the log path before treating it as the target run:

```bash
RUN=$(ls -td ~/.acpx/flows/runs/* 2>/dev/null | head -1)
echo "run=$RUN"
cat "$RUN/projections/live.json"
```

The flow runtime persists run state and artifacts under `~/.acpx/flows/runs/<runId>/`. Lane agents write handoff files under the configured handoff directory and pass their final responses forward as the next lane's handoff context; use flow outputs and handoff paths first, then read full session output only when deeper inspection is needed.
The bundled templates create the input `cwd` before starting agent nodes. For self-healing templates, audit test-agent behavior after completion with `scripts/acpx-visualize`.

## Permissions

- Use `--approve-reads` for planning, analysis, and review.
- `scripts/acpx-flow-run` defaults to `--approve-all`; pass explicit acpx flags after `--` only when overriding permissions.
- Use `--approve-all` for direct implementation sessions only after scope is clear.
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
  REVIEW_AGENT=aiden
  IMPLEMENT_AGENT=trae
  acpx --cwd /repo --format json "$REVIEW_AGENT" sessions read --tail 3 review
  acpx --cwd /repo --format json "$IMPLEMENT_AGENT" sessions read --tail 3 impl
  ```
- Use `sessions history --limit 5` for a short history index. Avoid `sessions show` and raw `.stream.ndjson` for routine tracking.
- Poll active flow/session status with a long-to-short cadence to avoid both stale waiting and context waste: 120s x 2, then 90s x 3, then 60s x 4, then stay at 60s unless the user asks for faster monitoring.

For low-frequency post-run audit reports, read [references/audit-visualization.md](references/audit-visualization.md) and use `scripts/acpx-visualize`.

## Failure Handling

- If a session is stale, use `<agent> sessions` and `<agent> sessions ensure --name <lane>`.
- If a prompt is stuck, use `<agent> cancel -s <lane>`, then retry once with a narrower prompt.
- If an agent fails, do not silently route to an unrelated agent. Run `scripts/acpx-e2e-validate.sh <agent>` only when the failure reason is unclear and a fresh session probe is needed.
- If `acpx` is absent, report the missing dependency instead of using `npx`.
