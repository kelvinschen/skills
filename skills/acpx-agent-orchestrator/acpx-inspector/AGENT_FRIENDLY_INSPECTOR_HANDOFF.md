# acpx Agent-Friendly Inspector Technical Handoff

Date: 2026-05-29
Status: implementation handoff, no code changes requested
Source repo inspected: `openclaw/acpx` at local commit `bd39a0b`

## 1. Objective

Build an agent-friendly inspector on top of `acpx` that lets an AI agent manage any
saved `acpx` session with low context cost.

The inspector should answer operational questions such as:

- What sessions exist for this repo, agent, cwd, or name?
- Which session is active, idle, dead, closed, or ambiguous?
- What happened in the last turn without dumping the full transcript?
- What can I safely do next: prompt, queue, cancel, set mode/model, close, export,
  or prune?
- What exact command should I run to perform that next operation?
- What evidence supports the recommendation?

The primary consumer is another AI agent or orchestrator, not a human terminal UI.
Human readability is useful, but stable, compact, machine-consumable output is the
main product surface.

## 2. Boundary Confirmation

### In Scope

- Read and summarize local `acpx` session records from `~/.acpx/sessions`.
- Read raw ACP JSON-RPC event streams from `*.stream*.ndjson`.
- Use existing `acpx` CLI commands for state-changing operations.
- Produce compact JSON summaries, JSONL event views, and command suggestions.
- Support all `acpx` agents because session identity is keyed by `agentCommand`,
  `cwd`, and optional session `name`.
- Work against both default and named sessions.
- Handle active, idle, dead, closed, imported, and ambiguous sessions.
- Preserve `acpx` stream invariants: no custom envelope in the authoritative
  ACP stream.

### Out of Scope for v1

- No changes to `acpx` core persistence format.
- No writes to `*.stream*.ndjson`.
- No direct mutation of `session.json` except through `acpx` CLI commands.
- No replacement for `acpx` queue ownership or IPC.
- No agent-specific protocol extensions beyond what `acpx` already exposes.
- No full transcript UI as the primary surface.
- No semantic judgment about whether the underlying agent answer is correct.
- No hidden auto-execution of destructive operations such as `close`, `prune`, or
  `cancel`; the inspector may recommend and provide commands, but execution should
  be explicit.

### Proposed v1 Product Boundary

The inspector is a read-mostly operational layer:

1. It reads local state and ACP history.
2. It projects that state into compact views.
3. It returns recommended next actions with exact `acpx` commands.
4. It may optionally execute safe commands if called with an explicit `--execute`
   flag in a future version.

This keeps the inspector useful to agents while avoiding a second control plane
that can diverge from `acpx`.

## 3. What "Agent-Friendly" Means

An output is agent-friendly only if it satisfies these constraints:

### Context Efficiency

- Default output must fit in a small prompt budget.
- Return summaries before raw details.
- Prefer counts, timestamps, state tokens, and short previews over full payloads.
- Include stable cursors or offsets so the caller can ask for more only when needed.
- Large file-read outputs and verbose tool results must be omitted or replaced with
  placeholders by default.

### Determinism

- Output must be stable JSON by default.
- Field names must not depend on rendering mode or terminal width.
- Status values should be enumerated, not prose-only.
- Suggested commands must be complete and copy-pasteable.

### Actionability

- Every snapshot should include `nextActions`.
- Each next action should include:
  - `id`: stable action id
  - `safety`: `read_only`, `reversible`, `interrupting`, or `destructive`
  - `command`: exact `acpx` command or `null` when manual review is needed
  - `why`: short reason
  - `requiresConfirmation`: boolean

### Evidence-First Summaries

- Summaries must cite the source fields that justify them:
  - session record id
  - stream segment path or event count
  - last prompt time
  - queue health
  - last exit code/signal
  - last ACP request/response id when available
- Avoid hallucinated state. If a field is not present, return `unknown`, `null`,
  or omit it according to schema.

### Low Surprise

- Read operations never mutate session state.
- Write operations should be delegated to `acpx`.
- Closed sessions must never be auto-resumed by the inspector.
- Ambiguous session resolution should fail with candidates rather than guessing.
- Raw ACP messages are available on demand, but never dumped by default.

## 4. acpx Capabilities and Formats Observed

### Session Model

`acpx` sessions are scoped by:

```text
(agentCommand, absoluteCwd, optionalName)
```

