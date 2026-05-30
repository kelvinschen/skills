import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunReportView } from "../../src/projections/run-report.js";
import { runDir } from "../../src/run-index/paths.js";
import type { RunIndex } from "../../src/run-index/read-write.js";
import { SCHEMA_VERSION, WorkflowSpecSchema, type WorkflowSpec } from "../../src/schema/workflow-spec.js";

export type ReportFixtureKind = "completed-success" | "blocked-before-summarize" | "fanout-partial" | "long-content";

export type ReportFixture = {
  cwd: string;
  runId: string;
  dir: string;
  spec: WorkflowSpec;
  index: RunIndex;
};

export async function createReportFixture(kind: ReportFixtureKind): Promise<ReportFixture> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `acpx-report-${kind}-`));
  const runId = kind;
  const dir = runDir(runId, cwd);
  await fs.mkdir(dir, { recursive: true });
  if (kind === "fanout-partial") return writeFanoutPartialFixture(cwd, runId, dir);
  return writeLinearFixture(cwd, runId, dir, kind);
}

export async function writeReportWebBundle(root: string): Promise<void> {
  const webRoot = path.join(root, "dist", "report-web");
  await fs.mkdir(path.join(webRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(webRoot, "index.html"), [
    "<!doctype html>",
    "<html><head>",
    "<link rel=\"stylesheet\" href=\"./assets/index.css\">",
    "</head><body><div id=\"root\"></div>",
    "<script type=\"module\" src=\"./assets/index.js\"></script>",
    "</body></html>"
  ].join(""), "utf8");
  await fs.writeFile(path.join(webRoot, "assets", "index.css"), "body { color: #111; }\n", "utf8");
  await fs.writeFile(path.join(webRoot, "assets", "index.js"), "window.__reportLoaded = true;\n", "utf8");
}

export function minimalReportView(runId = "fixture-run"): RunReportView {
  return {
    version: "acpx-orchestrator.report/v1" as const,
    generatedAt: "2026-01-01T00:00:00.000Z",
    mode: "snapshot" as const,
    summary: {
      logicalRunId: runId,
      workflowName: "fixture",
      status: "completed" as const,
      finalVerdict: "success" as const,
      summary: "Fixture summary",
      checks: [],
      finalWarnings: [],
      risks: [],
      warnings: [],
      errors: [],
      roles: [],
      stages: [],
      agentUsage: { planned: 1, actual: 1, repairCalls: 0 },
      artifacts: [],
      commands: {}
    },
    run: {
      logicalRunId: runId,
      workflowName: "fixture",
      status: "completed" as const,
      finalVerdict: "success" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      runDir: "/tmp/fixture"
    },
    metrics: {
      stagesTotal: 1,
      stagesCompleted: 1,
      stagesBlocked: 0,
      stagesFailed: 0,
      stagesRunning: 0,
      stagesPending: 0,
      segmentsTotal: 1,
      segmentsRunning: 0,
      segmentsCompleted: 1,
      segmentsBlocked: 0,
      segmentsFailed: 0,
      agentCallsPlanned: 1,
      agentCallsActual: 1,
      repairCalls: 0,
      recoveryCalls: 0
    },
    graph: {
      nodes: [{
        id: "summarize",
        label: "summarize",
        kind: "summarize" as const,
        status: "completed" as const,
        detailRef: "summarize",
        badges: ["summarize"],
        metrics: {}
      }],
      edges: []
    },
    stages: [{
      id: "summarize",
      kind: "summarize" as const,
      dependsOn: [],
      status: "completed" as const,
      summary: "Fixture summary",
      relatedSegmentIds: ["main"],
      relatedEventIds: [],
      output: { text: "{\"status\":\"completed\"}", truncated: false, path: "/tmp/fixture/output.json" }
    }],
    segments: [{
      segmentId: "main",
      purpose: "workflow" as const,
      status: "completed" as const,
      materializedFlowPath: "/tmp/fixture/flow.ts",
      inputPath: "/tmp/fixture/input.json",
      outputCount: 1,
      stepCount: 1,
      agentStepCount: 1,
      repairStepCount: 0
    }],
    events: [],
    artifacts: [],
    diagnostics: []
  };
}

async function writeLinearFixture(cwd: string, runId: string, dir: string, kind: Exclude<ReportFixtureKind, "fanout-partial">): Promise<ReportFixture> {
  const spec = WorkflowSpecSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    name: kind,
    description: "Linear report fixture",
    root: "plan",
    inputs: { task: { type: "string" } },
    roles: {
      planner: { category: "planning", agent: "aiden", mode: "readOnly" },
      worker: { category: "implementation", agent: "trae", mode: "edit" },
      summarizer: { category: "summarization", agent: "aiden", mode: "readOnly" }
    },
    limits: { maxAgents: 6, maxConcurrency: 1 },
    stages: [
      { id: "plan", kind: "agentTask", role: "planner", prompt: "Plan ${task}" },
      { id: "implement", kind: "agentTask", dependsOn: ["plan"], role: "worker", prompt: "Implement the plan." },
      { id: "summarize", kind: "summarize", dependsOn: ["implement"], role: "summarizer", prompt: "Summarize the workflow." }
    ]
  });
  const long = "Long report content. ".repeat(700);
  const outputs: Record<string, unknown> = {
    plan: {
      status: "completed",
      summary: "Plan created",
      artifacts: [],
      nextFocus: "implement"
    },
    implement: kind === "blocked-before-summarize"
      ? {
          status: "blocked",
          summary: "Implementation blocked",
          blockedReason: "Required file is outside the allowed path scope.",
          parseDiagnostics: {
            errorCode: "OUTPUT_SCHEMA_FAILED",
            summary: "Found JSON candidates, but none satisfied the implementation workflow-output contract.",
            candidateCount: 1,
            bestCandidateId: "candidate-1",
            recoverability: "repairable",
            rawSnippetHash: "fixture",
            warnings: [],
            candidates: [{
              id: "candidate-1",
              mode: "jsonFence",
              syntax: "validJson",
              rawSnippetHash: "fixture",
              rawSnippetPreview: "{\"card\":\"67-zhaopin\"}",
              unwrapped: true,
              wrapper: "workflow-output",
              schemaErrors: [{ path: "/status", message: "workflow-output.status must be completed or blocked." }]
            }]
          },
          artifacts: [],
          nextFocus: "diagnose"
        }
      : {
          status: "completed",
          summary: kind === "long-content" ? long : "Implementation complete",
          artifacts: [{ kind: "file", path: "src/app.ts", label: "Changed app file" }],
          nextFocus: "summarize",
          metadata: {
            outputParse: {
              mode: "workflowOutputFence",
              repaired: false,
              unwrapped: false,
              candidateCount: 1,
              warnings: []
            }
          },
          changedFiles: ["src/app.ts"],
          checks: [{ command: "npm test", status: "pass", summary: "Tests passed" }],
          data: kind === "long-content" ? { body: long } : undefined
        },
    summarize: {
      status: "completed",
      summary: "Workflow completed",
      artifacts: [],
      nextFocus: "",
      finalVerdict: kind === "long-content" ? "success_with_warnings" : "success",
      deliverables: ["Implementation complete"],
      changedFiles: ["src/app.ts"],
      checks: [{ command: "npm test", status: "pass", summary: "Tests passed" }],
      warnings: kind === "long-content" ? ["Large output was truncated in report previews."] : [],
      risks: [],
      nextActions: []
    }
  };
  if (kind === "blocked-before-summarize") delete outputs.summarize;

  await writeRunFiles({ cwd, runId, dir, spec, outputs, promptText: kind === "long-content" ? long : undefined });
  const index = await writeIndex({
    cwd,
    logicalRunId: runId,
    workflowName: spec.name,
    status: kind === "blocked-before-summarize" ? "blocked" : "completed",
    finalVerdict: kind === "blocked-before-summarize" ? undefined : (kind === "long-content" ? "success_with_warnings" : "success"),
    blockedReason: kind === "blocked-before-summarize" ? "Required file is outside the allowed path scope." : undefined,
    segments: [{
      segmentId: "main",
      purpose: "workflow",
      status: kind === "blocked-before-summarize" ? "blocked" : "completed",
      materializedFlow: path.join(dir, "segments", "main", "materialized.flow.ts"),
      input: path.join(dir, "segments", "main", "input.json"),
      acpxRunId: `${runId}-acpx`,
      acpxRunDir: path.join(dir, "acpx-runs", "main")
    }],
    agentUsage: { planned: 6, actual: 3, repairCalls: kind === "blocked-before-summarize" ? 1 : 0, recoveryCalls: 0 }
  });
  await writeAcpxProjection(dir, "main", kind === "blocked-before-summarize" ? "completed" : "completed", outputs, [
    { nodeId: "plan", nodeType: "acp", outcome: "completed" },
    { nodeId: "implement", nodeType: "acp", outcome: kind === "blocked-before-summarize" ? "blocked" : "completed" },
    ...(kind === "blocked-before-summarize" ? [] : [{ nodeId: "summarize", nodeType: "acp", outcome: "completed" }])
  ]);
  return { cwd, runId, dir, spec, index };
}

