# HTML Report Design

This document defines the technical plan for adding HTML reporting to
`acpx-orchestrator`. It covers both one-shot reports generated after a run and
live status tracking while a run is still producing artifacts.

## Goals

- Generate a pure single-file, self-contained HTML report for a completed or
  terminal logical run.
- Serve a live local HTML report that updates through Server-Sent Events while
  the workflow is running.
- Show the workflow as an author-stage DAG, not as compiled acpx internal nodes.
- Provide stage, segment, output, prompt, event, diagnostic, and artifact
  details in a navigable UI.
- Keep the page useful for local audit without embedding unbounded raw content.

## Non-Goals

- No token or cost tracking in v1.
- No workflow control operations from the browser: no resume, diagnose, rerun,
  approve, save, or spec edit actions.
- No tool-source, data-source, or knowledge-base sidebar sections copied from
  the reference image; those concepts do not map to this orchestrator.
- No default rendering of compiler/acpx internal nodes such as repair nodes,
  fanout gates, or `__blocked_stop`.
- No stage-duration estimation when the runtime does not provide reliable
  timing data.
- No multi-file HTML export or asset directory mode. Snapshot HTML is one file.

## Dependencies

The report UI should be built as a precompiled web bundle inside the skill
package:

- Vite for building a static frontend bundle.
- React for the report application.
- `@xyflow/react` for pan/zoom/selectable node graph rendering. React Flow is
  designed for node-and-edge UIs and provides viewport controls.
- `elkjs` for client-side DAG layout. ELK Layered is suitable for directed
  node-link diagrams; `elkjs` computes positions and is not itself a rendering
  framework.
- `lucide-react` for toolbar and navigation icons.

The runtime report commands must not invoke Vite. They should only read the
prebuilt frontend bundle from `dist/report-web/`.

Reference docs:

- React Flow overview: https://reactflow.dev/learn/concepts/core-concepts
- React Flow controls: https://reactflow.dev/api-reference/components/controls
- elkjs package: https://www.npmjs.com/package/elkjs
- Vite production build: https://vite.dev/guide/build.html

## CLI Surface

Keep the existing `report` command as the public entry point.

```bash
# Existing markdown behavior remains.
scripts/acpx-orchestrator report --run <run-id-or-dir>
scripts/acpx-orchestrator report --run <run-id-or-dir> --output report.md

# One-shot self-contained HTML report.
scripts/acpx-orchestrator report --run <run-id-or-dir> --html --output report.html

# Lightweight existing RunView JSON.
scripts/acpx-orchestrator report --run <run-id-or-dir> --json

# Full report data for debugging and tests.
scripts/acpx-orchestrator report --run <run-id-or-dir> --json --detailed

# Live local report.
scripts/acpx-orchestrator report serve --run <run-id-or-dir> --host 127.0.0.1 --port 0
scripts/acpx-orchestrator report serve --run <run-id-or-dir> --interval-ms 1000 --open
```

Rules:

- `--html` requires `--output`; printing a full HTML bundle to stdout is not a
  v1 path.
- `report serve` binds to `127.0.0.1` by default.
- `--port 0` lets the OS allocate a free port.
- `--open` may open the browser, but the default is to print the URL.
- `report serve --json` prints `{ url, runId, host, port }` before continuing
  to serve.
- The live report is observation-only. It must not expose HTTP endpoints that
  start agents, mutate specs, resume, diagnose, or rerun workflows.

## Data Model

Add a new detailed projection instead of expanding `RunView`:

- `RunView` remains the lightweight CLI/final-response projection.
- `RunReportView` is the stable data protocol for HTML snapshot and live SSE.
- `RunReportView.summary` embeds the corresponding `RunView`.