Prompt lookup performs a bounded directory walk from `cwd` to the nearest git root.
Named sessions are parallel streams within the same cwd and agent.

Reference files:

- `acpx/docs/sessions.md`
- `acpx/src/session/persistence/repository.ts`

### Session Files

Session state lives under:

```text
~/.acpx/sessions/
```

Relevant files per `acpx_record_id`:

```text
<encoded-acpx-record-id>.json
<encoded-acpx-record-id>.stream.ndjson
<encoded-acpx-record-id>.stream.1.ndjson
<encoded-acpx-record-id>.stream.2.ndjson
...
<encoded-acpx-record-id>.stream.lock
```

The stream files are authoritative history. The JSON record is a checkpoint and
index.

Reference files:

- `acpx/docs/2026-02-27-acpx-session-model.md`
- `acpx/src/session/event-log.ts`
- `acpx/src/session/events.ts`
- `acpx/src/session/persistence/parse.ts`

### Event Stream Contract

Each stream line is one raw ACP JSON-RPC message.

Allowed shapes:

```json
{ "jsonrpc": "2.0", "id": "req-1", "method": "session/prompt", "params": {} }
{ "jsonrpc": "2.0", "method": "session/update", "params": {} }
{ "jsonrpc": "2.0", "id": "req-1", "result": {} }
{ "jsonrpc": "2.0", "id": "req-1", "error": { "code": -32000, "message": "..." } }
```

Hard constraints from `acpx`:

- No synthetic `type`, `stream`, or custom envelope keys in persisted ACP streams.
- No key renaming.
- No acpx-only control events in the stream.
- JSON mode for live ACP commands emits raw ACP NDJSON.

Inspector implication: any enriched view must be a projection outside the source
stream.

### Session Record Fields

Important normalized fields from `SessionRecord`:

- `acpxRecordId`
- `acpSessionId`
- `agentSessionId`
- `agentCommand`
- `cwd`
- `name`
- `createdAt`
- `lastUsedAt`
- `lastSeq`
- `lastRequestId`
- `eventLog`
- `closed`
- `closedAt`
- `pid`
- `agentStartedAt`
- `lastPromptAt`
- `lastAgentExitCode`
- `lastAgentExitSignal`
- `lastAgentDisconnectReason`
- `title`
- `messages`
- `cumulative_token_usage`
- `request_token_usage`
- `acpx.current_mode_id`
- `acpx.current_model_id`
- `acpx.available_models`
- `acpx.available_commands`

Reference files:

- `acpx/src/types.ts`
- `acpx/src/session/persistence/parse.ts`

### Existing acpx Commands to Reuse

Read-like:

```bash
acpx <agent> sessions list --local --format json
acpx <agent> sessions show [name] --format json
acpx <agent> sessions history [name] --limit <n> --format json
acpx <agent> sessions read [name] --tail <n> --format json
acpx <agent> status [-s <name>] --format json
acpx config show --format json
```

Control:

```bash
acpx <agent> prompt [-s <name>] '<prompt>'
acpx <agent> --no-wait [-s <name>] '<prompt>'
acpx <agent> cancel [-s <name>]
acpx <agent> set-mode <mode> [-s <name>]
acpx <agent> set model <model-id> [-s <name>]
acpx <agent> set <key> <value> [-s <name>]
acpx <agent> sessions close [name]
acpx <agent> sessions export [name] --output <path>
acpx <agent> sessions prune --dry-run
```

The inspector should call these commands for mutations instead of editing files.

## 5. Proposed Inspector Surfaces

### CLI Shape

Name is provisional:

```bash
acpx-inspector sessions [filters]
acpx-inspector snapshot [session-ref]
acpx-inspector tail [session-ref] [--events <n>]
acpx-inspector actions [session-ref]
acpx-inspector read [session-ref] [--budget <tokens>] [--raw]
acpx-inspector diagnose [session-ref]
acpx-inspector command <action-id> [session-ref]
```

Recommended global options:

```bash
--state-dir <path>       # default: ~/.acpx
--cwd <path>             # filter or resolve by cwd
--agent <agent-or-cmd>   # filter or resolve by agent command
--name <name>            # named session
--id <id-or-suffix>      # acpxRecordId/acpSessionId/agentSessionId exact or suffix
--include-closed         # include closed sessions in resolution
--format json|jsonl|text # default json
--budget <tokens>        # target output budget, default small
--raw                    # include raw ACP payloads
```

