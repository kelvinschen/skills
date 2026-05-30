# Dynamic Workflow Handoff

This file is a reference snapshot of the agreed ACPX orchestrator rewrite. It is
not the primary user-facing spec; use `docs/workflow-spec.md`, `docs/cli.md`,
and `schemas/workflow-spec.schema.json` for maintained interfaces.

## Intent

The skill has been rebuilt around Claude-style dynamic workflows:

- Main Agent writes a structured JSON workflow spec.
- The skill CLI validates, previews, compiles, saves, runs, follows, diagnoses,
  resumes, and reports logical runs.
- `acpx flow` remains the execution substrate, but the public authoring surface
  is not raw `.flow.ts`.
- Old public surfaces are removed: no `acpx-flow-run`, no `acpx-inspector`, no
  fixed flow templates, no one-shot/named-session SOP, and no legacy examples.

## Package Shape

- Skill-local npm package in `skills/acpx-agent-orchestrator/`.
- Node 20, Commander, Zod 4, tsdown, Vitest.
- Wrapper: `scripts/acpx-orchestrator`.
- Build output: `dist/`.
- JSON Schema is generated from Zod via `npm run generate:schema`.
- Runtime validation uses Zod; generated JSON Schema is for editors/docs/tools.

## Spec Model

Canonical spec version:

```json
{ "schemaVersion": "acpx-orchestrator.workflow/v1", "root": "plan" }
```

Stable authoring fields:

- `inputs`: lightweight declarations such as `{ "type": "string", "default": "" }`
- `roles`: fixed agent and mode per role
- `limits`: hard workflow caps; stage limits may only tighten
- `stages[]`: high-level author stages with `dependsOn`

Stage kinds:

- `agentTask`
- `discover`
- `fanout`
- `reduce`
- `fixLoop`
- `decisionGate`
- `summarize`

Graph rules:

- exactly one root
- `root` explicitly names that dependency-free root stage
- exactly one terminal `summarize`
- no arbitrary cycles; bounded loops only via `fixLoop`
- branch routing must use `decisionGate`
- decision targets must be downstream of the gate
- compiler generates internal `__blocked_stop`; authors do not declare it

## Prompt And Variables

- Prompt bodies are freeform and authored by Main Agent.
- Interpolation supports `${variableName}` only.
- Every placeholder must be declared in `variables`.
- Unused variables warn; undeclared variables fail.
- Sources use restricted dotted paths: `input.task`, `outputs.plan.summary`,
  `item.path`, `loop.latestFindings`, `run.logicalRunId`.
- Transform logic must be declared in `variables[].transform`.
- Built-ins: `compact`, `tail`, `json`, `quoteBlock`, `pathList`,
  `filterSeverity`, `severitySummary`, `join`, `default`.
- Missing values fail fast unless an explicit `default` transform is present.

## Roles, Permissions, Sessions

- Role categories are fixed: planning, implementation, validation, review,
  research, summarization, coordination.
- Role modes are `denyAll`, `readOnly`, `edit`.
- Permissions bind to role, not stage.
- Compiler rejects obvious role/stage conflicts.
- Stable session handles are inferred from role category.
- `summarizer` must be explicit, category `summarization`, mode `readOnly`.
- Diagnostic recovery uses `recovery_reviewer` if present; otherwise the runtime
  synthesizes a read-only review role for the diagnostic segment only.

## Output Contracts

Agents must end with a fenced `workflow-output` JSON block. The compiler injects
a safety/output footer into every agent prompt and validates common contract
shape in the generated flow.

Common envelope:

```json
{
  "status": "completed",
  "summary": "short summary",
  "artifacts": [],
  "nextFocus": "next step"
}
```

Role-derived additions:

- implementation: `changedFiles`, `checks`
- validation/review: `verdict`, `severityCounts`, `findings`, `checks`
- summarize: `finalVerdict`, `deliverables`, `changedFiles`, `checks`,
  `warnings`, `risks`, `nextActions`

`finalVerdict` values: `success`, `success_with_warnings`, `blocked`,
`failed`, `unknown`.

Run status mapping:

- `completed` only when the workflow finishes normally and final verdict is
  success or success_with_warnings.
- summarizer verdict `failed`, `blocked`, or `unknown` maps logical run to
  `blocked` unless the runtime/compiler has an unrecoverable failure.
