# ACPX Agent Orchestrator

Dynamic workflow orchestration for ACP agents through `acpx flow`.

The Main Agent creates a structured workflow spec. `scripts/acpx-orchestrator`
validates, previews, compiles, saves, and runs it while maintaining a logical run
index under `.acpx-orchestrator/runs/`.

This rewrite intentionally removes the old fixed-template public surface. Use
the new CLI and spec examples under `workflows/examples/`.

Core commands:

```bash
scripts/acpx-orchestrator validate --spec workflows/examples/simple-feature.workflow.spec.json
scripts/acpx-orchestrator preview --spec workflows/examples/simple-feature.workflow.spec.json
scripts/acpx-orchestrator run --spec workflows/examples/simple-feature.workflow.spec.json --yes
scripts/acpx-orchestrator follow <logical-run-id>
scripts/acpx-orchestrator diagnose <logical-run-id> --wait
scripts/acpx-orchestrator report --run <logical-run-id>
scripts/acpx-orchestrator report --run <logical-run-id> --html --output report.html
scripts/acpx-orchestrator report serve --run <logical-run-id> --port 0
```

The saved workflow interface is `workflow.spec.json`. Generated flow snapshots,
resolved prompts, stage outputs, events, and acpx bundle references are run
artifacts for audit and replay.

Docs:

- [docs/workflow-spec.md](docs/workflow-spec.md)
- [docs/cli.md](docs/cli.md)
- [docs/html-report-design.md](docs/html-report-design.md)
- [docs/error-codes.md](docs/error-codes.md)
- [docs/dynamic-workflow-design.md](docs/dynamic-workflow-design.md)
