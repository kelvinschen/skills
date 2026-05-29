# ACPX Inspector State Tracking Plan

## Objective

Use `acpx-inspector` as the centralized state-tracking surface for this skill. The orchestrator should stop stitching together PID logs, `sessions read`, `sessions history`, flow `live.json`, handoff files, and raw stream reads as separate default workflows. Instead, it should ask the inspector for compact session and flow projections, then use raw acpx artifacts only as fallback/debug evidence.

## Current Problem

State tracking is currently spread across several instruction surfaces:

- `SKILL.md` tells agents to combine PID/log checks, compact session reads, flow `live.json`, handoff files, and manual session binding lookup.
- `references/acpx-capabilities.md` repeats `sessions read --tail`, `sessions history`, `live.json`, and flow bundle tracking details.
- `references/audit-visualization.md` still points live tracking back to `live.json` plus session tails.
- Agents must remember which source applies to one-shot, named sessions, and flows, which increases context cost and makes stale or partial state more likely.

## Target Model

`scripts/acpx-inspector` is the default agent-facing state interface:

```bash
scripts/acpx-inspector sessions --cwd "$PWD" --limit 20
scripts/acpx-inspector snapshot --cwd "$PWD" --agent trae --name impl
scripts/acpx-inspector read --cwd "$PWD" --agent trae --name impl --tail 40 --budget 1200
scripts/acpx-inspector diagnose --cwd "$PWD" --agent trae --name impl
scripts/acpx-inspector follow --run-id <runId> --duration 10m --interval 60s --events 2
```

The inspector owns:

- session discovery and ambiguity handling;
- compact per-session state snapshots;
- budgeted recent history reads;
- health/error/queue diagnosis;
- low-context following for sessions and flow runs;
- recommended next actions and evidence fields in JSON outputs.

The orchestrator still owns:

- choosing one-shot, named session, or flow;
- launching acpx work;
- deciding whether to execute suggested commands;
- checking final repo state, diffs, and tests;
- generating post-run human audit reports when needed.

## Migration Phases

### Phase 1: Documentation Switch

Status: landed in this repo.

- Add `scripts/acpx-inspector` as the stable skill-local entrypoint.
- Update `SKILL.md` so all routine state tracking goes through inspector commands.
- Update capability and audit references so direct `sessions read`, `sessions history`, `live.json`, and raw stream reads are fallback/debug tools.
- Keep launch instructions unchanged: `acpx` and `scripts/acpx-flow-run` still start work.

### Phase 2: Operational Cleanup

Status: mostly landed for current orchestrator docs; keep applying this rule to new examples.

- Replace examples that parse `FLOW_RUN_OUTPUT` only to `cat live.json` with examples that pass `runId` or `runDir` to `scripts/acpx-inspector follow`.
- Where named-session examples run `sessions read --tail`, switch them to `snapshot`, `read`, or `follow`.
- Add short troubleshooting examples that call `diagnose` before retrying or cancelling a session.
- Avoid new instructions that require agents to inspect `~/.acpx/sessions` directly.

### Phase 3: Optional Wrapper Integration

Status: future, only if usage shows repeated friction.

- Teach `scripts/acpx-flow-run` to print an `inspectCommand=` line when run lookup succeeds.
- Optionally print a `followCommand=` line for flow runs.
- Keep this as convenience output only; inspector remains read-mostly and must not become a second control plane.

## Default Decision Table

| Situation | Default inspector command | Fallback only when needed |
| --- | --- | --- |
| Find sessions for this repo | `scripts/acpx-inspector sessions --cwd "$PWD"` | `acpx <agent> sessions list --local --format json` |
| Check a named session | `scripts/acpx-inspector snapshot --cwd "$PWD" --agent <agent> --name <name>` | `acpx --format json <agent> sessions show <name>` |
| Read recent session output | `scripts/acpx-inspector read --cwd "$PWD" --agent <agent> --name <name> --budget 1200` | `sessions read --tail 3` |
| Diagnose stuck or stale work | `scripts/acpx-inspector diagnose --cwd "$PWD" --agent <agent> --name <name>` | `acpx <agent> status -s <name>` plus logs |
| Follow active session | `scripts/acpx-inspector follow --cwd "$PWD" --agent <agent> --name <name>` | PID/log plus compact session read |
| Follow active flow | `scripts/acpx-inspector follow --run-id <runId>` or `--run-dir <runDir>` | `projections/live.json` and session binding lookup |
| Generate human audit | `scripts/acpx-inspector report flow --run-id <runId> --output <file>` or `scripts/acpx-visualize` | Manual bundle/session artifact reads |

## Agent Usage Rules

- Prefer `snapshot` before `read`; many decisions need status, next actions, and evidence rather than transcript text.
- Use `read` with `--budget` instead of increasing `--tail` blindly.
- Use `follow` for active work; do not hand-roll polling around `live.json`.
- Use `diagnose` before cancelling, retrying, or probing agent availability.
- Treat inspector action suggestions as recommendations; execute state-changing `acpx` commands explicitly.
- Do not use `tail --raw`, raw `.stream.ndjson`, or `sessions show` in routine tracking.

## Success Criteria

- A new orchestrator user can monitor named-session and flow work with the same command family, and can generate one-shot reports when events are captured.
- The default tracking path returns compact, deterministic output suitable for agent prompts.
- `status` is no longer used as completion evidence.
- Direct artifact reads are rare and justified as fallback/debug or post-run audit.
- Final completion still depends on repo-level evidence: `git status --short`, relevant diffs, and task-specific checks.