### Programmatic API Shape

The CLI should be a thin wrapper over a library API:

```ts
type Inspector = {
  listSessions(input: ListSessionsInput): Promise<SessionListView>;
  getSnapshot(input: SessionRefInput): Promise<SessionSnapshot>;
  readHistory(input: ReadHistoryInput): Promise<HistoryView>;
  tailEvents(input: TailEventsInput): AsyncIterable<InspectorEvent>;
  suggestActions(input: SessionRefInput): Promise<ActionPlan>;
  diagnose(input: SessionRefInput): Promise<DiagnosisView>;
};
```

This lets future agent harnesses embed the inspector without shelling out.

## 6. Session Reference Resolution

Supported references:

1. `--id`: exact or unique suffix match against:
   - `acpxRecordId`
   - `acpSessionId`
   - `agentSessionId`
2. Scope tuple:
   - `--agent`
   - `--cwd`
   - optional `--name`
3. Directory walk:
   - mirror `acpx` prompt lookup when `--cwd` is provided.

Resolution output must include:

```json
{
  "resolution": {
    "status": "resolved",
    "strategy": "id_exact",
    "input": { "id": "abc123" },
    "matched": {
      "acpxRecordId": "abc123",
      "acpSessionId": "abc123",
      "agentSessionId": "provider-native-id"
    }
  }
}
```

Ambiguous output must include candidates, not a guessed session:

```json
{
  "resolution": {
    "status": "ambiguous",
    "candidates": [
      { "acpxRecordId": "abc123", "agentCommand": "codex", "cwd": "/repo", "name": "api" },
      { "acpxRecordId": "abc999", "agentCommand": "codex", "cwd": "/repo", "name": "docs" }
    ]
  }
}
```

## 7. Core Output Schemas

### SessionListView

```json
{
  "schema": "acpx-inspector.sessions.v1",
  "generatedAt": "2026-05-29T00:00:00.000Z",
  "stateDir": "/home/user/.acpx",
  "filters": {
    "agent": "codex",
    "cwd": "/repo",
    "includeClosed": false
  },
  "summary": {
    "total": 3,
    "active": 2,
    "closed": 1,
    "running": 1,
    "idle": 1,
    "dead": 0
  },
  "sessions": [
    {
      "acpxRecordId": "abc123",
      "acpSessionId": "abc123",
      "agentSessionId": "provider-native-id",
      "agentCommand": "codex",
      "cwd": "/repo",
      "name": "api",
      "title": "Fix auth tests",
      "status": "running",
      "closed": false,
      "lastPromptAt": "2026-05-29T00:00:00.000Z",
      "lastUsedAt": "2026-05-29T00:05:00.000Z",
      "lastSeq": 128,
      "mode": "auto",
      "model": "gpt-5.2",
      "preview": "Last assistant: Fixed the failing auth test...",
      "nextActionIds": ["tail", "queue_prompt", "cancel"]
    }
  ]
}
```

### SessionSnapshot

```json
{
  "schema": "acpx-inspector.snapshot.v1",
  "generatedAt": "2026-05-29T00:00:00.000Z",
  "session": {
    "acpxRecordId": "abc123",
    "acpSessionId": "abc123",
    "agentSessionId": "provider-native-id",
    "agentCommand": "codex",
    "cwd": "/repo",
    "name": "api",
    "status": "idle",
    "closed": false,
    "mode": "auto",
    "model": "gpt-5.2",
    "availableModels": ["gpt-5.2", "gpt-5.2[high]"],
    "lastPromptAt": "2026-05-29T00:00:00.000Z",
    "lastUsedAt": "2026-05-29T00:05:00.000Z",
    "lastSeq": 128,
    "lastRequestId": "req-42"
  },
  "conversation": {
    "messageCount": 18,
    "turnCountApprox": 9,
    "lastUserPreview": "Please fix the auth test...",
    "lastAssistantPreview": "Fixed by awaiting token setup...",
    "tokenUsage": {
      "input_tokens": 12000,
      "output_tokens": 2200
    }
  },
  "eventLog": {
    "activePath": "/home/user/.acpx/sessions/abc123.stream.ndjson",
    "segmentCount": 1,
    "maxSegments": 5,
    "lastWriteAt": "2026-05-29T00:05:00.000Z",
    "availableEventCount": 241,
    "tailCursor": {
      "segment": "active",
      "line": 241
    }
  },
  "health": {
    "classification": "ready",
    "reason": "saved session is idle and resumable"
  },
  "nextActions": [
    {
      "id": "prompt",
      "label": "Send follow-up prompt",
      "safety": "reversible",
      "requiresConfirmation": false,
      "command": "acpx --cwd /repo codex -s api '<prompt>'",
      "why": "Session is idle and open."
    }
  ]
}
```

