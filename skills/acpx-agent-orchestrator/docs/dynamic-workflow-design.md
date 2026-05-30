# ACPX Agent Orchestrator Dynamic Workflow Redesign

## Status

Draft design. This document captures the agreed direction for a full rewrite of
`skills/acpx-agent-orchestrator/`.

This rewrite is intentionally not compatibility-preserving. The old public
surface will be removed rather than adapted.

## Goals

- Align the orchestrator with Claude Code dynamic workflow principles:
  - Main Agent generates a task-specific workflow.
  - Runtime executes the workflow outside the main conversation.
  - Intermediate state is held in run artifacts, not the main conversation.
  - Workflows can be previewed, approved, saved, and reused.
- Keep `acpx flow` as the execution substrate.
- Replace fixed flow templates with dynamically generated structured specs.
- Make saved workflows human-editable, auditable, and reusable.
- Support fanout, reduce, fix loops, blocked recovery, and resumable logical runs.
- Provide agent-friendly CLI errors and RunView projections.
- Provide maintained fake and real e2e tests, including real `trae` and `aiden` paths.

## Non-Goals

- Preserve legacy commands, templates, or SOPs.
- Keep one-shot or named-session orchestration as first-class skill paths.
- Build a hidden second LLM generator inside the CLI.
- Support arbitrary user-authored TypeScript or shell stages in workflow specs.
- Implement schema migrations in v1.
- Make HTML reports mandatory in v1.

## Claude Dynamic Workflow Alignment

Claude Code dynamic workflows appear to use generated JavaScript workflow scripts,
a controlled runtime, subagent scheduling, progress views, resumable cached agent
results, and saved workflow commands.

Our design mirrors the control model while adapting it to `acpx flow`:

- Main Agent generates a structured workflow spec.
- `acpx-orchestrator` validates, previews, compiles, runs, tracks, and reports.
- The compiled flow snapshot is executable by `acpx flow`.
- Logical run state is tracked above native acpx run bundles.
- Full-flow snapshots conservatively materialize bounded fanout as visible
  gate/item/aggregate nodes; the outer runtime can split batchable fanout into
  batch segments under the global concurrency pool.

## Legacy Removal

This rewrite removes the previous public surface.

Removed:

- `scripts/acpx-flow-run`
- `scripts/acpx-inspector`
- fixed flow templates under `flows/`
- one-shot and named-session SOPs in `SKILL.md`
- legacy examples
- legacy references as user-facing documentation

Implementation ideas may be mined before deletion, especially:

- compact projection patterns
- acpx run lookup and bundle reading
- report rendering ideas
- real acpx e2e harness experience

No compatibility shim is required.

## Package Layout

The new implementation is a formal npm package embedded inside the skill.

```text
skills/acpx-agent-orchestrator/
  package.json
  tsconfig.json
  tsdown.config.ts
  src/
    cli.ts
    commands/
    schema/
    model/
    compiler/
    runtime/
    run-index/
    projections/
    variables/
    transformers/
    acpx/
    reports/
  scripts/
    acpx-orchestrator
  schemas/
    workflow-spec.schema.json
  workflows/
    examples/
  docs/
    workflow-spec.md
    cli.md
    dynamic-workflow-design.md
```

The skill-local wrapper `scripts/acpx-orchestrator` is the primary entry point.
Global installation is not required. Future publishing or `npx` support can be
considered later.

Tooling:

- Node 20 minimum.
- npm scripts.
- `tsdown` for bundling.
- `vitest` for tests.
- Commander for CLI parsing.
- Zod 4 as the top-level schema and type source of truth.
- JSON Schema is generated from Zod for editors/docs/external tooling.
- Runtime validation uses Zod, not Ajv.

## Workflow Spec Model

The Main Agent writes `workflow.spec.json` directly. The CLI does not run a
hidden LLM to generate or repair specs.

Top-level shape:

```json
{
  "schemaVersion": "acpx-orchestrator.workflow/v1",
  "name": "safe-feature-change",
  "description": "Plan, implement, validate, and summarize a scoped change.",
  "root": "plan",
  "inputs": {},
  "roles": {},
  "limits": {},
  "stages": []
}
```

`schemaVersion` is required and exact-match only. There is no v1 migration
system.

### Inputs

Inputs use lightweight custom type declarations, not full JSON Schema inside the
spec.

```json
{
  "inputs": {
    "task": { "type": "string", "default": "" },
    "cwd": { "type": "path", "default": "." },
    "testHints": { "type": "string", "default": "" },
    "modules": { "type": "array<string>", "default": [] }
  }
}
```