```ts
type RunReportView = {
  version: "acpx-orchestrator.report/v1";
  generatedAt: string;
  mode: "snapshot" | "live";
  summary: RunView;

  run: {
    logicalRunId: string;
    workflowName: string;
    status: RunViewStatus;
    finalVerdict?: "success" | "success_with_warnings" | "blocked" | "failed" | "unknown";
    createdAt: string;
    updatedAt: string;
    durationMs?: number;
    runDir: string;
    source?: RunIndex["source"];
  };

  metrics: {
    stagesTotal: number;
    stagesCompleted: number;
    stagesBlocked: number;
    stagesFailed: number;
    stagesRunning: number;
    stagesPending: number;
    segmentsTotal: number;
    segmentsRunning: number;
    segmentsCompleted: number;
    segmentsBlocked: number;
    segmentsFailed: number;
    agentCallsPlanned: number;
    agentCallsActual?: number;
    repairCalls?: number;
    recoveryCalls?: number;
  };

  graph: {
    nodes: ReportGraphNode[];
    edges: ReportGraphEdge[];
  };

  stages: ReportStageDetail[];
  segments: ReportSegmentDetail[];
  events: ReportEvent[];
  artifacts: ReportArtifact[];
  diagnostics: ReportDiagnostic[];
};
```

No token or cost fields are included.

### Preview Values

Large text fields use a bounded preview object:

```ts
type ReportPreview = {
  text: string;
  truncated: boolean;
  originalChars?: number;
  path?: string;
};
```

Default limits:

- prompt preview: 4096 chars
- output preview: 8192 chars
- diagnostic preview: 8192 chars
- raw JSON preview: 8192 chars
- event timeline: latest 200 events
- fanout item details: first 200 item outputs

These limits are fixed in v1. Do not add `--full` or multiple preview-size flags
until there is a concrete need.

### Stage Detail

```ts
type ReportStageDetail = {
  id: string;
  kind: Stage["kind"];
  dependsOn: string[];
  status: "pending" | "running" | "completed" | "blocked" | "failed" | "skipped" | "unknown";
  summary?: string;

  roleName?: string;
  roleCategory?: string;
  agent?: string;
  mode?: "denyAll" | "readOnly" | "edit";

  prompt?: ReportPreview;
  output?: ReportPreview;
  outputPath?: string;
  outputShape?: {
    keys: string[];
    status?: string;
    verdict?: string;
    finalVerdict?: string;
    findingsCount?: number;
    checksCount?: number;
    artifactsCount?: number;
  };

  fanout?: {
    totalItems?: number;
    completedItems?: number;
    blockedItems?: number;
    displayedItems: number;
    batchCount?: number;
    allowPartial?: boolean;
    items: Array<{
      id: string;
      status?: string;
      summary?: string;
      outputPath?: string;
      output?: ReportPreview;
    }>;
  };

  decision?: {
    matchedRoute?: string;
    defaultRoute?: string;
    routes: string[];
  };

  fixLoop?: {
    maxRounds: number;
    observedRounds?: number;
    finalValidatorStatus?: string;
  };

  relatedSegmentIds: string[];
  relatedEventIds: string[];
};
```

Stage status is derived conservatively:

- Stage output status wins when present.
- Running/pending is inferred from segment status and acpx projection only when
  the mapping is clear.
- Missing output after a terminal run can be shown as skipped or unknown,
  depending on routing evidence.
- Do not invent stage timing.

### Segment Detail

```ts
type ReportSegmentDetail = {
  segmentId: string;
  purpose: "workflow" | "fanout-batch" | "diagnostic";
  status: RunViewStatus;
  materializedFlowPath: string;
  inputPath: string;
  acpxRunId?: string;
  acpxRunDir?: string;
  fanoutStageId?: string;
  batchIndex?: number;
  itemStart?: number;
  itemCount?: number;
  outputCount: number;
  stepCount?: number;
  agentStepCount?: number;
  repairStepCount?: number;
  error?: string;
};
```

### Graph Data

The graph is semantic data only; coordinates are computed in the browser.

```ts
type ReportGraphNode = {
  id: string;
  label: string;
  kind: Stage["kind"];
  status: ReportStageDetail["status"];
  detailRef: string;
  roleName?: string;
  agent?: string;
  mode?: string;
  badges: string[];
  metrics: Record<string, string | number | boolean>;
};

type ReportGraphEdge = {
  id: string;
  source: string;
  target: string;
  relation: "dependency" | "decision-route";
  label?: string;
  active?: boolean;
};
```

Default graph:

- Render only author stages from `workflow.spec.json`.
- Edges come from `dependsOn`.
- Decision routes can be added as labeled route edges when route information is
  available.