async function writeFanoutPartialFixture(cwd: string, runId: string, dir: string): Promise<ReportFixture> {
  const spec = WorkflowSpecSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    name: "fanout-partial",
    description: "Fanout report fixture",
    root: "discover_files",
    inputs: { task: { type: "string" }, files: { type: "array<json>", default: [] } },
    roles: {
      reviewer: { category: "review", agent: "aiden", mode: "readOnly" },
      summarizer: { category: "summarization", agent: "aiden", mode: "readOnly" }
    },
    limits: { maxAgents: 10, maxConcurrency: 2, maxFanoutItems: 5 },
    stages: [
      { id: "discover_files", kind: "discover", method: "glob", args: { pattern: "src/**/*.ts" }, output: "files" },
      {
        id: "review_files",
        kind: "fanout",
        dependsOn: ["discover_files"],
        items: { source: "discover_files.files" },
        role: "reviewer",
        prompt: "Review ${item.path}",
        fanoutPolicy: { allowPartial: true, minCompletedRatio: 0.5, maxBlockedItems: 1 }
      },
      { id: "reconcile", kind: "reduce", dependsOn: ["review_files"], mode: "agent", from: "review_files", role: "reviewer", prompt: "Reconcile partial results." },
      { id: "summarize", kind: "summarize", dependsOn: ["reconcile"], role: "summarizer", prompt: "Summarize review." }
    ]
  });
  const itemOutputs = [
    validationOutput("src/a.ts", "completed"),
    validationOutput("src/b.ts", "blocked"),
    validationOutput("src/c.ts", "completed")
  ];
  const outputs = {
    discover_files: {
      status: "completed",
      summary: "Discovered 3 files",
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" }],
      artifacts: [],
      nextFocus: "review_files"
    },
    review_files: {
      status: "completed",
      summary: "Fanout completed with partial results",
      items: itemOutputs,
      blockedItems: [itemOutputs[1]],
      artifacts: [],
      nextFocus: "reconcile"
    },
    reconcile: {
      status: "completed",
      summary: "Partial findings reconciled",
      artifacts: [],
      nextFocus: "summarize",
      verdict: "pass",
      severityCounts: { P0: 0, P1: 0, P2: 1, P3: 0 },
      findings: [],
      checks: []
    },
    summarize: {
      status: "completed",
      summary: "Review completed with one blocked item accepted by policy",
      artifacts: [],
      nextFocus: "",
      finalVerdict: "success_with_warnings",
      deliverables: ["Review report"],
      changedFiles: [],
      checks: [],
      warnings: ["One item was blocked but partial fanout was explicitly allowed."],
      risks: ["Partial result must be reviewed before applying broad conclusions."],
      nextActions: []
    }
  };
  await writeRunFiles({ cwd, runId, dir, spec, outputs });
  await fs.mkdir(path.join(dir, "outputs", "review_files"), { recursive: true });
  for (let index = 0; index < itemOutputs.length; index += 1) {
    await writeJson(path.join(dir, "outputs", "review_files", `review_files__item_${index + 1}.json`), itemOutputs[index]);
  }
  const segments = [
    segment(dir, "pre-review_files", "workflow", "completed", "pre"),
    segment(dir, "review_files-batch-1", "fanout-batch", "completed", "batch-1", { fanoutStageId: "review_files", batchIndex: 0, itemStart: 0, itemCount: 2 }),
    segment(dir, "review_files-batch-2", "fanout-batch", "completed", "batch-2", { fanoutStageId: "review_files", batchIndex: 1, itemStart: 2, itemCount: 1 }),
    segment(dir, "continuation", "workflow", "completed", "continuation")
  ];
  const index = await writeIndex({
    cwd,
    logicalRunId: runId,
    workflowName: spec.name,
    status: "completed",
    finalVerdict: "success_with_warnings",
    segments,
    agentUsage: { planned: 10, actual: 5, repairCalls: 0, recoveryCalls: 0 }
  });
  await writeAcpxProjection(dir, "pre", "completed", { discover_files: outputs.discover_files }, [{ nodeId: "discover_files", nodeType: "compute", outcome: "completed" }]);
  await writeAcpxProjection(dir, "batch-1", "completed", { review_files__item_1: itemOutputs[0], review_files__item_2: itemOutputs[1] }, [
    { nodeId: "review_files__item_1", nodeType: "acp", outcome: "completed" },
    { nodeId: "review_files__item_2", nodeType: "acp", outcome: "blocked" }
  ]);
  await writeAcpxProjection(dir, "batch-2", "completed", { review_files__item_1: itemOutputs[2] }, [{ nodeId: "review_files__item_1", nodeType: "acp", outcome: "completed" }]);
  await writeAcpxProjection(dir, "continuation", "completed", { reconcile: outputs.reconcile, summarize: outputs.summarize }, [
    { nodeId: "reconcile", nodeType: "acp", outcome: "completed" },
    { nodeId: "summarize", nodeType: "acp", outcome: "completed" }
  ]);
  return { cwd, runId, dir, spec, index };
}