### HistoryView

```json
{
  "schema": "acpx-inspector.history.v1",
  "sessionId": "abc123",
  "budget": {
    "targetTokens": 1200,
    "rawIncluded": false
  },
  "summary": {
    "latestOutcome": "completed",
    "latestStopReason": "end_turn",
    "openToolCalls": 0,
    "errors": 0,
    "permissionRequests": 1
  },
  "entries": [
    {
      "seqRange": [120, 128],
      "role": "assistant",
      "kind": "answer",
      "timestamp": "2026-05-29T00:05:00.000Z",
      "preview": "Fixed by awaiting token setup...",
      "evidence": {
        "requestId": "req-42",
        "eventMethods": ["session/update", "session/update"]
      }
    }
  ],
  "omitted": {
    "rawEvents": 113,
    "largePayloadBytes": 240000
  }
}
```

### ActionPlan

```json
{
  "schema": "acpx-inspector.actions.v1",
  "sessionId": "abc123",
  "status": "running",
  "actions": [
    {
      "id": "tail",
      "safety": "read_only",
      "requiresConfirmation": false,
      "command": "acpx-inspector tail --id abc123 --events 50",
      "why": "Session is currently running; tail gives progress without interrupting."
    },
    {
      "id": "cancel",
      "safety": "interrupting",
      "requiresConfirmation": true,
      "command": "acpx --cwd /repo codex cancel -s api",
      "why": "Queue owner is running; cancel may stop in-flight work."
    },
    {
      "id": "queue_prompt",
      "safety": "reversible",
      "requiresConfirmation": false,
      "command": "acpx --cwd /repo codex -s api --no-wait '<prompt>'",
      "why": "A prompt is already running; --no-wait queues the follow-up."
    }
  ]
}
```

## 8. Projection Rules

### Status Classification

Use `acpx status --format json` when resolving by scope because it already probes
queue-owner health. When reading by id only, derive best-effort status from record
and queue lease if accessible.

Recommended normalized statuses:

- `running`: queue owner healthy.
- `idle`: open saved session, no queue owner, no abnormal last exit.
- `dead`: queue owner expected but unavailable, or last exit code/signal abnormal.
- `closed`: `record.closed === true`.
- `no_session`: no match.
- `ambiguous`: multiple matches.
- `unknown`: local files are inconsistent or unreadable.

Map `acpx status` JSON value `alive` to inspector `running`.

### Conversation Projection

Use `SessionRecord.messages` for cheap previews:

- User text: `User.content[].Text` and `Mention.content`.
- Assistant text: `Agent.content[].Text`.
- Thinking: summarize count and presence; do not include by default.
- Tool use: represent as `[tool:<name>]` with status if inferable.
- Images/audio: use source or media type placeholder.

Do not rely on `sessions history` timestamps as precise per-message times because
current implementation uses `record.updated_at` for generated history entries.
Use event stream timestamps only when the ACP payload contains them.

### Event Stream Projection

Read segments oldest to newest:

1. `<id>.stream.<max>.ndjson`
2. ...
3. `<id>.stream.1.ndjson`
4. `<id>.stream.ndjson`

This matches `listSessionEvents`.

Projection should identify:

- outbound `session/prompt`
- inbound `session/update`
- `session/request_permission`
- request responses with `result.stopReason`
- JSON-RPC errors
- tool call/update notifications
- usage updates
- mode/model/config updates

Malformed lines:

- Ignore trailing partial line in tail mode.
- Report mid-file invalid JSON as a warning in non-strict mode.
- Provide `--strict` later if callers need validation failures.

### Budgeting

Default budgets:

- `sessions`: max 50 session rows, 160 chars preview each.
- `snapshot`: max 1.5k tokens equivalent.
- `read`: max 1.2k tokens equivalent unless `--budget` is passed.
- `tail`: max 50 events, compact projection only.

Budgeting algorithm:

1. Always include identity, status, and next actions.
2. Include latest user and assistant previews.
3. Include errors and permission requests before ordinary tool output.
4. Include tool names/statuses before tool raw inputs/outputs.
5. Omit raw payloads unless `--raw`.

