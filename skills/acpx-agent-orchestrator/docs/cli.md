# CLI

Use the skill-local wrapper:

```bash
skills/acpx-agent-orchestrator/scripts/acpx-orchestrator <command>
```

Primary commands:

```bash
scripts/acpx-orchestrator validate --spec workflows/examples/simple-feature.workflow.spec.json
scripts/acpx-orchestrator preview --spec workflows/examples/simple-feature.workflow.spec.json --json
scripts/acpx-orchestrator run --spec workflows/examples/simple-feature.workflow.spec.json --yes
scripts/acpx-orchestrator run --spec workflows/examples/simple-feature.workflow.spec.json --yes --wait
scripts/acpx-orchestrator save simple-feature --spec workflows/examples/simple-feature.workflow.spec.json
scripts/acpx-orchestrator save simple-feature --spec workflows/examples/simple-feature.workflow.spec.json --overwrite
scripts/acpx-orchestrator run --workflow simple-feature --yes
scripts/acpx-orchestrator list workflows
scripts/acpx-orchestrator show workflow simple-feature
scripts/acpx-orchestrator follow <logical-run-id>
scripts/acpx-orchestrator diagnose <logical-run-id> --wait
scripts/acpx-orchestrator resume <logical-run-id> --wait
scripts/acpx-orchestrator resume <logical-run-id> --max-fanout-items review_files=4 --allow-partial-fanout review_files
scripts/acpx-orchestrator report --run <logical-run-id>
scripts/acpx-orchestrator report --run <logical-run-id> --html --output report.html
scripts/acpx-orchestrator report --run <logical-run-id> --json --detailed
scripts/acpx-orchestrator report serve --run <logical-run-id> --port 0
```

All commands support `--json` where structured output is useful.

`run` validates automatically. Without `--yes`, it prints a preview and exits
with approval required.

`run` starts a logical run and returns after the first acpx segment is started.
Use `--wait` to poll the logical run index until it reaches a terminal status.

`diagnose` appends a read-only `recovery_reviewer` diagnostic segment. It does
not rerun edit work and does not change the saved workflow spec. A finished
diagnostic maps a blocked logical run to `diagnosed_blocked`.

`resume` only retries failed workflow segments from the original run snapshot.
It refuses workflows with edit-capable roles; use `diagnose` and then start a
new run for edit recovery. Resume may tighten runtime policy through the
segment input without changing the saved spec, graph, prompts, roles, or agents:

- `--timeout-seconds <seconds>` sets the outer acpx process timeout for the retry.
- `--max-fanout-items <stage=count>` lowers the effective fanout item cap within
  the compiled snapshot.
- `--skip-fanout-item <stage=index>` skips a zero-based item index.
- `--allow-partial-fanout <stage>` allows partial read-only fanout results.

`save` writes a self-contained snapshot directory with `workflow.spec.json`,
derived `workflow.flow.ts`, README, schema/docs, wrapper, and built helper files
from the current package build. It fails if the helper CLI has not been built,
instead of writing a partial snapshot. Approval to run is not save approval;
saving is always explicit.

`report --html --output <file>` writes a single self-contained HTML snapshot
based only on the run index and artifacts. `report serve` starts an
observation-only local server that streams RunReportView snapshots over SSE
after syncing existing artifacts with `startPending: false`; it does not expose
workflow control endpoints.
