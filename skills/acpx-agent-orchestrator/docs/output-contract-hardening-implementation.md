# ACPX output contract hardening implementation

Date: 2026-05-30

Status: implemented for P0 plus P1 repair routing and structured-output hook; deterministic syntax repair remains deferred until helper bundling is selected.

Scope: P0 + P1 output-contract hardening for `acpx-agent-orchestrator`.

Source context: `docs/acpx-workflow-capability-optimization.md`.

## Problem Statement

The `67-zhaopin` workflow trial demonstrated that the workflow could complete useful implementation work, but the orchestrator blocked at the machine-output boundary.

The implementer returned structured task results in common LLM shapes:

- a fenced `json` block containing a top-level `"workflow-output"` wrapper;
- a malformed fence header similar to `json workflow-output`;
- domain-specific report fields instead of the required stage contract fields.

The current generated flow only accepts an exact fenced block tagged `workflow-output`. Because no exact fence was found, the parser returned `OUTPUT_PARSE_FAILED` with `Missing workflow-output JSON block.` before it could produce useful schema diagnostics.

This was an output envelope and contract failure, not a task-execution failure. The hardening work must make that boundary deterministic, diagnosable, auditable, and fail-closed.

## Current State

The current parser is emitted inline by `compileWorkflow` in `src/compiler/compile.ts`.

Key behavior:

- `extractWorkflowOutput` enforces `maxOutputChars`.
- `parseWorkflowOutputBlock` matches only a fenced block whose opening tag is exactly `workflow-output`.
- `parseWorkflowOutputBlock` calls `JSON.parse` directly on that block.
- `validateWorkflowOutput` manually checks required fields and returns a single summary string.
- parse or validation failure becomes a blocked output with `blockedReason: "OUTPUT_PARSE_FAILED"`.
- `agentUnit` only routes to the repair node when `blockedReason === "OUTPUT_PARSE_FAILED"` and `repairAttempts === 0`.
- `formatRepairPrompt` only receives a summary and raw text snippet, so the repair agent does not get candidate-level or path-level schema diagnostics.

The current approach is a good minimal contract, but too brittle for common LLM response envelopes.

## Target Behavior

The parser must become a staged output-contract layer:

1. Enforce output size limits first.
2. Collect JSON-like candidates from known response shapes.
3. Parse candidates deterministically.
4. Normalize the single supported wrapper shape.
5. Validate normalized candidates against the stage contract.
6. Accept exactly one unambiguous valid result.
7. Return structured diagnostics for all other outcomes.
8. Route eligible failures through one schema-aware repair attempt.

The parser must not silently repair semantics:

- Do not infer `status`.
- Do not synthesize `summary`, `artifacts`, `nextFocus`, `checks`, `changedFiles`, or `finalVerdict`.
- Do not convert domain reports into workflow outputs without an explicit repair agent response.
- Do not accept multiple different valid candidates.

### Candidate Sources

Candidate extraction must be deterministic and ordered. P0 must support:

| Mode | Shape | Notes |
| --- | --- | --- |
| `workflowOutputFence` | ````workflow-output ... ```` | Fast path. Must remain backward compatible. |
| `jsonFence` | ````json ... ```` | Common LLM output shape. |
| `jsoncFence` | ````jsonc ... ```` | Collect as JSON-like; syntax repair is P1. |
| `untaggedFence` | ```` ... ```` | Only if the body appears JSON-like. |
| `malformedFence` | fence info string containing both `json` and `workflow-output` | Covers `json workflow-output` style headers. |
| `trailingRawJson` | final balanced raw JSON object at the end of the response | Last-resort candidate. |

Extraction rules:

- Keep the exact `workflow-output` fast path first.
- Deduplicate candidates by raw content hash and character range.
- Limit candidate count to a small deterministic cap, for example 8, to avoid excessive diagnostics.
- Never execute or evaluate candidate content.
- Store snippets and hashes in diagnostics, not full raw agent output.

### Wrapper Normalization

Support exactly one wrapper:

```json
{
  "workflow-output": {
    "status": "completed"
  }
}
```

Unwrap only when:

- the parsed value is a plain object;
- it has exactly one own key named `"workflow-output"`;
- the wrapped value is a plain object.

The unwrapped candidate must still pass the stage contract. Wrapper normalization is not semantic repair.

### Validation

`validateWorkflowOutput` must keep the existing contract behavior but return path-level errors.

Use JSON Pointer paths. Examples:

```json
[
  {
    "path": "/status",
    "message": "workflow-output.status must be completed or blocked."
  },
  {
    "path": "/changedFiles",
    "message": "implementation output requires changedFiles safe relative path array."
  }
]
```

Validation should be schema-first in behavior even if implemented with manual helper functions inside the generated flow. A candidate is only accepted when the common contract and the stage-specific contract both pass.

### Ambiguity

If more than one valid candidate is found:

- accept only when all valid candidates have the same canonical JSON value;
- otherwise block with `OUTPUT_AMBIGUOUS`.

Canonical comparison should be deterministic and key-order insensitive. A small stable stringify helper is enough for P0.

### Success Metadata

Successful parsed stage outputs must include parser metadata without dropping any agent-provided metadata:

```ts
return {
  ...value,
  metadata: {
    ...(value.metadata ?? {}),
    outputParse
  }
};
```

`metadata.outputParse` must include:

```ts
interface OutputParseMetadata {
  mode: CandidateMode;
  repaired: boolean;
  unwrapped: boolean;
  candidateCount: number;
  warnings: string[];
}
```

P0 uses `repaired: false`. P1 syntax repair may set `repaired: true`.

### Blocked Diagnostics

Blocked parser outputs must include `parseDiagnostics`:

```ts
interface ParseDiagnostics {
  errorCode: OutputErrorCode;
  summary: string;
  candidateCount: number;
  candidates: WorkflowOutputCandidate[];
  bestCandidateId?: string;
  recoverability: "repairable" | "not_repairable";
  rawSnippetHash: string;
  warnings: string[];
}
```

Blocked outputs still keep the normal blocked envelope:

```ts
{
  status: "blocked",
  summary,
  artifacts: [],
  nextFocus: "format repair or manual correction",
  blockedReason: errorCode,
  rawTextSnippet,
  parseDiagnostics,
  metadata: {
    repairAttempts: 0,
    agentCallsUsed: 1
  }
}
```

## Interfaces

The implementation should use these names as the stable internal contract for parser and repair code.

```ts
type OutputErrorCode =
  | "OUTPUT_PARSE_FAILED"
  | "OUTPUT_SCHEMA_FAILED"
  | "OUTPUT_AMBIGUOUS"
  | "OUTPUT_REPAIR_FAILED";

type CandidateMode =
  | "workflowOutputFence"
  | "jsonFence"
  | "jsoncFence"
  | "untaggedFence"
  | "malformedFence"
  | "trailingRawJson";

type CandidateSyntax =
  | "validJson"
  | "invalidJson"
  | "repairedJson";

interface WorkflowOutputSchemaError {
  path: string;
  message: string;
}

interface WorkflowOutputCandidate {
  id: string;
  mode: CandidateMode;
  syntax: CandidateSyntax;
  rawSnippetHash: string;
  rawSnippetPreview: string;
  unwrapped: boolean;
  wrapper: "workflow-output" | "none";
  parseError?: string;
  schemaErrors: WorkflowOutputSchemaError[];
}

interface ParseDiagnostics {
  errorCode: OutputErrorCode;
  summary: string;
  candidateCount: number;
  candidates: WorkflowOutputCandidate[];
  bestCandidateId?: string;
  recoverability: "repairable" | "not_repairable";
  rawSnippetHash: string;
  warnings: string[];
}

interface OutputParseMetadata {
  mode: CandidateMode;
  repaired: boolean;
  unwrapped: boolean;
  candidateCount: number;
  warnings: string[];
}

type ParseResult =
  | {
      ok: true;
      value: Record<string, unknown>;
      outputParse: OutputParseMetadata;
      diagnostics: ParseDiagnostics;
    }
  | {
      ok: false;
      errorCode: OutputErrorCode;
      summary: string;
      diagnostics: ParseDiagnostics;
    };
```

Generated flow helpers may use plain JavaScript, but tests and compiler-side code should align with this shape.

## Phased Implementation

### Phase 1: Extract And Harden Parser Helper

Files:

- `src/compiler/compile.ts`
- new `src/compiler/output-parser-helper.ts`
- new parser unit tests under `test/unit/`

Tasks:

1. Move the parser helper source out of the large `compileWorkflow` template into a source generator, for example `outputParserHelperSource(): string`.
2. Keep the emitted helper self-contained. The materialized `workflow.flow.ts` must still run in the target repository without relying on target `node_modules`.
3. Replace `parseWorkflowOutputBlock` with a candidate pipeline:
   - `collectWorkflowOutputCandidates(text)`;
   - `parseCandidateJson(candidate)`;
   - `unwrapWorkflowOutput(candidate)`;
   - `validateWorkflowOutput(value, contract, options)`;
   - `selectValidCandidate(candidates)`.