- Fanout item nodes and fixLoop internal rounds are not expanded by default.

## Data Sources

`buildRunReportView` should read only known run artifacts:

- `.acpx-orchestrator/runs/<id>/run.json`
- `.acpx-orchestrator/runs/<id>/workflow.spec.json`
- `.acpx-orchestrator/runs/<id>/input.json`
- `.acpx-orchestrator/runs/<id>/events.ndjson`
- `.acpx-orchestrator/runs/<id>/outputs/*.json`
- `.acpx-orchestrator/runs/<id>/outputs/<fanout-stage>/*.json`
- `.acpx-orchestrator/runs/<id>/resolved-prompts/<segment>/*.md`
- `.acpx-orchestrator/runs/<id>/segments/<segment>/input.json`
- `.acpx-orchestrator/runs/<id>/segments/<segment>/materialized.flow.ts`
- `.acpx-orchestrator/runs/<id>/diagnostics/*.json`
- acpx projection paths referenced by run segments, when available

Do not add an arbitrary local file read API to the live server.

## Static Single-File HTML

`report --html --output report.html` should:

1. Resolve and sync the run using the same rules as current report generation.
2. Build `RunReportView` with `mode: "snapshot"`.
3. Read prebuilt frontend assets from `dist/report-web/`.
4. Inline CSS and JS into one HTML file.
5. Inject the snapshot as inert JSON:

```html
<script id="acpx-report-snapshot" type="application/json">{...}</script>
```

The JSON must be escaped so it cannot break out of the script tag. Prefer an
`application/json` script tag over assigning a raw JavaScript global.

The generated file must be openable directly from disk. The page can display
local paths and provide copy buttons, but it must not depend on loading external
assets.

## Live SSE Server

`report serve` should use Node's built-in HTTP server.

Endpoints:

- `GET /`: serves the report app shell.
- `GET /events`: SSE stream of `RunReportView` snapshots.
- `GET /healthz`: returns a small JSON health payload.

No polling fallback is provided in v1. The browser uses `EventSource`; browser
auto-reconnect is sufficient for v1. On a new connection, the server sends the
latest full snapshot immediately.

Server loop:

```ts
setInterval(async () => {
  const index = await syncRun(cwd, runId, { startPending: false });
  const report = await buildRunReportView(cwd, spec, index, { mode: "live" });
  if (hash(report) !== previousHash) broadcast("snapshot", report);
}, intervalMs);
```

Important boundary:

- The server actively drives `syncRun(cwd, runId, { startPending: false })`.
- This syncs existing acpx projections, run index state, outputs, fanout
  aggregation, continuation preparation, and diagnostics.
- It must not start new workflow segments or spawn new agent processes.

SSE events:

- `hello`: protocol version, run id, initial status.
- `snapshot`: full `RunReportView`.
- `error`: structured error object.
- `heartbeat`: optional keepalive comment/event.

Terminal runs:

- Continue serving the final snapshot.
- Reduce sync frequency or only send heartbeat after terminal status.
- Do not stop the server automatically.

## Frontend UI

Use a three-column workbench.

### Header

Show:

- workflow name
- run id
- status and final verdict
- created/updated time
- generated time
- live connection state for serve mode

Do not show token or cost metrics.

### Left Navigation

Use workflow/run sections:

- Overview
- Graph
- Stages
- Segments
- Events
- Artifacts
- Diagnostics

Do not include tool-source or data-source concepts.

### Main Area

Sections:

- metric cards for stage/segment/agent-call counts
- author stage DAG
- stage execution table
- event timeline
- diagnostics summary

### Right Detail Panel

Selecting a graph node, stage table row, segment, event, artifact, or diagnostic
updates the detail panel.

Tabs:

- Overview
- Input
- Prompt
- Output
- Events
- Metadata

Default selection:

- blocked or running stage when present
- otherwise summarize stage
- otherwise root stage

### Graph Rendering

Use React Flow with custom node renderers:

- `agentTask`: role, agent, mode
- `discover`: method and output key
- `fanout`: item completed/blocked/total, partial policy, batch count
- `reduce`: agent/program and operation
- `fixLoop`: max rounds and final validator status
- `decisionGate`: route/default summary
- `summarize`: final verdict