## 9. Recommended Implementation Architecture

```text
packages/acpx-inspector/
  src/
    cli.ts
    index.ts
    state-dir.ts
    session-index.ts
    session-resolver.ts
    session-record.ts
    event-stream.ts
    projections/
      sessions.ts
      snapshot.ts
      history.ts
      actions.ts
      diagnose.ts
    acpx-cli.ts
    schemas.ts
    budget.ts
```

### Modules

`state-dir.ts`

- Resolve default state dir: `~/.acpx`.
- Allow override for tests and embedding.

`session-record.ts`

- Read `sessions/*.json`.
- Parse and validate `acpx.session.v1`.
- Keep parser tolerant enough for forward-compatible unknown fields.
- Prefer importing `acpx/runtime` types if available, but do not require private
  `src/*` imports in a published package.

`session-index.ts`

- Read existing session index if present.
- Fall back to scanning `*.json`.
- Sort by `lastUsedAt` descending.

`session-resolver.ts`

- Implement id, tuple, and directory-walk resolution.
- Return explicit ambiguity payloads.

`event-stream.ts`

- Discover and read stream segments.
- Tail efficiently without loading all history for large sessions.
- Parse raw JSON-RPC lines.
- Return both raw messages and compact projected events.

`projections/*`

- Convert records/events into stable inspector schemas.
- Keep all derived fields explainable from source evidence.

`acpx-cli.ts`

- Generate exact `acpx` commands.
- Optionally execute read commands in future if direct state read is insufficient.
- Never execute mutation by default.

`budget.ts`

- Enforce output-size policy.
- Drop low-value details in a deterministic order.

## 10. Use acpx Public APIs vs Direct File Reads

Recommended v1: direct file reads for inspection, `acpx` CLI for mutation.

Reasoning:

- The authoritative event stream is already file-based and local.
- `acpx` public runtime API is aimed at running sessions, not inspecting all local
  sessions.
- CLI commands provide stable mutation semantics and queue routing.
- Direct file reads avoid spawning adapters just to summarize state.

Avoid private imports from `acpx/src/*` if the inspector is a separate package.
Those internals are not exported in `package.json`.

If the inspector is later merged into `acpx`, reuse internal helpers:

- `listSessions`
- `resolveSessionRecord`
- `listSessionEvents`
- `probeQueueOwnerHealth`
- `parseSessionRecord`

## 11. Safety Model

### Read-Only by Default

All default commands must be read-only.

### Action Safety Levels

- `read_only`: no mutation, safe to auto-run.
- `reversible`: queues prompts or changes mode/model; can affect future behavior.
- `interrupting`: cancels active work.
- `destructive`: closes/prunes/deletes or discards history.

### Confirmation Policy

Require confirmation for:

- `cancel`
- `sessions close`
- `sessions prune`
- future `--execute` mutations with `safety !== read_only`

Do not require confirmation for:

- `snapshot`
- `sessions`
- `tail`
- `diagnose`
- command generation without execution

## 12. Example Agent Workflows

### Find the Right Session

```bash
acpx-inspector sessions --cwd /repo --agent codex --format json
```

Agent reads:

- active named sessions
- statuses
- previews
- recommended action ids

### Inspect Current State Cheaply

```bash
acpx-inspector snapshot --cwd /repo --agent codex --name api
```

Agent gets one compact object with identity, health, last turn summary, and next
commands.

### Follow a Running Turn

```bash
acpx-inspector tail --id abc123 --events 25
```

Agent gets projected progress events, not raw file dumps.

### Queue a Follow-Up

```bash
acpx-inspector command queue_prompt --id abc123
```

Returns:

```bash
acpx --cwd /repo codex -s api --no-wait '<prompt>'
```

The calling agent fills in `<prompt>` intentionally.

### Diagnose a Dead Session

```bash
acpx-inspector diagnose --id abc123
```

Expected output:

- status classification
- last exit code/signal
- last ACP error if present
- whether event stream has malformed lines
- whether session can likely be resumed
- safe next commands

## 13. Edge Cases

- Session id suffix matches multiple sessions: return `ambiguous`.
- `agentSessionId` absent: omit it and do not claim provider-native resume id.
- Closed session by scope: only include if `--include-closed`.
- Stream lock exists but owner dead: report warning; do not delete lock in v1.
- Stream segments rotated: read all available segments oldest to newest.
- Missing active stream but record exists: snapshot still works from record; event
  count is `0` or `unknown`.