4. Add deterministic raw snippet hashing with a built-in Node API available in generated flow, such as `node:crypto`.
5. Preserve existing exact `workflow-output` behavior as the fastest successful path.

Phase 1 intentionally does not add `jsonrepair`.

### Phase 2: Schema Diagnostics

Files:

- `src/compiler/output-parser-helper.ts`
- `src/compiler/compile.ts`
- unit tests for every contract-specific validator

Tasks:

1. Change `validateWorkflowOutput` from `{ ok, summary }` to `{ ok, errors }`.
2. Convert every existing validator branch into JSON Pointer errors.
3. Make `parseBlocked` accept `errorCode` and `parseDiagnostics`.
4. Return:
   - `OUTPUT_PARSE_FAILED` when no candidate can be parsed as JSON;
   - `OUTPUT_SCHEMA_FAILED` when at least one JSON candidate exists but none validate;
   - `OUTPUT_AMBIGUOUS` when multiple different valid candidates exist.
5. Include candidate summaries and best candidate selection in `parseDiagnostics`.

Best candidate selection should be deterministic:

1. valid JSON over invalid JSON;
2. fewer schema errors;
3. exact `workflowOutputFence` over other modes;
4. earlier position in the response.

### Phase 3: Two-Tier Repair Policy

Files:

- `src/compiler/compile.ts`
- `src/compiler/output-parser-helper.ts`
- tests for generated source and fake runtime behavior

Tasks:

1. Replace the repair route condition with a repairable error-code set:

```ts
const REPAIRABLE_OUTPUT_REASONS = [
  "OUTPUT_PARSE_FAILED",
  "OUTPUT_SCHEMA_FAILED",
  "OUTPUT_AMBIGUOUS"
];
```

2. Route to repair only when:
   - `blockedReason` is in the repairable set;
   - `metadata.repairAttempts === 0`;
   - `parseDiagnostics.recoverability === "repairable"`.
3. Update `formatRepairPrompt` to include:
   - blocked reason;
   - candidate count;
   - best candidate mode;
   - schema errors with JSON Pointer paths;
   - wrapper status;
   - a raw text snippet.
4. The repair prompt must tell the agent not to redo the task and to emit exactly one `workflow-output` fenced block.
5. If repair also fails, keep the repaired node output blocked and mark it as `OUTPUT_REPAIR_FAILED` only when the failure is specifically in the repair pass. Otherwise preserve the parser failure code and add `metadata.repairAttempts: 1`.

P1 deterministic syntax repair:

- `jsonrepair` is the recommended library for syntax-only repair.
- Do not import it directly from materialized flows unless helper bundling is implemented.
- Before enabling it, choose one dependency strategy:
  - bundle the syntax repair helper into generated flow source; or
  - run syntax repair in an orchestrator-controlled helper runtime before the flow materialization boundary.
- The generated flow must not implicitly depend on the target repository having `jsonrepair` installed.

### Phase 4: Structured Output Capability Hook

P1 defines the interface only. It does not require concrete agent adapter work.

```ts
type AgentOutputMode = "nativeSchema" | "toolCall" | "rawText";

interface AgentOutputCapability {
  mode: AgentOutputMode;
  contract: string;
  schemaName: string;
  rawTextFallback: boolean;
}
```

Rules:

- `rawText` remains the default path through `acp({ parse })`.
- `nativeSchema` and `toolCall` are future capabilities for agents that can enforce structured outputs.
- Even with native structured output, parsed values must still pass the same stage contract validation.
- This phase must not change workflow spec v1 authoring surface.

## Implementation Notes

### Generated Flow Portability

`src/acpx/run-flow.ts` runs materialized flows in the target repository cwd. Therefore generated helper code must not assume the orchestrator package's dependencies are resolvable from that cwd.

P0 helper code must use only:

- JavaScript built-ins;
- Node built-ins already safe in generated flow;
- code emitted directly into `workflow.flow.ts`.

Any future external parser dependency must be explicitly bundled or executed before the target-repo flow boundary.

### Error Codes

Use the stable error codes documented here and mirror them in `docs/error-codes.md` when implementation starts.

