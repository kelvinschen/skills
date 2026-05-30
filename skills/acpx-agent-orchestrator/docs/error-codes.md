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
- `OUTPUT_*`: reserved for output contract/runtime parse errors.
- `RUNTIME_*`: logical run index or segment execution errors.
- `RESUME_*`: resume policy errors.
- `ACPX_*`: acpx startup, lookup, or bundle-read errors.
- `INTERNAL_*`: unexpected compiler/runtime invariant failure.

New codes may be added within these families. Existing code names should stay
stable once documented.

Resume policy codes currently emitted by `resume`:

- `RESUME_NO_FAILED_SEGMENT`: no failed non-diagnostic workflow segment can be
  retried.
- `RESUME_EDIT_WORKFLOW_REFUSED`: the run snapshot contains edit-capable roles;
  use `diagnose` and start a new run for edit recovery.
- `RESUME_POLICY_INVALID_MAX_ITEMS`: CLI value is not `stage=count`.
- `RESUME_POLICY_INVALID_SKIP_ITEM`: CLI value is not `stage=index`.
- `RESUME_POLICY_STAGE_UNKNOWN`: the policy references an unknown stage id.
- `RESUME_POLICY_STAGE_NOT_FANOUT`: the policy target is not a fanout stage.
- `RESUME_POLICY_PARTIAL_REQUIRES_READONLY`: resume attempted to enable partial
  results for an edit fanout.
- `RESUME_POLICY_MAX_ITEMS_NOT_TIGHTENING`: `maxItems` exceeds the compiled
  fanout cap from the run snapshot.
- `RESUME_POLICY_SKIP_ITEM_OUT_OF_RANGE`: skipped item index is outside the
  compiled fanout cap.