- Runtime/compiler unrecoverable errors map to `failed`.
- Recovery diagnosis maps blocked runs to `diagnosed_blocked`.

## Compilation And Runtime

The compiler expands high-level stages into a self-contained acpx flow snapshot:

- agent stages become `acp` nodes
- program `discover`, `reduce`, and `decisionGate` become deterministic
  `compute` nodes
- full-flow `fanout` remains a bounded, visible serial item gate/item/aggregate
  chain because acpx flow rejects multiple outgoing edges
- the outer runtime can split a batchable fanout into standalone
  `fanout-batch` segments that consume `workflowInput.__fanoutBatchItems` and
  `runtime.preloadedOutputs`, aggregate item outputs, and then continue
  downstream stages from a continuation segment
- `fixLoop` becomes validation/route/fix nodes with switch edges
- `__blocked_stop` is generated per flow snapshot
- every agent call is followed by route/repair/finalization nodes so one
  format-only repair attempt is available before blocked

Current acpx flow has a single-outgoing-edge execution model, so the compiler is
conservative and rejects non-decision branching before materialization. Parallel
fanout is handled by the outer runtime as batch segments.

Run index layout:

```text
.acpx-orchestrator/runs/<logical-run-id>/
  run.json
  events.ndjson
  input.json
  workflow.spec.json
  workflow.flow.ts
  resolved-prompts/
  outputs/<author-stage-id>.json
  diagnostics/
  segments/<segment-id>/
```

`run.json` is atomically written under a local lock. Stage outputs are saved by
author stage id. Raw internal acpx trace remains under `~/.acpx/flows/runs/`.

## CLI Semantics

Primary command:

```bash
scripts/acpx-orchestrator <command>
```

Commands:

- `validate --spec`
- `preview --spec`
- `run --spec [--input-json] [--yes] [--wait]`
- `save <name> --spec [--overwrite] [--global]`
- `list workflows|runs|drafts`
- `show workflow|run|draft <name>`
- `follow <runId>`
- `diagnose <runId> [--wait]`
- `resume <runId> [--wait]`
- `report --run <runId>`
- `generate schema`
- `docs/error-codes.md` documents stable code families and severities

All relevant commands support `--json`.
`run`, `follow`, and `report --json` expose the common RunView projection so
the CLI, inspector-style views, and final Main Agent response can read the same
auditable shape.

Preview/approval:

- plan/approval is required by default
- `--yes` explicitly bypasses interactive approval
- preview must show risks and audit entry points
- approving a run does not save it for reuse
- saving is an explicit `save` action

Save semantics:

- project: `.acpx-orchestrator/workflows/<name>/`
- global: `~/.acpx-orchestrator/workflows/<name>/`
- no built-in version archive
- overwrite only via `--overwrite`
- saved directory includes spec, derived flow, README, schema/docs, wrapper, and
  built helper files from the current package build
- save fails rather than writing a partial helper snapshot when `dist/cli.mjs`
  or `dist/cli.js` is unavailable
- saved flow is directly runnable by acpx only with compiled segment input

Resume/diagnose:

- resume uses the original run snapshot only
- modified spec means new run
- resume retries failed workflow batches only and can tighten runtime policy in
  segment input, such as timeout, fanout item cap, skipped read-only fanout
  items, or partial read-only fanout
- resume policy overrides are validated against the run snapshot before retry:
  stage ids must exist, fanout overrides must target fanout stages, max item caps
  may only tighten the compiled cap, skipped item indexes must be in range, and
  partial-result resume is rejected for edit fanout
- outer runtime fanout scheduling also reads resume policy from segment input:
  pre-segment policy can tighten/skip items before batch materialization, and
  fanout-batch resume policy is localized from global item indexes to local
  batch indexes before rerun
- edit-capable workflows are not automatically rerun on resume
- diagnose appends a read-only recovery segment and does not rerun edit work
- `maxAgents` planning is worst-case and includes possible repair calls

## Tests And Acceptance

Acceptance tracks:

- CLI commands
- unit tests
- deterministic acpx contract e2e
- real agent e2e with `RUN_REAL_ACPX_E2E=1`
- docs and examples

The real e2e path is maintained but skipped by default because it depends on
local/team agents such as `trae` and `aiden`. It contains both a deterministic
real-acpx contract and a small code-task real agent workflow.