| Code | Meaning | Repairable |
| --- | --- | --- |
| `OUTPUT_PARSE_FAILED` | No acceptable JSON candidate could be parsed. | Yes |
| `OUTPUT_SCHEMA_FAILED` | JSON candidates exist, but none satisfy the stage contract. | Yes |
| `OUTPUT_AMBIGUOUS` | Multiple different valid candidates were found. | Yes |
| `OUTPUT_REPAIR_FAILED` | The repair pass itself failed to produce valid output. | No |

### Report And RunView Visibility

RunView, Markdown reports, and HTML reports should be able to display parser diagnostics when present.

Minimum visibility:

- stage blocked reason;
- parse candidate count;
- best candidate mode;
- first few schema path errors;
- whether a successful output was unwrapped or repaired.

Full raw ACPX trace remains debug-only.

## Acceptance Criteria

Parser behavior:

- Exact `workflow-output` fenced output remains accepted.
- A `json` fenced output with a single top-level `"workflow-output"` wrapper is accepted when the unwrapped object satisfies the stage contract.
- A malformed `json workflow-output` fence is collected as a candidate and validated.
- Trailing prose followed by a final raw JSON object is collected as a candidate.
- Domain reports such as the captured `67-zhaopin` shape are not accepted as valid workflow outputs.
- Domain reports return `OUTPUT_SCHEMA_FAILED` with JSON Pointer errors, not a generic missing-fence message.
- Multiple different valid candidates return `OUTPUT_AMBIGUOUS`.
- Multiple identical valid candidates may be accepted as one canonical output.

Repair behavior:

- `OUTPUT_PARSE_FAILED`, `OUTPUT_SCHEMA_FAILED`, and `OUTPUT_AMBIGUOUS` can route to one repair pass.
- Repair prompt includes schema-aware diagnostics.
- Semantic missing fields are never synthesized by deterministic parser code.
- Repair pass does not redo the task.

Compatibility:

- Existing saved workflows do not need spec changes.
- Generated flow remains self-contained and directly runnable by `acpx` with compiled segment input.
- Existing strict outputs remain compatible.

Auditability:

- Successful outputs include `metadata.outputParse`.
- Blocked outputs include `parseDiagnostics`.
- Diagnostics are concise enough for run indexes and reports.

## Test Plan

All automated tests should use Vitest.

### Parser Unit Fixtures

Add focused fixtures for the parser helper source:

- exact `workflow-output` fence valid;
- `json` fence with top-level `"workflow-output"` wrapper valid and `unwrapped=true`;
- malformed `json workflow-output` fence valid;
- trailing prose plus final raw JSON valid;
- schema-invalid domain report returns `OUTPUT_SCHEMA_FAILED` with path errors;
- captured `67-zhaopin` output shape produces candidate diagnostics and does not report only `Missing workflow-output JSON block`;
- multiple different valid candidates returns `OUTPUT_AMBIGUOUS`;
- syntax-repair fixtures remain skipped or absent until the `jsonrepair` dependency strategy is implemented.

Keep unit cases core and contract-oriented. Avoid overly fine-grained tests that lock incidental wording or layout.

### Compiler And Runtime Tests

Add or update tests to verify:

- compiled flow source includes the generated parser helper;
- exact `workflow-output` fast path remains compatible;
- repair route includes the expanded repairable error-code set;
- repair node prompt contains parse diagnostics;
- fake ACPX e2e produces structured blocked output when no candidate validates.

### Report Visibility Tests

Add minimal RunView/report tests only for stable data shape:

- blocked stage exposes `parseDiagnostics`;
- successful stage exposes `metadata.outputParse`;
- HTML/Markdown report projections can show a short diagnostic summary.

Do not test React Flow layout details for this work.

### Validation Commands

Run before final commit:

```sh
npm run typecheck
npm run test:unit
npm run test:e2e:fake
npm run build
npm run validate
```

## Non-Goals

- No workflow spec v1 authoring surface changes.
- No automatic semantic repair.
- No agent adapter changes for native structured output in this implementation slice.
- No dependency on target repository `node_modules`.
- No broad P2 evaluation framework in this slice.

## Suggested Work Breakdown

1. Add parser helper source generator and unit harness.
2. Implement candidate extraction and wrapper normalization.
3. Convert validation summaries into JSON Pointer errors.
4. Add parser diagnostics and success metadata.
5. Update repair route and repair prompt.
6. Add fake e2e coverage for schema-failed blocked output.
7. Add minimal RunView/report projection for parser diagnostics.
8. Update `docs/error-codes.md` and CLI-facing error descriptions.

This order keeps the generated flow portable while improving diagnostics before introducing optional syntax-repair dependencies.
