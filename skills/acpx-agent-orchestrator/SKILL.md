---
name: acpx-agent-orchestrator
description: Use when the user explicitly wants dynamic acpx workflow orchestration, reusable agent workflows, or multi-agent coding workflows backed by the acpx runtime. The Main Agent generates structured workflow specs; the skill CLI validates, previews, saves, runs, follows, resumes, diagnoses, and reports logical workflow runs.
---

# ACPX Agent Orchestrator

This skill implements runtime-driven dynamic workflow orchestration over
`acpx/runtime`.

Do not generate or execute `workflow.flow.ts`, `materialized.flow.ts`, or
`acpx flow run` artifacts. The public surface is
`skills/acpx-agent-orchestrator/scripts/acpx-orchestrator`.

## Core Workflow

1. Main Agent writes a workflow spec under `.acpx-orchestrator/drafts/` or uses
   a saved spec under `.acpx-orchestrator/workflows/`.
2. Validate and preview:

```bash
skills/acpx-agent-orchestrator/scripts/acpx-orchestrator validate --spec <workflow.spec.json>
skills/acpx-agent-orchestrator/scripts/acpx-orchestrator preview --spec <workflow.spec.json>
```

3. Run only after preview/approval. Use `--yes` when the user explicitly allows
   running:

```bash
skills/acpx-agent-orchestrator/scripts/acpx-orchestrator run --spec <workflow.spec.json> --yes
skills/acpx-agent-orchestrator/scripts/acpx-orchestrator run --workflow <saved-name> --yes
```

4. Follow/report logical runs by run id:

```bash
skills/acpx-agent-orchestrator/scripts/acpx-orchestrator follow <logical-run-id>
skills/acpx-agent-orchestrator/scripts/acpx-orchestrator report --run <logical-run-id>
skills/acpx-agent-orchestrator/scripts/acpx-orchestrator report --run <logical-run-id> --html --output report.html
skills/acpx-agent-orchestrator/scripts/acpx-orchestrator report serve --run <logical-run-id> --port 0
```

Use `--wait` when the user wants the command to advance until terminal status.
Use `diagnose <logical-run-id> --wait` for blocked runs; it prepares a
read-only recovery diagnostic without rerunning edit work.

HTML reports are observation-only. Snapshot HTML is self-contained, while
`report serve` streams run state over SSE and syncs with `startPending: false`.

## Spec Authoring

Specs use `schemaVersion: "acpx-orchestrator.workflow/v1"`, an explicit `root`
stage id, and authoring stage kinds:

- `agentTask`
- `discover`
- `fanout`
- `reduce`
- `fixLoop`
- `decisionGate`
- `summarize`

Prompt text is freeform, but variables are explicit and interpolated as
`${variableName}`. Agent outputs should end with one plain JSON object; the
parser selects the last balanced JSON object and tolerates non-JSON tail text.
Markdown code fences are tolerated by the parser but not required. Zod-backed
contracts validate outputs, deterministic
`checks[].result -> checks[].status` normalization is allowed, and one
schema-aware repair turn may run in the same session.

Preview must be treated as the approval artifact: check roles, edit modes,
fanout, partial-result policy, limits, and audit paths before using `--yes`.
Running does not save a reusable workflow; use `save <name> --spec <path>` as a
separate explicit action.

Read:

- [docs/runtime-orchestrator-refactor-implementation.md](docs/runtime-orchestrator-refactor-implementation.md)
- [docs/workflow-spec.md](docs/workflow-spec.md)
- [docs/cli.md](docs/cli.md)
- [docs/html-report-design.md](docs/html-report-design.md)

Examples live in `workflows/examples/`.
