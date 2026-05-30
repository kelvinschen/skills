# ACPX workflow capability optimization notes

Date: 2026-05-30

Scope: current `aladdin-card-type-refactor` workflow and the underlying `acpx-agent-orchestrator` output-contract capability. This document was drafted from a real workflow trial and now lives with the ACPX orchestrator skill so follow-up agents can use it as implementation context.

## Executive summary

The `67-zhaopin` trial proved that the workflow can drive a real JS-to-TS card refactor, render baseline creation, modified render creation, and compile/render verification. The failure was in orchestration robustness: the implementer returned useful structured content in a common LLM shape, but not in the exact parser shape:

```json
{
  "workflow-output": {
    "status": "completed"
  }
}
```

inside a `json` fence rather than a `workflow-output` fence. The current runtime then blocked with `OUTPUT_PARSE_FAILED` before `reconcile_edits`, `quality_loop`, and `summarize`.

The highest-value optimization is therefore not another prompt tweak. It is a deterministic output-normalization boundary before the existing LLM repair call:

1. Extract candidate JSON payloads from exact `workflow-output` fences, common `json` fences, and raw trailing JSON.
2. Repair syntax-only JSON issues with a deterministic library such as `jsonrepair`.
3. Normalize common wrappers such as `{ "workflow-output": { ... } }`.
4. Validate the normalized object against the stage contract and JSON Schema/Zod contract.
5. Accept only one unambiguous valid candidate; otherwise fail closed and invoke the existing repair path.
6. Persist parser decisions as audit metadata so repair does not silently hide model drift.

For the exact `67-zhaopin` output, this would not have blindly accepted the result. It would have changed the failure from a coarse "missing workflow-output block" into precise candidate/schema diagnostics, then given the existing repair path enough structured feedback to convert the domain report into the required workflow contract. Simpler wrapper-only failures would be recovered without an LLM repair call.

## Current implementation facts

Local source inspected:

- `/data00/home/chenqiren.kyran/kprojects/kelvinschen-skills/skills/acpx-agent-orchestrator/src/compiler/compile.ts`
- `/data00/home/chenqiren.kyran/kprojects/kelvinschen-skills/skills/acpx-agent-orchestrator/docs/dynamic-workflow-design.md`

Current generated parser behavior:

- `extractWorkflowOutput` checks `maxOutputChars`.
- `parseWorkflowOutputBlock` matches only:
  - a fenced block whose opening tag is exactly `workflow-output`;
  - then calls `JSON.parse` directly on the fence body.
- `validateWorkflowOutput` checks minimum contract fields such as `status`, `summary`, `artifacts`, and `nextFocus`, plus contract-specific fields for validation outputs.
- On parse/schema failure, the flow emits `OUTPUT_PARSE_FAILED`.
- The materialized flow then performs one format-repair agent call using `formatRepairPrompt`.

This is a sensible minimal contract, but it is brittle at exactly the boundary where modern LLM agents most often fail: valid information in a slightly wrong envelope.

## Case study: `67-zhaopin` run failure

Run metadata:

- Logical run: `.acpx-orchestrator/runs/2026-05-30T01-01-53-549Z-3037322c`
- ACPX run: `/data00/home/chenqiren.kyran/.acpx/flows/runs/2026-05-30T010154136Z-aladdin-card-type-refactor-9e80131e`
- Target card: `packages/tt-search/business/Lego/67-zhaopin`
- Final status: `blocked`
- Final reason: `OUTPUT_PARSE_FAILED`
- Agent usage: `actual=2`, `repairCalls=0` in orchestrator run index; the materialized flow attempted a format repair node but it did not produce a valid parsed output.

### What succeeded before the parser failure

The implementer did execute useful work:

- converted `format.js` to `format.ts`;
- converted `index.jsx` to `index.tsx`;
- tightened `type.ts`;
- generated 5 baseline renders and 5 modified renders;
- ran `npx tsc --noEmit`;
- ran `npx druid run web:compile`;
- ran render diff and concluded only dynamic `jtoken` values changed.

Manual follow-up verified:

- `npx tsc --noEmit`: pass;
- `npx druid run web:compile`: pass;
- baseline vs modified render output: identical after normalizing dynamic `jtoken`;
- no new code-level `any`, `@ts-ignore`, `@ts-nocheck`, or `noImplicitAny: false`.

The orchestration failure was therefore not a task-execution failure. It was a machine-contract failure at the final response boundary.

### Abnormal output shape observed

The implementer output ended with domain-report content instead of the required top-level `workflow-output` object.

Relevant raw excerpt from the run artifact:

````text
Here's the final `workflow-output` JSON:

```json
{
  "workflow-output": {
    "card": "67-zhaopin",
    "path": "packages/tt-search/business/Lego/67-zhaopin",
    "timestamp": "20260530_090752",
    "steps": {
      "1_type_refactor": {
        "status": "pass",
        "details": {
          "files_modified": ["type.ts ..."],
          "files_created": ["format.ts ...", "index.tsx ..."],
          "files_deleted": ["format.js", "index.jsx"],
          "noImplicitAny_disabled": false
        }
      },
      "2_tsc_noEmit": { "status": "pass", "errors": 0 },
      "3_web_compile": { "status": "pass", "output": "编译成功 (rspack)" },
      "4_baseline_renders": { "status": "pass", "mock_count": 5, "all_succeeded": true },
      "5_modified_renders": { "status": "pass", "mock_count": 5, "all_succeeded": true },
      "6_diff_analysis": {
        "status": "pass",
        "regressions": 0,
        "diff_summary": "All 5 mocks render identically..."
      }
    },
    "overall_result": "PASS",
    "artifacts_dir": "packages/tt-search/business/Lego/67-zhaopin/.type-fix-artifacts/20260530_090752"
  }
}
```
``````json workflow-output
{
  "card": "67-zhaopin",
  "path": "packages/tt-search/business/Lego/67-zhaopin",
  "timestamp": "20260530_090752",
  "steps": { "...": "..." },
  "overall_result": "PASS",
  "artifacts_dir": "packages/tt-search/business/Lego/67-zhaopin/.type-fix-artifacts/20260530_090752"
}
```
````

There are three distinct issues in this output:

1. The first machine-readable block is tagged `json`, not `workflow-output`.
2. The first object is wrapped under a top-level `"workflow-output"` key.
3. Both the wrapped object and the second object are domain reports, not valid workflow-stage outputs: they omit required common fields such as `status`, `summary`, `artifacts`, and `nextFocus`.

The second block also has a malformed fence header: ``````json workflow-output`. A robust candidate extractor could still treat it as a possible JSON-like candidate, but it must not accept it without schema validation.

