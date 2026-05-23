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
| Async queueing | `--no-wait` |
| Cancel in-flight work | `acpx <agent> cancel -s <name>` |
| Session metadata | `acpx --format json <agent> sessions show <name>` |
| Recent/full output | `sessions history --limit <n>` and `sessions read --tail <n>` |
| Cleanup and portability | `sessions close/export/import/prune` |
| Permissions | `--approve-all`, `--approve-reads`, `--deny-all`, `--allowed-tools`, `--no-terminal` |
| Multi-agent workflow | `acpx flow run <file>` with `acpx/flows` |

## Status Boundary

`acpx <agent> status -s <name>` reports local queue owner and agent process health. It is useful for diagnosing whether a session owner exists, is alive, or has no active session.

Do not use `status` alone as proof that a specific prompt turn has completed. For task output and completion evidence, prefer token-effective reads:

```bash
acpx --format json <agent> sessions read --tail 3 <name>
acpx --format json <agent> sessions history --limit 5 <name>
```

For long-running multi-step orchestration, prefer `acpx flow run`, which records run state, node outputs, traces, and artifacts under `~/.acpx/flows/runs/<runId>/`.

## Token-Effective Tracking

Do not tail `.stream.ndjson` directly. It is the low-level event log and contains a lot of protocol detail. For main-agent tracking, use acpx projections and compact session reads.

Flow run status:

```bash
RUN=~/.acpx/flows/runs/<runId>
cat "$RUN/projections/live.json"
```

`live.json` exposes the flow status, current node, and `sessionBindings`. When a binding contains:

```json
{
  "handle": "impl",
  "agentName": "trae",
  "cwd": "/repo",
  "name": "simple-feature-impl-..."
}
```

read that agent's recent output:

```bash
acpx --cwd /repo --format json trae sessions read --tail 3 simple-feature-impl-...
```

`sessions read --tail` returns a small JSON envelope with `entries[]` containing `role`, `timestamp`, and `textPreview`. That is usually token-effective enough for a main agent to understand progress without a custom formatter.

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
acpx --cwd /repo --format json aiden sessions read --tail 3 review
acpx --cwd /repo --format json trae sessions read --tail 3 impl
```

Use `sessions history --limit 5` when you need a short history index. Use `sessions show` only when metadata or full messages are specifically needed; it is much heavier than `read --tail`.

For low-frequency post-run audit reports, see [audit-visualization.md](audit-visualization.md).

## Recommended Patterns

Simple planning or review:

```bash
acpx aiden -s review --approve-reads --no-terminal --cwd /repo \
  "Review the current diff for bugs, regressions, and missing tests."
```

Bounded implementation:

```bash
acpx trae -s impl --approve-all --cwd /repo -f task.md
```

Inspect recent output:

```bash
acpx --format json trae sessions read --tail 3 impl
```

Choose a multi-complexity workflow when a coding task should be delegated through agents:

```bash
acpx --approve-all --timeout 1800 flow run flows/quick-bugfix.flow.ts \
  --input-file flows/examples/quick-bugfix.input.json

acpx --approve-all --timeout 2400 flow run flows/simple-feature.flow.ts \
  --input-file flows/examples/simple-feature.input.json

acpx --approve-all --timeout 3600 flow run flows/complex-feature-refactor.flow.ts \
  --input-file flows/examples/complex-feature-refactor.input.json
```

`quick-bugfix` is a short implementation plus independent test lane. `simple-feature` adds plan/review and at most one automatic fix round. `complex-feature-refactor` adds plan review and at most two automatic fix rounds. None of these templates use infinite loops.

Agent testing is a quality signal, not a live tracking mechanism. The test lane runs as `aiden` with the same flow-level permissions as the rest of the run, so its "do not change unrelated production code" rule is enforced by prompt discipline and post-run audit rather than a separate acpx permission boundary. Use `scripts/acpx-visualize` after completion to inspect the test agent's tools, commands, file writes, and outputs.

The bundled flows create the target `cwd` before invoking ACP agents, because agent subprocesses cannot spawn with a missing working directory.
