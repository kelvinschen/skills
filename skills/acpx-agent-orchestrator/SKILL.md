---
name: acpx-agent-orchestrator
description: Use when the user explicitly wants dynamic acpx workflow orchestration, reusable agent workflows, or multi-agent coding workflows backed by acpx flow. The Main Agent generates structured workflow specs; the skill CLI validates, previews, saves, runs, follows, resumes, diagnoses, and reports logical workflow runs.
---

# ACPX Agent Orchestrator

This skill implements dynamic workflow orchestration over `acpx flow`.

Do not use legacy one-shot, named-session, fixed-template flow, `acpx-flow-run`,
or `acpx-inspector` workflows. They were intentionally removed. The public
surface is `scripts/acpx-orchestrator`.

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
```

Use `--wait` when the user wants the command to block until the logical run
finishes. Use `diagnose <logical-run-id> --wait` for blocked runs; it appends a
read-only recovery segment and keeps edit work from being rerun.

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
`${variableName}`. Agent outputs must end with a fenced `workflow-output` JSON
block.

Preview must be treated as the approval artifact: check roles, edit modes,
fanout, partial-result policy, limits, and audit paths before using `--yes`.
Running does not save a reusable workflow; use `save <name> --spec <path>` as a
separate explicit action.

Read:

- [docs/dynamic-workflow-design.md](docs/dynamic-workflow-design.md)
- [docs/workflow-spec.md](docs/workflow-spec.md)
- [docs/cli.md](docs/cli.md)

Examples live in `workflows/examples/`.