Use client-side ELK layout:

- service provides semantic graph only
- browser computes coordinates
- if topology is unchanged, update node data without relayout
- relayout only when topology changes or user toggles expansion

Graph controls:

- zoom in/out
- fit view
- pan
- minimap optional
- status legend

## Timing Policy

Display only reliable timing:

- Run-level created/updated/duration when available.
- Segment-level started time can be inferred from `events.ndjson` when present.
- Stage-level duration is not shown in v1 unless future acpx projections provide
  stable per-node timing.

Do not estimate stage duration from partial events or node order.

## Build Integration

Add scripts:

```json
{
  "scripts": {
    "build:web-report": "vite build --config web-report/vite.config.ts",
    "build": "tsdown && npm run build:web-report",
    "validate": "npm run typecheck && npm run test && npm run generate:schema && npm run build"
  }
}
```

The exact script composition can be adjusted, but `npm run validate` must build
the report frontend.

`save` helper snapshots should include `dist/report-web/`. If the report web
bundle is missing, `report --html` and saved helper creation should fail with a
structured error that tells the Main Agent to run `npm run build`.

## Testing Plan

The test suite should protect core contracts without overfitting the UI. HTML
reporting is expected to evolve, so v1 tests should avoid pixel-perfect checks,
fine-grained layout assertions, and exhaustive per-stage-kind UI cases.

### Test Tools

Vitest remains the primary test runner for:

- Node unit tests
- Node integration tests
- live SSE server tests
- React component tests through jsdom and Testing Library
- dynamic prepared-run integration tests

Playwright is a formal browser test layer, but it is not part of the default
`npm run validate` path.

Add development dependencies:

- `@testing-library/react`
- `@testing-library/jest-dom`
- `jsdom`
- `@playwright/test`

Playwright is Chromium-only in v1. Browser binaries are installed explicitly,
not during normal install.

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run test/unit",
    "test:integration": "vitest run test/integration",
    "test:e2e:fake": "vitest run test/e2e/fake",
    "test:e2e:real": "RUN_REAL_ACPX_E2E=1 vitest run test/e2e/real",
    "test:report:browser": "playwright test -c test/report-browser/playwright.config.ts",
    "install:report-browser": "playwright install chromium"
  }
}
```

`npm run validate` should continue to run:

```bash
npm run typecheck && npm run test && npm run generate:schema && npm run build
```

It must not run Playwright browser tests or real agent e2e tests.

### Vitest Environments

Use a single Vitest setup:

- default environment: Node
- React component test files opt into jsdom with:

```ts
// @vitest-environment jsdom
```

Do not introduce Jest or a second component test runner.

### Fixture Strategy

Use both deterministic report fixtures and dynamic prepared runs.

Report fixtures are maintained through `test/helpers/report-fixtures.ts`, which
materializes complete temporary run directories for each test. This keeps the
fixture contract explicit without requiring large checked-in run snapshots.

Dynamic prepared runs use `prepareRun`, fake acpx projections, and `syncRun` to
verify integration with the real run directory layout and live server behavior.

V1 required fixture kinds are intentionally limited to four core cases:

```text
completed-success
blocked-before-summarize
fanout-partial
long-content
```

Fixture intent:

- `completed-success`: normal summary, checks, artifacts, and author-stage DAG.
- `blocked-before-summarize`: blocked path where summarizer did not run.
- `fanout-partial`: fanout aggregate with completed and blocked item outputs.
- `long-content`: prompt, output, event, or diagnostic previews exceed
  truncation limits.

Do not make `completed-with-warnings`, `diagnosed-blocked`, or
`decision-route` mandatory full fixtures in v1. Cover those with smaller unit
or integration assertions when needed.

### Directory Layout

```text
test/
  helpers/
    report-fixtures.ts

  unit/
    report-view.test.ts
    report-html.test.ts

  integration/
    report-cli.test.ts
    report-live-server.test.ts

  web-report/
    report-app.test.tsx

  report-browser/
    report-browser.spec.ts
    playwright.config.ts
