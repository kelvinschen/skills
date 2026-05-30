# Error Codes

`acpx-orchestrator` errors are designed for Main Agent repair loops. JSON output
uses:

```json
{
  "code": "VARIABLE_UNDECLARED",
  "severity": "error",
  "path": "/stages/0/prompt",
  "message": "Prompt references ${task}, but no variable named task is declared.",
  "suggestions": ["Add a variable named task to /stages/0/variables."]
}
```

Severities:

- `warning`: spec is runnable, but the preview/report must surface the risk.
- `error`: spec is rejected until corrected.
- `fatal`: tooling/runtime could not safely continue.

Code families are stable and should not be renamed casually:

- `SCHEMA_*`: JSON shape, version, file read, declared input, or runtime input
  errors.
- `GRAPH_*`: root, dependency, cycle, branching, or summarize-terminal errors.
- `VARIABLE_*`: prompt placeholder and variable source errors.
- `ROLE_*`: unknown role or role/mode conflict.
- `LIMIT_*`: global hard limit or stage-limit errors.
- `DECISION_*`: invalid decision target/default routing.
- `DISCOVER_*`: invalid agent discover declaration.
- `FANOUT_*`: edit fanout risk or missing reconcile stage.
- `OUTPUT_*`: runtime output parse, schema, ambiguity, or repair errors.
- `RUNTIME_*`: logical run index, scheduler, session, or command errors.
- `RESUME_*`: resume policy errors.
- `ACPX_*`: `acpx/runtime` startup, session, or turn errors.
- `INTERNAL_*`: unexpected compiler/runtime invariant failure.

Output contract codes emitted by the runtime parser:

- `OUTPUT_PARSE_FAILED`: no acceptable JSON candidate could be parsed from an
  agent response.
- `OUTPUT_SCHEMA_FAILED`: JSON candidates were found, but none satisfied the
  stage-specific Zod-backed `workflow-output` contract.
- `OUTPUT_AMBIGUOUS`: multiple different valid `workflow-output` candidates were
  found, so the parser failed closed.
- `OUTPUT_REPAIR_FAILED`: the one allowed schema-aware repair turn did not
  produce a valid `workflow-output`.

Output contract failures map to blocked attempt/stage/run state, not failed.
`failed` is reserved for compiler, scheduler, ACPX runtime, or other
unrecoverable runtime errors.