The external generated `workflow-spec.schema.json` validates the shape of this
declaration.

The compiler validates declared defaults against these lightweight types, and
`run --input-json` is checked before the logical run is prepared. Missing runtime
inputs receive declared defaults; unknown runtime inputs are warnings.

### Roles

Roles separate workflow semantics from concrete agents. Agent selection is fixed
in the spec because workflows run locally or within a known team environment.

```json
{
  "roles": {
    "implementer": {
      "category": "implementation",
      "agent": "trae",
      "mode": "edit"
    },
    "validator": {
      "category": "validation",
      "agent": "aiden",
      "mode": "readOnly"
    },
    "summarizer": {
      "category": "summarization",
      "agent": "claude",
      "mode": "readOnly"
    }
  }
}
```

Mode is bound to role only. Stages do not override permissions.

Mode mapping:

- `denyAll` maps to deny/fail permissions where supported.
- `readOnly` maps to read-only acpx permissions where supported.
- `edit` maps to edit-capable acpx permissions.

If acpx flow only supports flow-level permissions, the runtime may fall back to
prompt/audit enforcement and must show this in preview and RunView.

### Stage Graph

Authoring uses `stages[] + dependsOn`.

Rules:

- No global `edges[]`.
- `root` explicitly names the single dependency-free root stage.
- Dependencies are explicit.
- Single root stage.
- Single `summarize` stage.
- Graph cycles are forbidden.
- Loops are expressed only through `fixLoop`.
- Routing may jump to stage IDs, but compiler validates that dependencies are
  satisfied along that path.

Authoring stage kinds:

- `agentTask`
- `discover`
- `fanout`
- `reduce`
- `fixLoop`
- `decisionGate`
- `summarize`

`blockedStop` is compiler-internal and generated per segment.

## Prompt Variables

Prompt text is freeform, but interpolation is constrained.

Only `${variableName}` placeholders are allowed. Variables must be declared in
the stage `variables` array.

```json
{
  "variables": [
    { "name": "task", "source": "input.task" },
    {
      "name": "plan",
      "source": "outputs.plan.summary",
      "transform": [
        { "fn": "compact", "args": { "maxChars": 3000 } }
      ]
    }
  ],
  "prompt": "Task:\n${task}\n\nPlan:\n${plan}"
}
```

Rules:

- Missing variable declaration is a compile error.
- Declared-but-unused variable is a warning.
- Variable names must match `/^[A-Za-z_][A-Za-z0-9_]*$/`.
- Literal placeholder syntax can be escaped.

### Source Paths

`variables[].source` uses restricted dotted paths:

- `input.task`
- `outputs.plan.summary`
- `outputs.validate.severityCounts.P0`
- `loop.latestFindings`
- `loop.round`
- `item`
- `item.path`
- `run.logicalRunId`

Internally, paths are tokenized or converted to JSON Pointer. Full JSONPath,
JMESPath, arbitrary JavaScript, wildcard, and filter expressions are not
supported in v1.

### Transformers

Transformers are fixed built-ins in v1. Specs cannot define inline transformer
code.

Initial transformer list:

- `compact`
- `tail`
- `json`
- `quoteBlock`
- `pathList`
- `filterSeverity`
- `severitySummary`
- `join`
- `default`

Transformer failures are fail-fast by default. Only explicit `default` allows
optional/missing-value degradation.

## Output Contracts

Agent outputs must end with a fenced JSON block:

````markdown
```workflow-output
{
  "status": "completed",
  "summary": "...",
  "artifacts": [],
  "nextFocus": "..."
}
```
````

Contracts are strict Zod schemas and are compiled into the self-contained flow
parse helpers.

Common fields:

- `status: "completed"|"blocked"`
- `summary`
- `artifacts`
- `nextFocus`
- `data` for extension

Validation/review adds:

- `verdict: "pass"|"fix"|"blocked"|"unknown"`
- `severityCounts`
- `findings`
- `checks`

Implementation adds:

- `changedFiles`
- `checks`

Summarize adds:

- `finalVerdict: "success"|"success_with_warnings"|"blocked"|"failed"|"unknown"`
- `deliverables`
- `changedFiles`
- `checks`
- `warnings`
- `risks`
- `nextActions`

## Safety Boundaries

The compiler injects an immutable safety/output footer into every agent prompt.
The user-authored prompt body remains freeform, but the footer is not removable.

Footer content includes:

- role and mode boundary
- cwd and scope
- output JSON contract
- unrelated-change guardrails
- read-only or edit-specific constraints
- instruction not to leak secrets in output

Spec authoring does not expose shell stages. Shell/compute glue is compiler or
runtime internal and tightly limited.

Path scope defaults to `input.cwd`/repo root. Paths, globs, discover results, and
fanout item paths must resolve inside cwd unless narrower scope rules are
declared.

## Decision Gates

`decisionGate` supports two modes:

- programmatic rules by default
- explicit agent decision for semantic/high-risk judgment

Programmatic rules use restricted boolean objects:

```json
{
  "when": {
    "all": [
      { "source": "outputs.validate.verdict", "op": "eq", "value": "fix" },
      { "source": "outputs.validate.severityCounts.P0", "op": "gte", "value": 1 }
    ]
  },
  "to": "fix_loop"
}
```

Supported boolean structure:

- `all`
- `any`
- `not`

Supported ops:

- `eq`
- `neq`
- `gt`
- `gte`
- `lt`
- `lte`
- `in`
- `exists`
- `empty`

Rules match top-to-bottom. `default` is required and may be `"blocked"` or a
stage id. Non-blocked defaults are allowed but preview must highlight them.

## Discover, Fanout, Reduce

### Discover

`discover` is a first-class stage kind.

It can be programmatic or agent-driven:

- `gitChangedFiles`
- `glob`
- agent discovery

All discover outputs are JSON arrays. Agent discovery must declare a max item
limit. If items contain paths, compiler validates path scope.

Items may be arbitrary JSON values. Path-like items should use a recommended
shape:

```json
{
  "id": "billing_api",
  "kind": "module",
  "path": "src/billing",
  "label": "Billing API",
  "reason": "Touches tenant isolation"
}
```

### Fanout

Fanout supports read-only and edit roles.

General policy rules:

- global concurrency pool applies
- stage limits can only narrow global limits
- node naming uses `item.id`, else hash of `item.path`, else index
- item mapping is stored in the run index
- failed/blocked item does not block other items in the same batch from
  finishing
- Full acpx snapshots materialize bounded fanout as a serial acpx item chain
  because acpx flow rejects multiple outgoing edges. Higher-concurrency fanout
  runs through outer runtime batch segments.

Edit fanout is allowed and is a user/spec-author tradeoff.

Edit fanout policy rules:

- supports concurrency under global/stage limits through outer runtime batch
  segments; each batch remains an ordinary acpx flow segment
- preview highlights higher risk
- disjoint item scope is recommended but only warning-level
- partial edit fanout is allowed but high risk and defaults false
- failed/blocked edit item is not automatically rerun
- recovery uses diagnose, new run, or follow-up workflow
- edit fanout must be followed by a read-only reconcile/reduce stage before
  summarize

### Reduce

When fanout or multiple validation outputs affect routing, results must be
reduced before decision.

`reduce` supports:

- `mode: "agent"` by default
- `mode: "program"` for mechanical aggregation only

Program reducers use built-in operations only. No inline JavaScript reducers.

## Fix Loop

`fixLoop` is a dedicated high-level stage kind and compiles into ordinary
validation/decision/fix nodes.

It owns policy such as:

- `maxRounds`
- `onUnknown`
- `onExhausted`
- severity routing
- final validation
- fix round accounting

`onUnknown` and `onExhausted` should be explicit, usually `"blocked"`.

## Limits and Concurrency

Top-level `limits` are hard caps. Stage-level limits may only narrow them.

Suggested limits:

```json
{
  "maxAgents": 32,
  "maxConcurrency": 4,
  "maxFanoutItems": 16,
  "maxFixRounds": 2,
  "stageTimeoutMinutes": 60,
  "maxOutputChars": 12000
}
```

Every action that starts an agent counts toward `maxAgents`, including:

- `agentTask`
- agent `discover`
- agent `reduce`
- agent `decisionGate`
- fix loop validator/fixer calls
- fanout item agents
- output repair calls
- agent summarizers

The whole logical workflow has one global concurrency pool. If acpx flow cannot
enforce a reliable global pool, v1 compiler/runtime must be conservative:

- ordinary non-fanout stages are serialized
- fanout can be batched
- each batch can be a separate segment if needed
- concurrent fanouts are not allowed unless the global pool can be enforced

## Materialized Flow

Generated `.flow.ts` snapshots are fully self-contained.

They may import `acpx/flows`, and minimal Node builtins only when necessary.
They do not import helpers from mutable skill source paths.

Saved workflow:

```text
.acpx-orchestrator/workflows/<name>/
  workflow.spec.json
  workflow.flow.ts
  README.md
```

Run segment:

```text
.acpx-orchestrator/runs/<run-id>/segments/<segment-id>/
  materialized.flow.ts
  input.json
```

The external runtime resolves prompts before segment execution and writes:

```text
runs/<run-id>/resolved-prompts/<segment-id>/<stage-id>.md
```

The flow reads a compiled prompt map from segment `input.json`. Direct acpx
execution of a saved `workflow.flow.ts` requires compiled segment input, not raw
workflow input.

The compiler can also produce downstream slices and standalone fanout batch
segments. Batch segment input carries `workflowInput.__fanoutBatchItems`,
`runtime.preloadedOutputs`, `runtime.fanoutStageId`, and item range metadata.
The outer scheduler uses these snapshots to run fanout batches without changing
the saved spec or full workflow snapshot.

## Output Repair

Output JSON parse/schema failure is repaired inside the materialized flow.

Conceptual expansion:

```text
stage_call
  -> parse
     valid -> next
     invalid -> repair_call
       -> parse_repair
          valid -> next
          invalid -> blockedStop
```

Repair prompt rules:

- use the same role/session
- do not redo task
- only emit valid `workflow-output` JSON
- include parse/schema error and expected contract
- repair call counts as an agent call

Repair failure should produce structured blocked output when possible, not crash
the segment.

## Blocked and Resume Semantics

`blockedStop` is compiler-internal and generated per segment.

Blocked paths:

- expected blocked states route to internal `blockedStop`
- runtime blocked states are recorded in the logical run index
- blocked paths do not run final summarizer

Logical run statuses:

- `pending`
- `running`
- `completed`
- `blocked`
- `diagnosed_blocked`
- `failed`
- `cancelled`

`completed` means the workflow reached a successful or acceptable final verdict.
Need-human-decision outcomes are `blocked`.

`failed` is reserved for unrecoverable runtime/compiler/tooling failures such as
corrupt run index or lost data needed for resume.

Resume uses the run snapshot only. v1 does not support resume with current
modified spec. If the spec changes, start a new run.

Allowed resume overrides are runtime policy knobs only, such as:

- increase timeout
- max fanout items
- drop/skip blocked item
- allow partial fanout
- rerun read-only stage or batch

These overrides are written into segment input metadata for the retry. They must
not mutate `workflow.spec.json`, the compiled graph, prompts, roles, or agents.

Edit stage or edit item rerun is not allowed. Edit failures can use
`resume --diagnose`, which launches a read-only recovery reviewer.

## Run Index

Run state is maintained above acpx run bundles.

```text
.acpx-orchestrator/runs/<logical-run-id>/
  run.json
  events.ndjson
  input.json
  workflow.spec.json
  workflow.flow.ts
  resolved-prompts/
  segments/
  outputs/
```

Rules:

- `run.json` stores core state and references.
- stage outputs are stored by author stage id:
  - `outputs/<stage-id>.json`
  - `outputs/<fanout-id>/<item-node-id>.json`
- `events.ndjson` is append-only audit log.
- `run.json` is written atomically by temp file + rename.
- write operations use local `lockfile`.

## RunView

RunView is the unified machine-readable projection for:

- preview
- follow/status
- final response
- reports
- Main Agent consumption

RunView is a projection, not the source of truth.

Suggested fields:

```json
{
  "logicalRunId": "...",
  "workflowName": "...",
  "status": "completed",
  "finalVerdict": "success_with_warnings",
  "summary": "...",
  "warnings": [],
  "roles": [],
  "stages": [],
  "agentUsage": {},
  "artifacts": [],
  "commands": {}
}
```

## CLI

Use one main command:

```text
scripts/acpx-orchestrator <subcommand>
```

Subcommands:

- `validate`
- `preview`
- `run`
- `save`
- `list workflows|runs|drafts`
- `show workflow|run|draft`
- `follow`
- `resume`
- `diagnose`
- `report`
- `generate` for scaffolding only

Rules:

- all commands support `--json`
- `run` validates automatically
- preview/approval is not skipped by default
- `--yes` skips approval
- `--wait` waits for terminal status
- `save <name> --spec <path>`
- `follow` targets logical run id or run dir, not workflow name

## Drafts and Saved Workflows

Main Agent writes draft specs under:

```text
<repo>/.acpx-orchestrator/drafts/<timestamp-or-slug>.workflow.spec.json
```

Drafts are preserved after run. They are not reusable saved workflows.