### Current parser behavior

The generated flow parser in this run contained:

```ts
function parseWorkflowOutputBlock(text) {
  const match = String(text || "").match(/```workflow-output\s*([\s\S]*?)```/);
  if (!match) return { ok: false, summary: "Missing workflow-output JSON block." };
  try {
    return { ok: true, value: JSON.parse(match[1]) };
  } catch (error) {
    return { ok: false, summary: "Invalid workflow-output JSON block: " + String(error) };
  }
}
```

Because neither final block opened with exactly ` ```workflow-output`, the parser never reached `JSON.parse` or schema validation. It produced:

```json
{
  "status": "blocked",
  "summary": "Missing workflow-output JSON block.",
  "artifacts": [],
  "nextFocus": "format repair or manual correction",
  "blockedReason": "OUTPUT_PARSE_FAILED",
  "rawTextSnippet": "Now let me read the card source files..."
}
```

The route node then selected repair:

```ts
const route = output.blockedReason === "OUTPUT_PARSE_FAILED"
  && (output.metadata?.repairAttempts ?? 0) === 0
  ? "repair"
  : (output.status === "blocked" ? "blocked" : "completed");
```

The repair prompt began:

```text
Your previous response could not be parsed as the required workflow-output JSON.
Do not redo the task. Emit exactly one fenced JSON block tagged workflow-output
that satisfies the implementation contract.