async function writeRunFiles(options: {
  cwd: string;
  runId: string;
  dir: string;
  spec: WorkflowSpec;
  outputs: Record<string, unknown>;
  promptText?: string;
}): Promise<void> {
  await fs.mkdir(path.join(options.dir, "outputs"), { recursive: true });
  await fs.mkdir(path.join(options.dir, "segments", "main"), { recursive: true });
  await fs.mkdir(path.join(options.dir, "resolved-prompts", "main"), { recursive: true });
  await writeJson(path.join(options.dir, "workflow.spec.json"), options.spec);
  await writeJson(path.join(options.dir, "input.json"), { task: "fixture task", cwd: options.cwd });
  await writeJson(path.join(options.dir, "segments", "main", "input.json"), { workflowInput: { task: "fixture task", cwd: options.cwd }, runtime: {} });
  await fs.writeFile(path.join(options.dir, "segments", "main", "materialized.flow.ts"), "export default {};\n", "utf8");
  for (const stage of options.spec.stages) {
    await fs.writeFile(path.join(options.dir, "resolved-prompts", "main", `${stage.id}.md`), options.promptText ?? `Prompt for ${stage.id}.\n`, "utf8");
  }
  for (const [stageId, output] of Object.entries(options.outputs)) {
    await writeJson(path.join(options.dir, "outputs", `${stageId}.json`), output);
  }
  await fs.writeFile(path.join(options.dir, "events.ndjson"), [
    JSON.stringify({ at: "2026-01-01T00:00:01.000Z", type: "segment_started", segmentId: "main" }),
    JSON.stringify({ at: "2026-01-01T00:00:02.000Z", type: "stage_output", stageId: Object.keys(options.outputs)[0] })
  ].join("\n") + "\n", "utf8");
}