Each run copies complete spec and flow snapshots into the run index. Resume does
not depend on draft paths.

Saved workflows:

```text
<repo>/.acpx-orchestrator/workflows/<name>/
  workflow.spec.json
  workflow.flow.ts
  README.md
  helper/
```

Global workflows:

```text
~/.acpx-orchestrator/workflows/<name>/
  workflow.spec.json
  workflow.flow.ts
  README.md
  helper/
```

Save behavior:

- `save <name>` creates if missing and rejects if existing.
- `save <name> --overwrite` replaces existing files.
- `save <name> --global` writes to global workflow directory.

No built-in versions archive is maintained. Saved workflow directories include a
self-contained helper snapshot with schema/docs/wrapper/build artifacts when
available. `workflow.flow.ts` is a derived snapshot and direct acpx execution
requires compiled segment input.

## acpx Integration

Segment execution is non-blocking by default. `--wait` can wait for terminal
status.

Run lookup:

- prefer parsing acpx stdout/run output for run id
- fallback to scanning `~/.acpx/flows/runs` manifests

Read results through an abstraction:

```text
acpx.readFlowResult(runDir)
```

Failure classes:

- transient
- blocked-capable
- fatal

The old inspector is not kept as a primary path.

## Error Schema

Agent-friendly errors are a core v1 capability.

All JSON errors include:

- `code`
- `severity`
- `path` as JSON Pointer
- `message`
- `suggestions`
- optional docs reference

Severity:

- `warning`
- `error`
- `fatal`

Suggestions are free-text arrays, not patch actions.

Code families:

- `SCHEMA_*`
- `GRAPH_*`
- `VARIABLE_*`
- `ROLE_*`
- `LIMIT_*`
- `OUTPUT_*`
- `DECISION_*`
- `FANOUT_*`
- `RUNTIME_*`
- `RESUME_*`
- `ACPX_*`
- `INTERNAL_*`

Codes should be documented and not casually renamed.

## Reports and Docs

Reports are Markdown-first. HTML can be added later. JSON RunView is the machine
source.

Report reads logical run index + RunView. Raw acpx trace is debug fallback only.

Minimum docs:

- `README.md`
- `docs/workflow-spec.md`
- `docs/cli.md`
- `docs/error-codes.md`
- `docs/dynamic-workflow-design.md`
- generated `schemas/workflow-spec.schema.json`

New spec examples should be provided:

- `simple-feature.workflow.spec.json`
- `review-only-fanout.workflow.spec.json`
- `edit-fanout-reconcile.workflow.spec.json`
- `bugfix-fixloop.workflow.spec.json`

## Testing

Use both fake and real e2e.

Default tests:

- schema/normalize tests
- variable path and interpolation tests
- transformer tests
- compiler lint tests
- materialized flow snapshot tests
- run-index read/write tests
- fake acpx runtime tests
- RunView projection snapshot tests

Real e2e is a separate maintained command, not part of default `npm test`.

Real e2e depends on:

- `acpx`
- `trae`
- `aiden`

Real e2e categories:

- deterministic contract e2e
- small coding task e2e

Real edit e2e runs only in test-created temp repos. The harness constrains both
`cwd` and prompts to avoid touching user workspaces. `KEEP_E2E_TMP=1` can retain
temp repos for debugging.

## Implementation Sequence

1. Package skeleton, Zod schema, validate/lint, examples.
2. Compiler, self-contained flow materialization, prompt rendering, output
   parse/repair.
3. Logical runtime, run index, acpx integration, RunView, follow/report.
4. Discover/fanout/reduce/fixLoop, batching, resume, diagnose.
5. Real e2e, docs, `SKILL.md` rewrite, old file cleanup.

Fake/unit tests should be added throughout.

## Acceptance Criteria

- `scripts/acpx-orchestrator validate --spec <example>` works.
- `preview --json` outputs RunView preview.
- `run --spec <example> --yes --wait` works in fake e2e.
- Saved workflow `save`, `run`, `show`, and `list` work.
- Logical run index is created and resumable.
- Markdown report is generated.
- Zod schema generates JSON Schema artifact.
- Unit/fake tests pass.
- Real e2e command exists and runs when `acpx`, `trae`, and `aiden` are
  available.
- `SKILL.md` describes only the new dynamic workflow model.
- v1 implements all authoring stage kinds:
  - `agentTask`
  - `discover`
  - `fanout`
  - `reduce`
  - `fixLoop`
  - `decisionGate`
  - `summarize`
