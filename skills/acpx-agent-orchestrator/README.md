# ACPX Agent Orchestrator

Runtime-driven workflow orchestration for ACP agents.

The Main Agent creates a structured workflow spec. `scripts/acpx-orchestrator`
validates, previews, compiles it to `execution-plan.json`, and runs a
step-driven scheduler that talks directly to `acpx/runtime` with run-local
persistent sessions.

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

Run directories contain `workflow.spec.json`, `execution-plan.json`, `input.json`,
final `outputs/`, raw `attempts/`, run-local `acpx-state/`, `sessions/`, and
`events.ndjson`. The orchestrator does not generate or execute ACPX flow files.

Docs:

- [docs/workflow-spec.md](docs/workflow-spec.md)
- [docs/cli.md](docs/cli.md)
- [docs/html-report-design.md](docs/html-report-design.md)
- [docs/error-codes.md](docs/error-codes.md)
- [docs/runtime-orchestrator-refactor-implementation.md](docs/runtime-orchestrator-refactor-implementation.md)