```

Playwright tests use `.spec.ts` and live in `test/report-browser/` so Vitest
does not collect them.

### Minimum Case Matrix

Keep v1 close to this size:

Vitest Node unit:

- `report-view.test.ts`: one structural assertion per core fixture, 4 cases.
- `report-html.test.ts`: inlined single-file output and JSON escaping, 3 cases.

Vitest Node integration:

- `report-cli.test.ts`: `--html --output` and `--json --detailed`, 2 cases.
- `report-live-server.test.ts`: immediate SSE snapshot and
  `startPending:false` safety boundary, 2 cases.

Vitest jsdom component:

- `report-app.test.tsx`: renders core layout, navigation, and truncated preview
  state, 1 case.

Playwright browser:

- `report-browser.spec.ts`: opens a generated single-file report, verifies graph
  nodes are visible, and clicking a node updates the detail panel, 1 case.
- `report-browser.spec.ts`: opens live report and verifies snapshot update
  through SSE, 1 case.

Expected v1 total: about 14-18 test cases. Avoid expanding this without a concrete
regression or new contract.

### HTML Generation Testing

Use three layers:

1. Unit tests with a fake bundle:
   - CSS is inlined.
   - JS is inlined.
   - snapshot JSON is embedded in an `application/json` script tag.
   - unsafe strings such as `</script>` cannot break out.
   - output has no external `<script src>` or `<link href>`.

2. Integration tests with the real prebuilt bundle:
   - `report --html --output report.html` writes one file.
   - generated HTML contains the frontend app marker and snapshot JSON.
   - generated HTML has no external asset references.

3. Playwright opens the real generated HTML through `file://`.

### Live SSE Safety Tests

The live report server must prove the safety boundary:

- it calls `syncRun(cwd, runId, { startPending: false })`
- it does not start pending workflow segments
- it does not expose control endpoints such as `/resume`, `/diagnose`,
  `/rerun`, `/approve`, or `/save`

Use dependency injection for the live server loop so Vitest can assert the sync
arguments directly.

Also maintain a dynamic prepared-run integration case:

- create a run with a pending segment
- start the live report server
- receive an SSE snapshot
- assert the pending segment remains pending and has no `acpxRunId` or
  `acpxRunDir`

### Frontend Test Boundaries

Vitest/jsdom component tests should cover:

- app renders a fixture snapshot
- navigation switches sections
- selecting a stage row updates the detail panel
- long previews show truncation state
- empty diagnostics/artifacts do not crash

They should not cover:

- ELK coordinate precision
- React Flow viewport transforms
- pixel-perfect layout
- exact edge paths
- every status badge style

Those are intentionally left flexible.

### Playwright Assertions

Playwright should verify browser-visible core behavior only.

Static HTML:

- header shows workflow name and run status
- React Flow root exists
- at least one author stage node has a non-zero bounding box
- internal compiler node labels are absent:
  - `__agent`
  - `__repair`
  - `__blocked_stop`
  - `__gate_`
- clicking a visible node updates the right detail panel
- a truncated preview marker is visible for the long-content fixture

Live SSE:

- page connects to `/events`
- initial snapshot appears
- after the test updates fake run artifacts, the page updates from a new SSE
  snapshot
- pending workflow segment is not started by the report server

Do not use golden screenshot comparison in v1.

Playwright config:

```ts
use: {
  browserName: "chromium",
  screenshot: "only-on-failure",
  trace: "retain-on-failure",
  video: "off"
}
```

Use `test-results/report-browser/` for browser artifacts.

## Implementation Phases

1. Add `RunReportView` types and builder under `src/projections/`.
2. Add static HTML renderer that inlines the prebuilt frontend bundle.
3. Extend `report` CLI for `--html`, `--json --detailed`, and `serve`.
4. Add `web-report/` React app with React Flow graph and detail panel.
5. Add SSE live server using Node HTTP and `syncRun(..., { startPending: false })`.
6. Add tests and documentation.

## Open Follow-Ups

- Whether to add a minimap by default or keep it hidden behind a toolbar toggle.
- Whether to persist graph UI state in `localStorage` for live serve.
- Whether future acpx projections will expose reliable per-node timing.
- Whether future versions should support expanded fanout item nodes on the main
  canvas for small fanouts.
