---
name: acpx-agent-orchestrator
description: Use this skill when a general AI agent needs to orchestrate specialized coding agents through openclaw/acpx and the Agent Client Protocol. It covers acpx setup, session-based delegation, and routing work between the supported trae and aiden agents.
---

# ACPX Agent Orchestrator

Use `acpx` as the orchestration boundary. The current agent should coordinate, inspect, and decide; implementation should be delegated to specialized ACP agents when feasible. Prefer acpx native sessions and `acpx flow` over custom wrapper state.

## Quick Start

This skill assumes `acpx`, `trae`, and `aiden` are ready in the user's environment. Do not run validation up front during normal work; it costs time and creates transient acpx sessions.

If the first real delegation fails, verify the dependency:

```bash
command -v acpx
```

Then inspect only the failed path:

```bash
acpx --help
acpx config show
acpx trae --help
acpx aiden --help
```

For a repeatable diagnostic check, run `scripts/acpx-healthcheck.sh`. For an end-to-end failure diagnosis, run `scripts/acpx-e2e-validate.sh`; it creates temporary `e2e-*` sessions, sends a minimal prompt, and closes those sessions before exiting.

For acpx capability boundaries and native commands, read [references/acpx-capabilities.md](references/acpx-capabilities.md). In particular, `status` reports local session owner/process health and must not be treated as a turn-completion oracle.

## Agent Registration

Read [references/acpx-config.md](references/acpx-config.md) before changing acpx config. `trae` is supported by acpx directly and does not need a custom config entry. Keep only custom agents that acpx does not provide natively:

```json
{
  "agents": {
    "aiden": {
      "command": "aiden acp"
    }
  }
}
```

## Routing

Read [references/agent-routing.md](references/agent-routing.md) for details. Default routing:

- Planning: prefer `aiden` in read-only mode.
- Implementation: prefer `trae`; use `aiden` only for bounded implementation tasks when `trae` is unavailable.
- Review: prefer `aiden` in read-only mode.
- Verification: ask the implementation agent to run the agreed checks, then inspect git status and diffs yourself.

## SOP

1. Intake
   - Restate the task, expected deliverables, repo constraints, and risk.
   - Inspect repo state before delegation: `git status --short`, likely files, manifests, and test commands.
   - Ask the user only for product intent that cannot be derived from the repo.

2. Plan lane
   - For a simple direct lane, use an acpx named session:
     ```bash
     acpx aiden -s plan --approve-reads --no-terminal --cwd /repo "Create a concise implementation plan..."
     ```
   - Require output containing target behavior, likely edits, risks, and tests.

3. Implementation lane
   - Send only an accepted, bounded plan:
     ```bash
     acpx trae -s impl --approve-all --cwd /repo -f task.md
     ```
   - For high-risk repos, use worktrees or ask the implementation agent to stop before broad refactors.

4. Review lane
   - Run review in read-only mode:
     ```bash
     acpx aiden -s review --approve-reads --no-terminal --cwd /repo "Review the current diff for bugs, regressions, and missing tests..."
     ```
   - Findings must include file references, severity, and concrete fixes.

5. Verify lane
   - Run agreed tests/builds through the implementer or directly.
   - The orchestrator must inspect final `git status --short` and relevant diffs before reporting completion.

## Flow-First Orchestration

For normal delegation, prefer bundled flow templates over custom helper scripts. Choose the lightest template that matches the task risk:

Use `quick-bugfix` for small, clear, low-risk fixes. It delegates implementation to `trae`, then asks `aiden` to independently test the result. It does not auto-fix failed tests:

```bash
acpx --approve-all --timeout 1800 flow run flows/quick-bugfix.flow.ts \
  --input-file flows/examples/quick-bugfix.input.json
```

Use `simple-feature` for local feature work. It plans with `aiden`, implements with `trae`, tests and reviews with `aiden`, then runs at most one automatic fix round if testing or review asks for `fix`:

```bash
acpx --approve-all --timeout 2400 flow run flows/simple-feature.flow.ts \
  --input-file flows/examples/simple-feature.input.json
```

Use `complex-feature-refactor` for cross-file features, refactors, migrations, and high-risk changes. It adds plan review and allows at most two automatic fix rounds before returning control to the orchestrator:

```bash
acpx --approve-all --timeout 3600 flow run flows/complex-feature-refactor.flow.ts \
  --input-file flows/examples/complex-feature-refactor.input.json
```

The flow runtime persists run state and artifacts under `~/.acpx/flows/runs/<runId>/`. Use those artifacts, plus native `acpx sessions read/history`, for recovery and inspection.
The bundled templates create the input `cwd` before starting agent nodes; a missing working directory otherwise causes acpx to fail spawning the agent subprocess.
For self-healing templates, the testing lane is an independent `aiden` agent with full flow permissions. It may run commands and create test artifacts, but prompts explicitly forbid unrelated production code changes; use `scripts/acpx-visualize` after completion to audit what it actually did.

## Permissions

- Use `--approve-reads` for planning, analysis, and review.
- Use `--approve-all` only for the implementation lane after scope is clear.
- Use `--deny-all` or `--non-interactive-permissions fail` for pure summarization.
- Avoid `--agent` raw command aliases except for temporary, probed commands.

## State Tracking

- Use acpx named sessions for multi-turn continuity: `-s plan`, `-s impl`, and `-s review`.
- For flow run status, inspect the lightweight live projection:
  ```bash
  RUN=~/.acpx/flows/runs/<runId>
  cat "$RUN/projections/live.json"
  ```
- To inspect the current flow node output, read `live.json.sessionBindings` for `agentName`, `cwd`, and `name`, then use a small tail:
  ```bash
  acpx --cwd <cwd> --format json <agentName> sessions read --tail 3 <name>
  ```
- For ordinary named sessions, prefer token-effective tails:
  ```bash
  acpx --cwd /repo --format json aiden sessions read --tail 3 review
  acpx --cwd /repo --format json trae sessions read --tail 3 impl
  ```
- Use `sessions history --limit 5` for a short history index. Avoid `sessions show` for routine tracking because it includes full `messages`.
- Do not tail `.stream.ndjson` directly. `sessions read --tail` already returns compact `entries[].textPreview`.
- Poll active flow/session status with a long-to-short cadence to avoid both stale waiting and context waste: 120s x 2, then 90s x 3, then 60s x 4, then stay at 60s unless the user asks for faster monitoring.
- Use `status` only as a process/session-owner health check; rely on prompt completion, flow run completion, or session history/read output for task output.

For low-frequency post-run audit reports, read [references/audit-visualization.md](references/audit-visualization.md) and use `scripts/acpx-visualize`.

## Failure Handling

- If a session is stale, use `<agent> sessions` and `<agent> sessions ensure --name <lane>`.
- If a prompt is stuck, use `<agent> cancel -s <lane>`, then retry once with a narrower prompt.
- If `trae` or `aiden` fails, do not silently route to unrelated agents. Run `scripts/acpx-e2e-validate.sh` only when the failure reason is unclear and a fresh session probe is needed.
- If `acpx` is absent, report the missing dependency instead of using `npx`.
