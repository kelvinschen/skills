# ACPX Capabilities

This skill should reuse acpx native capabilities instead of rebuilding them in local helper scripts.

## Native Command Matrix

| Need | Native acpx capability |
| --- | --- |
| Persistent multi-turn work | `acpx <agent> -s <name> "prompt"` |
| Idempotent session setup | `acpx <agent> sessions ensure -s <name>` |
| Fresh session | `acpx <agent> sessions new -s <name>` |
| One-shot task | `acpx <agent> exec "prompt"` |
| Prompt file or stdin | `-f <path>` or `-f -` |
| Agent-session async queueing | `--no-wait` |
| Cancel in-flight work | `acpx <agent> cancel -s <name>` |
| Session metadata | `acpx --format json <agent> sessions show <name>` |
| Recent/full output | `sessions history --limit <n>` and `sessions read --tail <n>` |
| Cleanup and portability | `sessions close/export/import/prune` |
| Permissions | `--approve-all`, `--approve-reads`, `--deny-all`, `--allowed-tools`, `--no-terminal` |
| Multi-agent workflow | `acpx flow run <file>` with `acpx/flows`; use `scripts/acpx-flow-run` for per-lane agent profiles |

## Status Boundary

`acpx <agent> status -s <name>` reports local queue owner and agent process health. It is useful for diagnosing whether a session owner exists, is alive, or has no active session.

Do not use `status` alone as proof that a specific prompt turn has completed. For task output and completion evidence, prefer token-effective reads:

```bash
AGENT=trae
acpx --format json "$AGENT" sessions read --tail 3 impl
acpx --format json "$AGENT" sessions history --limit 5 impl
```

For long-running multi-step orchestration, prefer `acpx flow run`, which records run state, node outputs, traces, and artifacts under `~/.acpx/flows/runs/<runId>/`. `acpx flow run` should not be used as a foreground long wait from a constrained main-agent shell. Start long flows non-blockingly and monitor the run bundle instead.

Use acpx-native capabilities before adding shell mechanics. `--no-wait` is agent-session queueing for prompts such as `acpx <agent> --no-wait -s impl ...`.

## Token-Effective Tracking

Do not tail `.stream.ndjson` directly. It is the low-level event log and contains a lot of protocol detail. For main-agent tracking, use acpx projections and compact session reads.

Flow run status:

```bash
RUN=~/.acpx/flows/runs/<runId>
cat "$RUN/projections/live.json"
```

`live.json` exposes the flow `status`, current node details, and `sessionBindings`. When a binding contains:

```json
{
  "handle": "impl",
  "agentName": "<agent>",
  "cwd": "/repo",
  "name": "simple-feature-impl-..."
}
```

read that agent's recent output:

```bash
AGENT=trae
acpx --cwd /repo --format json "$AGENT" sessions read --tail 3 simple-feature-impl-...
```

`sessions read --tail` returns a small JSON envelope with `entries[]` containing `role`, `timestamp`, and `textPreview`. That is usually token-effective enough for a main agent to understand progress without a custom formatter.

For per-lane flow orchestration, use `scripts/acpx-flow-run` to materialize static node profiles and launch the workflow:

```bash
FLOW_LOG=/tmp/acpx-flow-simple-feature.log
scripts/acpx-flow-run simple-feature \
  --input-file flows/examples/simple-feature.input.json \
  --log "$FLOW_LOG"

RUN=$(ls -td ~/.acpx/flows/runs/* 2>/dev/null | head -1)
cat "$RUN/projections/live.json"
```

The launcher defaults to background execution and `--approve-all`. Flow templates provide default profiles. Input role fields override template defaults, and environment variables override input role fields. A flow input may set `handoffDir`; otherwise the default handoff path is `<repo>/tmp/flow_handoffs/<runId>/<node>.md` and the shared memory index is `<repo>/tmp/flow_handoffs/<runId>/flow-memory.md`.