async function writeIndex(options: Omit<RunIndex, "createdAt" | "updatedAt" | "source"> & { cwd: string }): Promise<RunIndex> {
  const { cwd: _cwd, ...indexFields } = options;
  const index: RunIndex = {
    ...indexFields,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z",
    source: { kind: "draft", path: "fixture.workflow.spec.json" }
  };
  await writeJson(path.join(runDir(index.logicalRunId, options.cwd), "run.json"), index);
  return index;
}

function segment(
  dir: string,
  segmentId: string,
  purpose: RunIndex["segments"][number]["purpose"],
  status: RunIndex["segments"][number]["status"],
  acpxName: string,
  extra: Partial<RunIndex["segments"][number]> = {}
): RunIndex["segments"][number] {
  const segmentDir = path.join(dir, "segments", segmentId);
  return {
    segmentId,
    purpose,
    status,
    materializedFlow: path.join(segmentDir, "materialized.flow.ts"),
    input: path.join(segmentDir, "input.json"),
    acpxRunId: `${acpxName}-acpx`,
    acpxRunDir: path.join(dir, "acpx-runs", acpxName),
    ...extra
  };
}

async function writeAcpxProjection(
  dir: string,
  name: string,
  status: string,
  outputs: Record<string, unknown>,
  steps: Array<{ nodeId: string; nodeType: string; outcome: string }>
): Promise<void> {
  const projectionDir = path.join(dir, "acpx-runs", name, "projections");
  await fs.mkdir(projectionDir, { recursive: true });
  await writeJson(path.join(projectionDir, "run.json"), {
    runId: `${name}-acpx`,
    flowName: name,
    flowPath: path.join(dir, "segments", name, "materialized.flow.ts"),
    status,
    outputs,
    steps
  });
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validationOutput(label: string, status: "completed" | "blocked") {
  return {
    status,
    summary: `${label} ${status}`,
    artifacts: [],
    nextFocus: "reconcile",
    verdict: status === "completed" ? "pass" : "blocked",
    severityCounts: { P0: 0, P1: 0, P2: status === "blocked" ? 1 : 0, P3: 0 },
    findings: status === "blocked" ? [{ severity: "P2", summary: "Needs manual inspection", path: label }] : [],
    checks: []
  };
}