Parse error: Missing workflow-output JSON block.
Previous raw text snippet:
...
```

The repair output still did not produce a parseable `workflow-output` block, so the fanout item and then the whole workflow stopped:

```json
{
  "status": "blocked",
  "summary": "Workflow stopped because a stage returned blocked.",
  "blockedReason": "OUTPUT_PARSE_FAILED",
  "blockedStages": [
    {
      "id": "refactor_card__item_1__agent",
      "summary": "Missing workflow-output JSON block.",
      "reason": "OUTPUT_PARSE_FAILED"
    },
    {
      "id": "refactor_card__item_1__repair",
      "summary": "Missing workflow-output JSON block.",
      "reason": "OUTPUT_PARSE_FAILED"
    },
    {
      "id": "refactor_card__item_1",
      "summary": "Missing workflow-output JSON block.",
      "reason": "OUTPUT_PARSE_FAILED"
    }
  ]
}
```

### What a better parser would have reported

A deterministic salvage parser should not have accepted the exact output as-is, because the content does not satisfy the implementation-stage contract. It should have produced richer diagnostics:

```json
{
  "status": "blocked",
  "blockedReason": "OUTPUT_SCHEMA_FAILED",
  "summary": "Found JSON candidates, but none satisfied the implementation workflow-output contract.",
  "parseDiagnostics": {
    "candidateCount": 2,
    "candidates": [
      {
        "mode": "jsonFence",
        "syntax": "validJson",
        "wrapper": "workflow-output",
        "schemaErrorsBeforeUnwrap": [
          { "path": "/status", "message": "workflow-output.status must be completed or blocked." },
          { "path": "/summary", "message": "workflow-output.summary must be a string." },
          { "path": "/artifacts", "message": "workflow-output.artifacts must be an array." },
          { "path": "/nextFocus", "message": "workflow-output.nextFocus must be a string." }
        ],
        "schemaErrorsAfterUnwrap": [
          { "path": "/status", "message": "workflow-output.status must be completed or blocked." },
          { "path": "/summary", "message": "workflow-output.summary must be a string." },
          { "path": "/artifacts", "message": "workflow-output.artifacts must be an array." },
          { "path": "/nextFocus", "message": "workflow-output.nextFocus must be a string." }
        ]
      },
      {
        "mode": "malformedFenceJsonWorkflowOutput",
        "syntax": "validJson",
        "wrapper": "none",
        "schemaErrors": [
          { "path": "/status", "message": "workflow-output.status must be completed or blocked." },
          { "path": "/summary", "message": "workflow-output.summary must be a string." },
          { "path": "/artifacts", "message": "workflow-output.artifacts must be an array." },
          { "path": "/nextFocus", "message": "workflow-output.nextFocus must be a string." }
        ]
      }
    ],
    "recoverableByDeterministicRepair": false,
    "recoverableBySchemaAwareLlmRepair": true
  }
}
```

That repair prompt would be materially better than "Missing workflow-output JSON block." It could say:

```text
You returned a domain report instead of the implementation-stage contract.
Convert the information into one top-level workflow-output object.
Required fields: status, summary, artifacts, nextFocus, changedFiles, checks.
Do not nest under a workflow-output key.
Preserve the card path, changed files, command results, artifact directory, and diff summary.
```

A valid repaired object could then look like:

```workflow-output
{
  "status": "completed",
  "summary": "Refactored 67-zhaopin from JS/JSX to TS/TSX, generated baseline and modified renders, and found only dynamic jtoken differences.",
  "artifacts": [
    {
      "kind": "file",
      "path": "packages/tt-search/business/Lego/67-zhaopin/.type-fix-artifacts/20260530_090752/diff.txt",
      "label": "baseline vs modified render diff"
    },
    {
      "kind": "note",
      "label": "5 baseline renders and 5 modified renders succeeded"
    }
  ],
  "nextFocus": "Run read-only reconcile and quality_loop validation.",
  "changedFiles": [
    "packages/tt-search/business/Lego/67-zhaopin/type.ts",
    "packages/tt-search/business/Lego/67-zhaopin/format.ts",
    "packages/tt-search/business/Lego/67-zhaopin/index.tsx",
    "packages/tt-search/business/Lego/67-zhaopin/format.js",
    "packages/tt-search/business/Lego/67-zhaopin/index.jsx"
  ],
  "checks": [
    { "name": "tsc --noEmit", "status": "pass" },
    { "name": "web:compile", "status": "pass" },
    { "name": "web:render baseline", "status": "pass" },
    { "name": "web:render modified", "status": "pass" },
    { "name": "baseline diff", "status": "pass", "summary": "Only dynamic jtoken differences." }
  ]
}
```

### What belongs to tool vs Main Agent in this case

Tool-owned fixes:

- Detect `json` fence candidates.
- Detect malformed but recoverable fence labels like `json workflow-output`.
- Unwrap a top-level `"workflow-output"` key.
- Run schema validation and return path-level errors instead of only "missing block."
- Send schema-aware repair prompts.
- Keep the final decision fail-closed until required fields are present.

Main-Agent-owned fixes:

- Do not ask for "final workflow-output JSON" in a way that encourages a nested `"workflow-output"` property.
- Keep the required implementation-stage fields visible and concise: `status`, `summary`, `artifacts`, `nextFocus`, `changedFiles`, `checks`.
- Split the implementation stage so a long domain report is less likely to replace the machine output.
- Require the worker to put detailed narrative in artifacts or summaries, not as a replacement for the contract object.

## Responsibility boundary

The core distinction:

- The workflow tool must make the execution boundary deterministic, validated, observable, and recoverable for common format-envelope failures.
- The Main Agent that authors a workflow must design a workflow that is small enough, explicit enough, and contract-aware enough for downstream agents to execute.
- Runtime worker agents should still follow prompts, but system reliability cannot depend on every worker agent perfectly formatting markdown.

### What the workflow tool itself should solve

These are platform/runtime responsibilities. They should be implemented once in `acpx-agent-orchestrator`, so every saved workflow benefits without requiring each Main Agent to rediscover the same prompt rules.

| Area | Tool responsibility | Why it belongs in the tool |
| --- | --- | --- |
| Output extraction | Extract candidate payloads from exact `workflow-output` fences, common `json` fences, untagged fences, and trailing JSON. | The runtime owns the machine boundary. Markdown envelope variance is predictable and should not be pushed into every workflow prompt. |
| Syntax repair | Apply deterministic syntax repair, for example via `jsonrepair`, before spending an LLM repair call. | Syntax repair is mechanical, cheaper than an agent call, and easier to audit. |
| Wrapper normalization | Accept unambiguous wrappers such as `{ "workflow-output": { ... } }` only after validation. | This is a common LLM envelope mistake and was the direct `67-zhaopin` failure. |
| Contract validation | Validate outputs against base and stage-specific schemas with JSON path-level errors. | The runtime owns routing decisions; it must not rely on prose descriptions for route-critical fields. |
| Ambiguity handling | Fail closed when multiple different candidates validate or when repair would require semantic inference. | This preserves correctness while still recovering simple envelope issues. |
| Repair policy | Run deterministic repair first, then targeted LLM repair only if needed, with precise parse/schema diagnostics. | Repair sequencing is workflow infrastructure, not per-workflow business logic. |
| Parse metadata | Persist parse mode, repaired/unwrapped flags, raw snippet hashes, and schema errors in run artifacts/report. | Operators need to distinguish task failure from output-envelope failure. |
| Capability negotiation | Prefer provider-native structured output or tool-call arguments when a backend supports it; fall back to raw text parsing otherwise. | Agent providers differ. The orchestrator is the right layer to hide those differences behind a common contract. |
| Parser fixtures | Maintain regression tests for real malformed outputs, including the `67-zhaopin` case. | This is shared infrastructure quality. |
| Error taxonomy | Make `OUTPUT_PARSE_FAILED`, `OUTPUT_SCHEMA_FAILED`, `OUTPUT_AMBIGUOUS`, and `OUTPUT_REPAIR_FAILED` distinct if possible. | Better diagnosis requires runtime-owned error codes. |

The tool should not silently invent missing semantic content. For example, it may unwrap `{ "workflow-output": value }`, strip a trailing comma, or parse a `json` fence. It must not synthesize a missing `checks` array, change `status`, infer findings, or discard conflicting candidate objects.

### What the Main Agent writing a workflow should solve

These are workflow-design responsibilities. They remain the Main Agent's job even if the tool parser becomes more robust.

| Area | Main Agent responsibility | Why it belongs to workflow authoring |
| --- | --- | --- |
| Stage decomposition | Split large tasks into stages with durable checkpoints, especially before/after edits and expensive validation. | Only the workflow author knows the domain workflow and the blast radius of each step. |
| Role/mode selection | Choose read-only vs edit roles, enforce reconcile after edit fanout, and cap fanout/concurrency. | This is task-specific risk management. |
| Precise inputs | Define clear inputs, defaults, and disambiguation behavior, e.g. exact card path vs fuzzy card name. | The runtime can validate declared types, but it cannot know domain resolution semantics. |
| Domain commands | Specify correct domain commands and cwd requirements, e.g. `cd <cardDir> && npx druid run web:render --mock_url ... --out ...`. | The tool cannot infer every repo-specific CLI convention. |
| Output contract hints | Include concise examples of expected stage output fields and required artifact object shapes. | Prompts still matter for agent quality, even with runtime validation. |
| Validation gates | Decide what counts as P0/P1, which checks are required, and when fixLoop should stop. | These are domain acceptance criteria. |
| Baseline discipline | Encode rules such as "baseline is created only before edits and must not be regenerated in fixLoop." | This is business/testing semantics, not a generic parser concern. |
| Artifact policy | Decide where runtime evidence should live and what should remain untracked or be cleaned. | Artifact locations and retention are workflow-specific. |
| Scope boundaries | Prevent agents from broadening edits beyond the selected card unless explicitly justified. | The runtime can limit roles, but workflow prompts define semantic scope. |
| Final report content | Decide what the final human-facing report must include for the domain. | The tool can render reports, but domain-relevant conclusions belong to workflow design. |

The Main Agent should assume worker agents may produce imperfect envelopes. It should still write strict prompts, but it should not depend on prompt strictness as the only protection. The durable contract must live in the tool parser and validator.

### Shared contract between tool and Main Agent

Some items require both sides:

- Stage output schemas: the tool should provide base schemas and validation machinery; the Main Agent should select or extend the schema per stage.
- Repair budgets: the tool should implement configurable repair policy; the Main Agent should choose conservative limits for high-risk workflows.
- Prompt generation: the tool should generate standard contract snippets from schemas; the Main Agent should add domain-specific fields and examples.
- Audit expectations: the tool should always emit parse/repair metadata; the Main Agent should reference the relevant artifacts in workflow summaries.
- Native structured output: the tool should negotiate backend capabilities; the Main Agent should avoid writing prompts that fight the structured-output path.

### Classification of proposed optimizations

| Optimization | Primary owner | Secondary owner | Notes |
| --- | --- | --- | --- |
| Deterministic parse salvage | Workflow tool | Main Agent | Main Agent should still request strict `workflow-output`, but recovery belongs in the parser. |
| Schema-first output contracts | Workflow tool | Main Agent | Tool provides schemas/validation; Main Agent chooses stage contracts and domain extensions. |
| Two-tier deterministic-then-LLM repair | Workflow tool | Main Agent | Main Agent may tune budgets; sequencing belongs in runtime. |
| Native structured output/tool-call support | Workflow tool | None | Provider capability abstraction should not be hand-coded in each workflow. |
| Checkpointed sub-stages | Main Agent | Workflow tool | Tool may offer templates/lints, but decomposition is workflow design. |
| Parser fixtures/evals | Workflow tool | Main Agent | Main Agent can contribute real malformed outputs from workflow runs. |
| Rich parse diagnostics/reporting | Workflow tool | Main Agent | Tool captures diagnostics; Main Agent uses them in final reports and follow-up decisions. |
| Domain command correctness | Main Agent | Workflow tool | Tool can lint obvious anti-patterns if declared, but repo command semantics are domain-specific. |
| Fanout/reconcile safety | Main Agent | Workflow tool | Tool already warns; Main Agent must design disjoint scopes and required reduce stages. |

## Mature open-source tool map

The goal should be to assemble a small, boring reliability stack instead of hand-writing a large pile of parser and schema rules. The current orchestrator is TypeScript, ESM, Node 20+, and already depends on Zod. That makes the most practical near-term stack:

- Markdown/fence extraction: `micromark` or `remark-parse`/`unified`.
- JSON syntax repair: `jsonrepair`.
- JSONC/offset diagnostics: `jsonc-parser` when source location matters.
- Runtime contract schemas: keep Zod as the authoring API; export JSON Schema with Zod 4 `z.toJSONSchema()` when needed.
- Standards-grade schema validation: Ajv for JSON Schema validation, standalone compiled validators, and provider-facing schemas.
- Schema interop: Standard Schema if ACPX wants workflow authors to bring Zod, Valibot, ArkType, Effect Schema, etc.
- Prompt/output regression tests: Vitest for parser unit tests; Promptfoo for LLM-output fixture assertions if we want a higher-level eval CLI.
- Observability: enrich current run artifacts first; use OpenTelemetry-compatible span fields if exporting later; evaluate Langfuse only if we want a full self-hosted LLM observability platform.

### Recommended direct dependencies

These are good fits for the current ACPX implementation. They solve concrete parser/validator needs without moving the orchestrator to a different runtime.

| Capability | Mature option | What it gives us | Fit for ACPX | Recommendation |
| --- | --- | --- | --- | --- |
| Markdown/code-fence parsing | `micromark`, or `remark-parse` via `unified` | CommonMark/GFM-aware parsing with token/AST structure instead of regex guessing. `micromark` is a small CommonMark-compliant parser with positional info and extensive tests. | Strong. Agent outputs are markdown-like text, and the failing `67-zhaopin` response had multiple weird fences. | Use for candidate extraction if we want robust fence parsing. Avoid bespoke regex-only code for all fences. |
| JSON syntax repair | `jsonrepair` | Repairs invalid JSON: missing quotes/commas/brackets, truncated JSON, single quotes, smart quotes, Python constants, trailing commas, comments, fenced code blocks, JSONP, escaped JSON, MongoDB wrappers, concatenated strings, and NDJSON. It is TypeScript-based and has streaming support. | Strong. Directly addresses syntax/envelope failures without LLM calls. | Primary choice for deterministic syntax repair. Use before LLM repair, but only accept after schema validation. |
| JSONC/fault-tolerant parse and locations | `jsonc-parser` | Scanner, visitor, parse tree, fault-tolerant parse, offsets, line/column, `getLocation`, `findNodeAtLocation`, formatter and edit helpers. | Strong for diagnostics. Useful to report where a bad candidate came from. | Use for source-location diagnostics and JSONC-like blocks. Do not use its tolerant result as acceptance without checking parse errors and schema. |
| Runtime schema authoring | Zod 4 | Existing dependency; TypeScript-first schema definitions; native `z.toJSONSchema()` conversion. | Very strong. It is already in `package.json`. | Keep Zod for internal contracts and TypeScript inference. Generate JSON Schema for docs/provider modes. |
| JSON Schema validation | Ajv | Fast JSON Schema validator; supports multiple drafts, TypeScript utility types, compiled validators that act as type guards. | Strong if schemas become provider/runtime contracts. | Use Ajv for standards-grade JSON Schema validation and path-level errors when Zod is not enough or schemas are externalized. |
| JSON Schema plus TS types | TypeBox | JSON Schema type builder with static TypeScript resolution; produces schemas accepted by JSON Schema validators and includes a compiler. | Good if ACPX wants JSON Schema as the source of truth instead of Zod. | Consider for new schema-first modules. Do not rewrite current Zod schemas unless JSON Schema portability becomes more important than Zod ergonomics. |
| Schema library interop | Standard Schema | A vendor-neutral TypeScript interface implemented by Zod, Valibot, ArkType, Effect Schema, TypeMap, Yup, Joi, Typia, and others. | Good for plugin/extensibility surface. | Use if workflow specs allow custom validators or schema extensions from users. This avoids hard-locking all extensions to Zod. |
| JSON pointer to source location | `json-source-map` or `@mischnic/json-sourcemap` | Maps JSON Pointers to line/column/offset. | Medium. Useful for nicer diagnostics, less important than candidate/schema correctness. | Optional. Prefer `jsonc-parser` first if we already need tolerant parsing and offsets. |

### Tools to borrow patterns from, not necessarily embed directly

These are mature and relevant, but the current ACPX architecture receives raw text from external agents. Direct adoption may require changing agent invocation APIs or bringing in Python services.

| Capability | Mature option | What to borrow | Why not direct P0 dependency |
| --- | --- | --- | --- |
| Deterministic fix then reask | Guardrails AI | The `FIX_REASK` policy: programmatically fix, revalidate, then reask only if still invalid. | Python-first framework; useful design pattern, but ACPX can implement the same policy in TypeScript with `jsonrepair` + Zod/Ajv. |
| Validation retries | Instructor | Response model + validation + provider abstraction + retry loop. Its docs and README focus on avoiding manual JSON parsing/retries. | Python-first. We should borrow the validation-error feedback shape rather than add a Python dependency to the Node orchestrator. |
| TypeScript structured generation | Vercel AI SDK | `generateObject` / structured typed output concepts and `experimental_repairText` hook. | Good fit only if ACPX directly calls models through AI SDK. Current ACP agents are external adapters, so use as reference unless backend integration changes. |
| Full LLM observability | Langfuse | Trace, metrics, evals, prompt management, datasets; integrates with OpenTelemetry and LLM frameworks. | Heavy for a CLI workflow tool. Start with richer local artifacts and OTEL-shaped metadata; evaluate Langfuse if teams need a self-hosted UI. |
| LLM output eval CLI | Promptfoo | Assertions over existing model outputs, JSON/function-call/schema checks, standalone assertion files. | Useful for regression suites, but not needed in the runtime parser. Good for CI/eval around fixture corpora. |

### Structured-generation engines for future backend integration

These should not be reimplemented inside ACPX. They matter if an ACP backend can expose constrained decoding or if ACPX later controls model calls directly.

| Tool | Capability | Fit |
| --- | --- | --- |
| Outlines | JSON generation from JSON Schema/Pydantic/function signatures using guided generation. | Good for Python/local-model backends. Not directly useful for raw-text ACP agent sessions. |
| Guidance | Open-source Python library for programmatic constraints over LM outputs, including structured formats such as JSON. | Mature ecosystem and large community. Good reference or backend-specific option. |
| LM Format Enforcer | Token-level output enforcement for JSON Schema, regex, choices; integrates with transformers/vLLM-style guided decoding. | Good for self-hosted/local model backends. Not a parser replacement. |
| XGrammar | Efficient structured generation engine with Python/C++/JavaScript APIs, JSON/regex/CFG support, and integrations in serving stacks. | Promising for high-performance model-serving integration. Too low-level for the current CLI parser boundary. |

### Specific optimization-to-tool mapping

| Optimization direction | Use mature solution | Avoid self-built version |
| --- | --- | --- |
| Candidate extraction from markdown output | `micromark` or `remark-parse` for fenced code blocks; fallback text candidate scan only after AST extraction. | Do not grow one regex to handle all fence edge cases, backtick lengths, nested prose, and malformed labels. |
| Syntax-only JSON repair | `jsonrepair` as first deterministic repair pass. | Do not write ad hoc quote/comma/bracket fixers. They will be incomplete and risky. |
| JSONC/comments/trailing comma diagnostics | `jsonc-parser` for parse errors, offsets, line/column, AST nodes. | Do not rely on `JSON.parse` error strings for actionable diagnostics. |
| Contract validation | Zod for internal TS contracts; Ajv for JSON Schema contracts; TypeBox if JSON Schema becomes the authoring source. | Do not hand-check required keys with scattered `if` statements as contracts grow. |
| Schema interop for user/plugin extensions | Standard Schema interface. | Do not invent ACPX-specific schema adapter APIs unless Standard Schema cannot express a required feature. |
| Path-level error reporting | Zod issues, Ajv `instancePath`, optionally `json-source-map`/`jsonc-parser` for source locations. | Do not emit only coarse errors like "Missing workflow-output JSON block" when candidates exist. |
| Deterministic-then-LLM repair policy | Borrow Guardrails `FIX_REASK` and Instructor-style validation retry prompt shape. | Do not immediately call an LLM repair agent for syntax issues that a deterministic pass can fix. |
| Native structured output | Use provider-native JSON Schema/tool calls when adapters expose it; AI SDK patterns are relevant for TypeScript model calls. | Do not depend on markdown fences when the backend can return tool arguments or schema-constrained objects. |
| Prompt/output regression evals | Vitest fixture tests for parser functions; Promptfoo for higher-level LLM output assertion suites. | Do not rely on a single manual smoke run as proof that parser prompts are stable. |
| Run observability | OTEL-shaped spans/attributes and current artifact files; optional Langfuse export later. | Do not create a one-off opaque event schema that cannot be queried or exported. |

### Proposed dependency posture

Near-term, low-risk additions:

1. `jsonrepair`: deterministic JSON syntax repair.
2. `jsonc-parser`: optional, for parse diagnostics and source offsets.
3. `micromark` or `remark-parse`: robust markdown fence extraction.
4. Ajv: only if/when we externalize stage contracts as JSON Schema or need provider-ready schemas.

Already available:

- Zod is already in the orchestrator dependency graph. Prefer extending current Zod validation before adding another internal schema language.

Evaluate later:

- TypeBox if JSON Schema becomes the primary schema source.
- Standard Schema if ACPX exposes schema extension hooks to workflow authors/plugins.
- Promptfoo if we want CI evals over real agent-output fixtures.
- Langfuse if teams need cross-run UI, datasets, and scoring beyond local ACPX reports.
- Outlines/Guidance/LM Format Enforcer/XGrammar if ACPX controls model decoding for some backends.

### Design guardrails for adopting these tools

- Keep deterministic syntax repair separate from semantic validation. `jsonrepair` may make text parseable; Zod/Ajv decides whether it is acceptable.
- Treat tolerant parsers as diagnostic helpers unless they report no errors and validation passes.
- Accept one canonical schema source per contract. For the current codebase, that should probably be Zod first, with JSON Schema generated from it.
- Fail closed on ambiguity even if multiple tools can parse something.
- Record which tool and mode accepted a candidate: `parseMode`, `repairTool`, `schemaValidator`, `schemaErrors`, `sourceOffsets`.
- Prefer tool APIs that expose structured errors over libraries that only return a repaired string.
- Avoid runtime Python dependencies in the TypeScript CLI path unless there is a clear backend boundary.

## External research snapshot

### Native structured outputs

OpenAI Structured Outputs supports JSON Schema and strict schema adherence. The official guidance distinguishes JSON mode from Structured Outputs: JSON mode only guarantees parseable JSON, while Structured Outputs are intended to match a supplied schema. Source: https://platform.openai.com/docs/guides/structured-outputs

LangChain uses a similar abstraction at the application layer: it chooses a provider-native structured-output strategy when supported, otherwise it can fall back to tool-calling, and it surfaces schema validation errors back to the model for correction. Source: https://docs.langchain.com/oss/python/langchain/structured-output

Implication for ACPX: if the ACP agent backend can expose provider-native structured output or tool-call arguments, that is the cleanest long-term direction. However, ACPX currently receives raw assistant text from multiple agents, so a raw-text boundary parser is still needed as a compatibility layer.

### Deterministic JSON repair

`jsonrepair` is a mature TypeScript/JavaScript package for repairing invalid JSON. Its documented repairs cover missing quotes, missing commas, missing closing brackets, single quotes, special quote characters, Python constants, trailing commas, comments, fenced code blocks, JSONP, escaped JSON strings, MongoDB-like wrappers, string concatenation, and newline-delimited JSON. It also has a CLI and streaming support. Source: https://www.npmjs.com/package/jsonrepair

Implication for ACPX: this fits the current TypeScript stack and the exact observed class of failures. The repair must remain syntax/envelope repair only; semantic contract validation should still be handled by ACPX.

### Validation with retry feedback

Instructor documents a validation retry loop where validation errors are captured, formatted as feedback, added back into prompt context, and the LLM is asked to try again. Source: https://python.useinstructor.com/learning/validation/retry_mechanisms/

Guardrails AI has explicit on-fail actions, including `FIX_REASK`, which first applies deterministic fixing, revalidates, and only then asks the model again. Source: https://guardrailsai.com/docs/concepts/validator_on_fail_actions

Implication for ACPX: the current one-shot LLM repair call should be moved after deterministic extraction/repair. That lowers cost, avoids repeating long task context, and is aligned with the deterministic-fix-then-reask pattern.

### Constrained decoding and schema-driven generation

Outlines supports JSON generation from Pydantic models or functions by constraining generation so the result follows the desired structure. Source: https://dottxt-ai.github.io/outlines/reference/generation/json/

BAML documents structured streaming and partial JSON handling, including converting incomplete partial JSON into semantically valid partial objects during streaming. Source: https://docs.boundaryml.com/guide/baml-basics/streaming

JSONSchemaBench frames constrained decoding as the dominant approach for enforcing structured outputs and evaluates frameworks including Guidance, Outlines, XGrammar, OpenAI, and Gemini across real JSON schemas. Source: https://arxiv.org/abs/2501.10868

Implication for ACPX: constrained generation is valuable if ACPX controls decoding. For heterogeneous external agents, deterministic post-processing and schema validation are the practical near-term layer.

## Optimization directions

### P0: Harden `workflow-output` parsing with deterministic salvage

Owner: workflow tool.

Main Agent rule: still instruct workers to emit exact `workflow-output` fenced JSON, but do not rely on prompt strictness as the only recovery mechanism.

Current parser:

```ts
const match = text.match(/```workflow-output\s*([\s\S]*?)```/);
return JSON.parse(match[1]);
```

Recommended parser pipeline:

```ts
function parseWorkflowOutput(text: string, contract: Contract): ParseResult {
  const candidates = collectCandidates(text);

  for (const candidate of candidates) {
    for (const variant of normalizeCandidateText(candidate)) {
      const parsed = tryJsonParse(variant) ?? tryJsonRepairParse(variant);
      const unwrapped = unwrapWorkflowOutput(parsed);
      const validation = validateWorkflowOutput(unwrapped, contract);

      if (validation.ok) {
        return {
          ok: true,
          value: unwrapped,
          metadata: {
            parseMode: candidate.mode,
            repaired: parsed.repaired,
            unwrapped: parsed !== unwrapped,
            warnings: validation.warnings
          }
        };
      }
    }
  }

  return blockedOutput("OUTPUT_PARSE_FAILED", diagnostics);
}
```

Candidate order should be deterministic:

1. Exact `workflow-output` fenced blocks.
2. `json`, `jsonc`, or untagged fenced code blocks that contain an object with required workflow fields.
3. Raw trailing JSON object after the final assistant prose.
4. A raw object nested under a top-level `workflow-output` key.

Acceptance rules:

- Accept only if exactly one candidate validates for the expected stage contract.
- If two different candidates validate with different content, block as ambiguous.
- Never infer missing required semantic fields.
- Never auto-convert a failed/blocked status into completed.
- Preserve raw text snippet, repaired text hash, candidate mode, and validation warnings in metadata.

This directly addresses the `67-zhaopin` parser failure mode by finding and diagnosing the JSON candidates that the current exact-fence parser misses, while still preserving fail-closed behavior for schema-invalid domain reports.

### P0: Make stage output contracts schema-first

Owner: workflow tool for base schemas, validation, and prompt snippets; Main Agent for choosing stage-specific schemas and domain extensions.

The orchestrator already uses Zod for workflow specs and has hand-coded validation for stage outputs. The next step is to make each stage contract explicit as JSON Schema or Zod:

- `baseWorkflowOutputSchema`
- `discoverOutputSchema`
- `validationOutputSchema`
- `summarizeOutputSchema`
- optional stage-specific extension schemas declared in the workflow spec

This enables:

- generated prompt snippets that are concise and exact;
- deterministic validation with JSON path errors;
- better repair prompts;
- fixture generation;
- future native structured-output/tool-call support.

Recommended spec extension:

```json
{
  "outputContract": {
    "schemaRef": "validationOutput/v1",
    "strict": true,
    "repairPolicy": "deterministicThenReask"
  }
}
```

### P1: Replace one generic repair call with a two-tier repair policy

Owner: workflow tool.

Main Agent rule: choose conservative repair budgets for high-risk workflows and avoid prompts that invite multiple output objects.

Current policy:

- parse fails;
- ask the same agent to emit a valid block;
- if repair fails, block.

Recommended policy:

1. Deterministic extraction/repair/unwrap.
2. Schema validation.
3. If syntax/envelope could not be repaired, call LLM repair with precise diagnostics.
4. If schema validation fails, call LLM repair with JSON path-level errors.
5. Block after a small configured repair budget.

Suggested defaults:

```json
{
  "outputRepair": {
    "deterministic": true,
    "llmRepairAttempts": 1,
    "acceptWrapperUnwrap": true,
    "acceptJsonFence": true,
    "failOnAmbiguousCandidates": true
  }
}
```

This keeps current cost bounds while making the common failures cheap and recoverable.

### P1: Prefer native structured output/tool-calling when the ACP backend supports it

Owner: workflow tool.

Main Agent rule: treat schema/tool-call output as the primary contract when available; markdown fences are a fallback compatibility format.

The long-term model should be:

- if agent provider supports strict JSON Schema output, pass the stage schema to the provider;
- if provider supports tool calling, define a no-op `workflow_output` tool and consume its arguments;
- if neither is available, use raw text with deterministic repair.

This removes markdown fence dependence for capable agents while preserving compatibility with current ACP agent adapters.

Implementation concern: ACPX orchestrator has multiple agent backends (`aiden`, `claude`, `trae`) with different surfaces. This should be a capability-negotiated path, not a hard dependency.

### P1: Split large implementation stages into checkpointed sub-stages

Owner: Main Agent writing the workflow.

Tool support: add lints/templates for high-risk long edit stages, but do not try to infer domain checkpoints automatically.

The `67-zhaopin` run also showed that one large edit stage can do baseline creation, type refactor, compile, render, diff, and final reporting in a single agent response. That increases the cost of a single output-format failure.

Recommended shape:

- `prepare_baseline`: edit or command-capable stage, output only mock URLs and baseline artifacts.
- `apply_refactor`: edit stage, output changed files and local compile status.
- `render_modified`: command-capable stage, output modified artifacts and diff.
- `reconcile_edits`: read-only reduce.
- `quality_loop`: validation/fix loop.

This gives the parser smaller outputs and creates durable checkpoints before risky long-running edits.

### P2: Add parser fixtures and output-contract evals

Owner: workflow tool.

Main Agent role: contribute raw outputs from real failed runs as fixtures.

Create fixture tests under the orchestrator package, using raw outputs captured from real runs:

- exact `workflow-output` fence;
- `json` fence with top-level `workflow-output` wrapper;
- valid top-level JSON in a `json` fence;
- trailing prose plus final JSON object;
- trailing commas and comments;
- smart quotes;
- truncated JSON that `jsonrepair` can repair;
- wrong semantic values, e.g. `status: "done"`;
- missing required arrays;
- multiple conflicting valid candidates.

Each fixture should assert parse mode, whether repair happened, accepted/blocked status, and emitted diagnostics.

The `67-zhaopin` output parse failure should become a regression fixture.

### P2: Improve diagnostics and reports

Owner: workflow tool for collecting and exposing diagnostics; Main Agent for interpreting diagnostics in domain summaries.

The current blocked output includes a raw snippet, but a user reading the report needs to know whether the agent task failed or only the envelope failed.

Recommended report fields:

```json
{
  "blockedReason": "OUTPUT_PARSE_FAILED",
  "parseDiagnostics": {
    "candidateCount": 2,
    "bestCandidateMode": "jsonFenceWorkflowOutputWrapper",
    "syntaxRepairAttempted": true,
    "schemaErrors": [
      { "path": "/artifacts/0", "message": "Expected object, received string" }
    ],
    "recoverable": true
  }
}
```

This would have made the `67-zhaopin` result immediately clear: implementation likely succeeded, orchestration envelope failed.

## Recommended near-term implementation

Implement P0 deterministic salvage first.

Why this first:

- It directly fixes the failure observed in the real `67-zhaopin` workflow.
- It is local to the orchestrator parser boundary.
- It does not require changing agent providers.
- It reduces LLM repair calls.
- It preserves the existing blocked behavior if validation does not pass.

Concrete implementation plan:

1. Add parser unit tests using fixture strings before changing implementation.
2. Add `jsonrepair` as the primary deterministic repair dependency, or bundle a tiny internal fallback only if generated flows cannot reliably resolve orchestrator package dependencies from target worktrees.
3. Add `micromark` or `remark-parse` only if regex fence extraction proves insufficient in fixtures. If added, use it only to extract code-block candidates, not to validate content.
4. Add `jsonc-parser` only if we want line/column/offset diagnostics for malformed candidates in P0. Otherwise defer it to P2 diagnostics.
5. Keep Zod as the base contract implementation. Add Ajv when stage contracts are exported as JSON Schema or when provider-native structured output needs standards-grade JSON Schema validation.
6. Refactor generated parser code in `src/compiler/compile.ts`:
   - `collectWorkflowOutputCandidates`
   - `tryParseJson`
   - `tryRepairJson`
   - `unwrapWorkflowOutput`
   - `validateWorkflowOutput`
7. Add parse metadata to successful outputs:
   - `metadata.outputParseMode`
   - `metadata.outputRepaired`
   - `metadata.outputUnwrapped`
8. Add blocked parse diagnostics for schema-invalid candidates:
   - `blockedReason: OUTPUT_SCHEMA_FAILED`
   - `candidateCount`
   - `schemaErrors`
   - `bestCandidateMode`
   - `recoverableBySchemaAwareLlmRepair`
9. Keep `OUTPUT_PARSE_FAILED` for no candidates, `OUTPUT_SCHEMA_FAILED` for invalid candidates, and `OUTPUT_AMBIGUOUS` for multiple conflicting valid candidates.
10. Update `docs/dynamic-workflow-design.md` and `docs/error-codes.md`.
11. Run:
   - `npm run typecheck`
   - `npm run test:unit`
   - `npm run build`
12. Re-run the `aladdin-card-type-refactor` preview and a smoke workflow with a synthetic agent output fixture if available.

Packaging note: generated `workflow.flow.ts` currently embeds parser helper code. If it imports `jsonrepair`, `micromark`, `jsonc-parser`, or Ajv, confirm the materialized flow resolves dependencies from the orchestrator package rather than the target repository. If not, either bundle the dependency into the generated flow output or keep the runtime helper dependency-free and run richer repair/diagnostics in the orchestrator command layer.

## Proposed acceptance criteria

- A `json` fenced block containing `{ "workflow-output": { ...valid output... } }` is accepted and annotated as repaired/unwrapped.
- A strict `workflow-output` fenced block still follows the fast path.
- A syntactically repaired JSON payload is accepted only after contract validation passes.
- A semantically invalid object still blocks.
- Ambiguous multiple valid outputs block.
- The generated report distinguishes task failure from output-envelope failure.
- Existing saved workflows do not need prompt changes to benefit from parser hardening.

## Priority order

1. P0 deterministic parse salvage with schema validation and audit metadata.
2. P0 schema-first stage output contracts.
3. P1 two-tier deterministic-then-LLM repair policy.
4. P1 native structured output/tool-call integration when ACP agent adapters expose capability metadata.
5. P1 checkpoint large edit stages to reduce loss from output-envelope failures.
6. P2 parser fixture corpus and regression evals from real run outputs.
7. P2 richer report diagnostics for parse failures and recoveries.

## Source links

- OpenAI Structured Outputs: https://platform.openai.com/docs/guides/structured-outputs
- LangChain structured output: https://docs.langchain.com/oss/python/langchain/structured-output
- `jsonrepair`: https://www.npmjs.com/package/jsonrepair
- `jsonrepair` GitHub: https://github.com/josdejong/jsonrepair
- `micromark`: https://github.com/micromark/micromark
- `jsonc-parser`: https://github.com/microsoft/node-jsonc-parser
- Zod JSON Schema conversion: https://zod.dev/json-schema
- Ajv JSON Schema validator: https://ajv.js.org/
- TypeBox: https://github.com/sinclairzx81/typebox
- Standard Schema: https://github.com/standard-schema/standard-schema
- Instructor retry mechanisms: https://python.useinstructor.com/learning/validation/retry_mechanisms/
- Instructor GitHub: https://github.com/instructor-ai/instructor
- Guardrails on-fail actions: https://guardrailsai.com/docs/concepts/validator_on_fail_actions
- Vercel AI SDK `generateObject`: https://vercel-ai.mintlify.app/reference/ai-sdk-core/generate-object
- Outlines JSON structured generation: https://dottxt-ai.github.io/outlines/reference/generation/json/
- Guidance: https://www.microsoft.com/en-us/research/project/guidance-control-lm-output/
- LM Format Enforcer: https://github.com/noamgat/lm-format-enforcer
- XGrammar: https://github.com/mlc-ai/xgrammar
- BAML streaming structured output: https://docs.boundaryml.com/guide/baml-basics/streaming
- Promptfoo assertions: https://www.promptfoo.dev/docs/configuration/expected-outputs/
- Langfuse: https://github.com/langfuse/langfuse
- OpenTelemetry traces: https://opentelemetry.io/docs/concepts/signals/traces/
- JSONSchemaBench: https://arxiv.org/abs/2501.10868