```bash
PLAN_AGENT=aiden IMPLEMENT_AGENT=trae \
  scripts/acpx-flow-run simple-feature --input-file flows/examples/simple-feature.input.json
```

If multiple flows may be active, correlate the run bundle with `flowName`, `startedAt`, and the log path before treating the newest directory as the target run.

Bundled flow templates instruct each lane agent to write its own handoff file and append a compact index entry to `flow-memory.md`. Downstream prompts receive compact references to the memory file and handoff files, not full upstream agent output. Prefer flow outputs, `flowMemoryPath`, the memory index, and handoff paths for monitoring; use full session reads only when deeper inspection is needed.
Shared prompt wording for bundled flows lives in `flows/shared/prompt-templates.ts`; update that file before duplicating prompt text in individual flow templates.

Recommended polling cadence for active work:

| Phase | Interval | Count |
| --- | ---: | ---: |
| Early long-task window | 120s | 2 |
| Narrowing window | 90s | 3 |
| Steady tracking | 60s | 4 |
| Extended tracking | 60s | repeat as needed |

At each poll, read `live.json` or the relevant `sessions read --tail 3` output. Do not poll faster than 60s by default; shorten only when the user explicitly needs near-real-time monitoring.

For ordinary named sessions:

```bash
REVIEW_AGENT=aiden
IMPLEMENT_AGENT=trae
acpx --cwd /repo --format json "$REVIEW_AGENT" sessions read --tail 3 review
acpx --cwd /repo --format json "$IMPLEMENT_AGENT" sessions read --tail 3 impl
```

Use `sessions history --limit 5` when you need a short history index. Use `sessions show` only when metadata or full messages are specifically needed; it is much heavier than `read --tail`.

For low-frequency post-run audit reports, see [audit-visualization.md](audit-visualization.md).

## Recommended Patterns

Simple planning or review:

```bash
REVIEW_AGENT=aiden
acpx "$REVIEW_AGENT" -s review --approve-reads --no-terminal --cwd /repo \
  "Review the current diff for bugs, regressions, and missing tests."
```

Bounded implementation:

```bash
IMPLEMENT_AGENT=trae
acpx "$IMPLEMENT_AGENT" -s impl --approve-all --cwd /repo -f task.md
```

Inspect recent output:

```bash
AGENT=trae
acpx --format json "$AGENT" sessions read --tail 3 impl
```

Choose a multi-complexity workflow when a coding task should be delegated through agents. Start long flow runs non-blockingly. Do not rely on foreground `--timeout` values to outlast the main agent's shell limit:

```bash
FLOW_LOG=/tmp/acpx-flow-quick-bugfix.log
scripts/acpx-flow-run quick-bugfix \
  --input-file flows/examples/quick-bugfix.input.json \
  --log "$FLOW_LOG"

FLOW_LOG=/tmp/acpx-flow-simple-feature.log
scripts/acpx-flow-run simple-feature \
  --input-file flows/examples/simple-feature.input.json \
  --log "$FLOW_LOG"

FLOW_LOG=/tmp/acpx-flow-complex-feature-refactor.log
scripts/acpx-flow-run complex-feature-refactor \
  --input-file flows/examples/complex-feature-refactor.input.json \
  --log "$FLOW_LOG"
```

`quick-bugfix` is a short implementation plus independent test lane. `simple-feature` adds planning, same-session validation review, and at most one automatic fix round. `complex-feature-refactor` adds plan review, same-session validation review, and at most two automatic fix rounds. None of these templates use infinite loops.

Agent validation is a quality signal, not a live tracking mechanism. Same-session validation runs with the same flow-level permissions as the rest of the run, so its "do not edit production code in validation" rule is enforced by prompt discipline and post-run audit rather than a separate acpx permission boundary. Use `scripts/acpx-visualize` after completion to inspect validation tools, commands, file writes, and outputs.

The bundled flows create the target `cwd` before invoking ACP agents, because agent subprocesses cannot spawn with a missing working directory.