- Corrupt record JSON: skip from default list with warning; include in `diagnose
  --state-dir` later.
- Unknown future session fields: preserve in raw mode, ignore in compact mode.
- Huge tool outputs: omit by default and report omitted byte/event counts.
- Permissions: surface `session/request_permission` and escalation metadata when
  present; do not auto-approve.

## 14. Validation Plan

Unit tests:

- Session record parser accepts current `acpx.session.v1`.
- Resolver handles exact id, suffix id, tuple, directory walk, no match, ambiguity.
- Event stream reader orders rotated segments correctly.
- Tail mode tolerates trailing partial line.
- Projection omits raw payloads by default.
- Budgeting keeps identity/status/actions even under tiny budgets.
- Action planner classifies safety correctly for running, idle, dead, closed.

Golden fixtures:

- Idle open session.
- Running session with queue owner.
- Dead session with abnormal exit.
- Closed session with history.
- Rotated event stream.
- Permission request event.
- Large read output event.
- Malformed stream line.

Integration tests:

- Use a temp `HOME` with copied fixture sessions.
- Run CLI commands and compare JSON output.
- Optionally run against `acpx` mock agent fixtures if inspector is developed in
  the same workspace.

Contract tests:

- Inspector never writes to `*.stream*.ndjson`.
- Inspector mutation execution is disabled unless explicit future `--execute`.
- JSON output validates against `schema` version.

## 15. Delivery Phases

### Phase 1: Read-Only MVP

- `sessions`
- `snapshot`
- `read --budget`
- direct file reader
- id/scope resolver
- JSON schemas
- action suggestions without execution

Acceptance:

- An agent can choose the correct session and decide whether to prompt, queue,
  cancel, or inspect more without reading raw history.

### Phase 2: Event Tail and Diagnosis

- `tail`
- `diagnose`
- event stream projections
- rotated segment support
- malformed stream warnings
- permission/error summaries

Acceptance:

- An agent can monitor running sessions and diagnose dead sessions within a small
  context budget.

### Phase 3: Optional Command Execution

- `--execute` for explicitly confirmed safe actions.
- Confirmation guardrails.
- Structured command result envelope.

Acceptance:

- Agents can run selected actions through the inspector while preserving acpx as
  the underlying control plane.

### Phase 4: Embedding API

- Export library API.
- Add typed schemas.
- Add streaming async iterator for tails.

Acceptance:

- External orchestrators can use inspector without shelling out.

## 16. Decisions to Confirm With Product Owner

These are the remaining boundaries to confirm before implementation:

1. Should v1 be strictly read-only, or may it execute `read_only` actions such as
   `tail` and `status` internally through `acpx`?
2. Should the inspector live as a standalone package under `acpx-inspector`, or
   eventually become an `acpx inspect` subcommand?
3. Is JSON the only required v1 output, or do we also need a human text renderer?
4. Should closed sessions be hidden by default? This handoff assumes yes.
5. Should default history summaries include thinking chunks, or only note their
   presence/count? This handoff assumes no thinking content by default.
6. Should action execution ever be supported, or should the inspector only emit
   recommended commands forever?
7. What is the default output budget target for the primary calling agent:
   500 tokens, 1200 tokens, or 3000 tokens?
8. Should the inspector redact file paths or tool inputs in shared environments,
   or assume local trusted execution?

## 17. Recommended v1 Defaults

If no further clarification is provided, implement with these defaults:

- Standalone package in `acpx-inspector`.
- Read-only by default.
- JSON output only for MVP.
- Closed sessions hidden unless `--include-closed`.
- No raw ACP payloads unless `--raw`.
- No thinking text by default.
- Default snapshot budget around 1200 tokens.
- Mutating operations returned as commands, not executed.
- Direct file reads for inspection, `acpx` CLI for mutations.

## 18. Handoff Summary

The inspector should not become a new session runtime. Its job is to make existing
`acpx` session state legible and actionable for agents.

The strongest design constraint is preserving the `acpx` raw ACP stream contract.
All enriched information must live in inspector projections, not in the
authoritative history files.

The core product promise is:

> Given any `acpx` session reference, return a compact, stable, evidence-backed
> snapshot plus safe next actions, without forcing the caller to ingest raw ACP
> logs or full conversation history.
