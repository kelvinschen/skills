import fs from "node:fs/promises";
import path from "node:path";
import { readFlowResult } from "../acpx/bundle.js";
import { runDir } from "../run-index/paths.js";
import type { RunIndex } from "../run-index/read-write.js";
import type { Stage, WorkflowSpec } from "../schema/workflow-spec.js";
import { runViewFromIndex, type RunView, type RunViewStatus } from "./run-view.js";

export const REPORT_VIEW_VERSION = "acpx-orchestrator.report/v1";

const DEFAULT_LIMITS = {
  promptPreviewChars: 4096,
  outputPreviewChars: 8192,
  diagnosticPreviewChars: 8192,
  rawJsonPreviewChars: 8192,
  eventLimit: 200,
  fanoutItemLimit: 200
};

export type ReportMode = "snapshot" | "live";
export type ReportStageStatus = "pending" | "running" | "completed" | "blocked" | "failed" | "skipped" | "unknown";

export type ReportPreview = {
  text: string;
  truncated: boolean;
  originalChars?: number;
  path?: string;
};

export type RunReportView = {
  version: typeof REPORT_VIEW_VERSION;
  generatedAt: string;
  mode: ReportMode;
  summary: RunView;
  run: {
    logicalRunId: string;
    workflowName: string;
    status: RunViewStatus;
    finalVerdict?: RunIndex["finalVerdict"];
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

export type ReportGraphNode = {
  id: string;
  label: string;
  kind: Stage["kind"];
  status: ReportStageStatus;
  detailRef: string;
  roleName?: string;
  agent?: string;
  mode?: string;
  badges: string[];
  metrics: Record<string, string | number | boolean>;
};

export type ReportGraphEdge = {
  id: string;
  source: string;
  target: string;
  relation: "dependency" | "decision-route";
  label?: string;
  active?: boolean;
};

export type ReportStageDetail = {
  id: string;
  kind: Stage["kind"];
  dependsOn: string[];
  status: ReportStageStatus;
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

export type ReportSegmentDetail = {
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

export type ReportEvent = {
  id: string;
  at?: string;
  type?: string;
  preview: ReportPreview;
  raw: Record<string, unknown>;
};

export type ReportArtifact = {
  stageId?: string;
  kind?: string;
  path?: string;
  url?: string;
  label?: string;
};

export type ReportDiagnostic = {
  id: string;
  path: string;
  status?: string;
  summary?: string;
  preview: ReportPreview;
};

export type BuildRunReportOptions = {
  mode: ReportMode;
  limits?: Partial<typeof DEFAULT_LIMITS>;
};

export async function buildRunReportView(
  cwd: string,
  spec: WorkflowSpec,
  index: RunIndex,
  options: BuildRunReportOptions
): Promise<RunReportView> {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const dir = runDir(index.logicalRunId, cwd);
  const summary = await runViewFromIndex(cwd, spec, index);
  const events = await readEvents(dir, limits);
  const segmentDetails = await buildSegmentDetails(index);
  const stageDetails = await buildStageDetails(dir, spec, index, events, segmentDetails, limits);
  const diagnostics = await readDiagnostics(dir, limits);
  const artifacts = await collectArtifacts(stageDetails);
  const graph = buildGraph(spec, stageDetails);
  const durationMs = terminalStatus(index.status) ? positiveDuration(index.createdAt, index.updatedAt) : undefined;

  return {
    version: REPORT_VIEW_VERSION,
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    summary,
    run: {
      logicalRunId: index.logicalRunId,
      workflowName: index.workflowName,
      status: index.status,
      finalVerdict: index.finalVerdict,
      createdAt: index.createdAt,
      updatedAt: index.updatedAt,
      durationMs,
      runDir: dir,
      source: index.source
    },
    metrics: buildMetrics(stageDetails, segmentDetails, index),
    graph,
    stages: stageDetails,
    segments: segmentDetails,
    events,
    artifacts,
    diagnostics
  };
}

export function makePreview(text: string, limit: number, filePath?: string): ReportPreview {
  const originalChars = text.length;
  const truncated = originalChars > limit;
  return {
    text: truncated ? text.slice(0, limit) : text,
    truncated,
    originalChars: truncated ? originalChars : undefined,
    path: filePath
  };
}

async function buildSegmentDetails(index: RunIndex): Promise<ReportSegmentDetail[]> {
  return Promise.all(index.segments.map(async (segment) => {
    const projection = segment.acpxRunDir ? await readFlowResult(segment.acpxRunDir) : undefined;
    const steps = projection?.steps ?? [];
    return {
      segmentId: segment.segmentId,
      purpose: segment.purpose ?? "workflow",
      status: segment.status,
      materializedFlowPath: segment.materializedFlow,
      inputPath: segment.input,
      acpxRunId: segment.acpxRunId,
      acpxRunDir: segment.acpxRunDir,
      fanoutStageId: segment.fanoutStageId,
      batchIndex: segment.batchIndex,
      itemStart: segment.itemStart,
      itemCount: segment.itemCount,
      outputCount: Object.keys(projection?.outputs ?? {}).length,
      stepCount: steps.length,
      agentStepCount: steps.filter((step) => step.nodeType === "acp").length,
      repairStepCount: steps.filter((step) => step.nodeType === "acp" && step.nodeId.endsWith("__repair")).length,
      error: projection?.error
    };
  }));
}

async function buildStageDetails(
  dir: string,
  spec: WorkflowSpec,
  index: RunIndex,
  events: ReportEvent[],
  segments: ReportSegmentDetail[],
  limits: typeof DEFAULT_LIMITS
): Promise<ReportStageDetail[]> {
  return Promise.all(spec.stages.map(async (stage) => {
    const outputPath = path.join(dir, "outputs", `${stage.id}.json`);
    const output = await readJsonIfExists(outputPath);
    const promptPath = await findPromptPath(dir, stage.id);
    const prompt = promptPath ? makePreview(await fs.readFile(promptPath, "utf8"), limits.promptPreviewChars, promptPath) : undefined;
    const outputPreview = output === undefined
      ? undefined
      : makePreview(JSON.stringify(output, null, 2), limits.outputPreviewChars, outputPath);
    const roleName = stageRoleName(stage);
    const role = roleName ? spec.roles[roleName] : undefined;
    const relatedSegmentIds = relatedSegments(stage, segments);
    const relatedEventIds = events
      .filter((event) => event.preview.text.includes(stage.id) || event.raw.stageId === stage.id || event.raw.fanoutStageId === stage.id)
      .map((event) => event.id);

    return {
      id: stage.id,
      kind: stage.kind,
      dependsOn: stage.dependsOn ?? [],
      status: deriveStageStatus(stage, output, index, segments),
      summary: stringField(output, "summary"),
      roleName,
      roleCategory: role?.category,
      agent: role?.agent,
      mode: role?.mode,
      prompt,
      output: outputPreview,
      outputPath: output === undefined ? undefined : outputPath,
      outputShape: outputShape(output),
      fanout: stage.kind === "fanout" ? await buildFanoutDetail(dir, stage, output, segments, limits) : undefined,
      decision: stage.kind === "decisionGate" ? buildDecisionDetail(stage, output) : undefined,
      fixLoop: stage.kind === "fixLoop" ? buildFixLoopDetail(stage, output) : undefined,
      relatedSegmentIds,
      relatedEventIds
    };
  }));
}

function buildGraph(spec: WorkflowSpec, stages: ReportStageDetail[]): RunReportView["graph"] {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const nodes = spec.stages.map((stage): ReportGraphNode => {
    const detail = stageById.get(stage.id);
    const badges: string[] = [stage.kind];
    if (detail?.mode) badges.push(detail.mode);
    if (detail?.fanout?.totalItems !== undefined) badges.push(`${detail.fanout.completedItems ?? 0}/${detail.fanout.totalItems} items`);
    return {
      id: stage.id,
      label: stage.id,
      kind: stage.kind,
      status: detail?.status ?? "unknown",
      detailRef: stage.id,
      roleName: detail?.roleName,
      agent: detail?.agent,
      mode: detail?.mode,
      badges,
      metrics: graphMetrics(detail)
    };
  });
  const dependencyEdges = spec.stages.flatMap((stage) =>
    (stage.dependsOn ?? []).map((source) => ({
      id: `${source}->${stage.id}`,
      source,
      target: stage.id,
      relation: "dependency" as const
    }))
  );
  const decisionEdges = spec.stages.flatMap((stage) => {
    if (stage.kind !== "decisionGate") return [];
    const decision = stageById.get(stage.id)?.decision;
    return [
      ...stage.rules.map((rule, index) => ({
        id: `${stage.id}:route:${index}->${rule.to}`,
        source: stage.id,
        target: rule.to,
        relation: "decision-route" as const,
        label: `rule ${index + 1}`,
        active: decision?.matchedRoute === rule.to
      })),
      ...(stage.default !== "blocked" ? [{
        id: `${stage.id}:default->${stage.default}`,
        source: stage.id,
        target: stage.default,
        relation: "decision-route" as const,
        label: "default",
        active: decision?.matchedRoute === stage.default
      }] : [])
    ].filter((edge) => spec.stages.some((candidate) => candidate.id === edge.target));
  });
  return { nodes, edges: [...dependencyEdges, ...decisionEdges] };
}

function buildMetrics(stages: ReportStageDetail[], segments: ReportSegmentDetail[], index: RunIndex): RunReportView["metrics"] {
  return {
    stagesTotal: stages.length,
    stagesCompleted: stages.filter((stage) => stage.status === "completed").length,
    stagesBlocked: stages.filter((stage) => stage.status === "blocked").length,
    stagesFailed: stages.filter((stage) => stage.status === "failed").length,
    stagesRunning: stages.filter((stage) => stage.status === "running").length,
    stagesPending: stages.filter((stage) => stage.status === "pending").length,
    segmentsTotal: segments.length,
    segmentsRunning: segments.filter((segment) => segment.status === "running").length,
    segmentsCompleted: segments.filter((segment) => segment.status === "completed").length,
    segmentsBlocked: segments.filter((segment) => segment.status === "blocked").length,
    segmentsFailed: segments.filter((segment) => segment.status === "failed").length,
    agentCallsPlanned: index.agentUsage.planned,
    agentCallsActual: index.agentUsage.actual,
    repairCalls: index.agentUsage.repairCalls,
    recoveryCalls: index.agentUsage.recoveryCalls
  };
}

async function buildFanoutDetail(
  dir: string,
  stage: Extract<Stage, { kind: "fanout" }>,
  output: unknown,
  segments: ReportSegmentDetail[],
  limits: typeof DEFAULT_LIMITS
): Promise<ReportStageDetail["fanout"]> {
  const itemDir = path.join(dir, "outputs", stage.id);
  const itemFiles = await listJsonFiles(itemDir);
  const displayed = itemFiles.slice(0, limits.fanoutItemLimit);
  const items = await Promise.all(displayed.map(async (file) => {
    const value = await readJsonIfExists(file);
    return {
      id: path.basename(file, ".json"),
      status: stringField(value, "status"),
      summary: stringField(value, "summary"),
      outputPath: file,
      output: value === undefined ? undefined : makePreview(JSON.stringify(value, null, 2), limits.outputPreviewChars, file)
    };
  }));
  const aggregate = objectRecord(output);
  const aggregateItems = Array.isArray(aggregate?.items) ? aggregate.items : undefined;
  const blockedItems = Array.isArray(aggregate?.blockedItems) ? aggregate.blockedItems.length : items.filter((item) => item.status === "blocked").length;
  return {
    totalItems: aggregateItems?.length ?? itemFiles.length,
    completedItems: aggregateItems?.filter((item) => objectRecord(item)?.status === "completed").length ?? items.filter((item) => item.status === "completed").length,
    blockedItems,
    displayedItems: items.length,
    batchCount: segments.filter((segment) => segment.purpose === "fanout-batch" && segment.fanoutStageId === stage.id).length,
    allowPartial: stage.fanoutPolicy?.allowPartial,
    items
  };
}

function buildDecisionDetail(stage: Extract<Stage, { kind: "decisionGate" }>, output: unknown): ReportStageDetail["decision"] {
  return {
    matchedRoute: stringField(output, "route"),
    defaultRoute: stage.default,
    routes: [...stage.rules.map((rule) => rule.to), stage.default]
  };
}

function buildFixLoopDetail(stage: Extract<Stage, { kind: "fixLoop" }>, output: unknown): ReportStageDetail["fixLoop"] {
  return {
    maxRounds: stage.maxRounds,
    finalValidatorStatus: stringField(output, "verdict") ?? stringField(output, "status")
  };
}

function deriveStageStatus(stage: Stage, output: unknown, index: RunIndex, segments: ReportSegmentDetail[]): ReportStageStatus {
  const outputStatus = stringField(output, "status");
  if (isReportStageStatus(outputStatus)) return outputStatus;
  if (relatedSegments(stage, segments).some((segmentId) => segments.find((segment) => segment.segmentId === segmentId)?.status === "running")) return "running";
  if (index.status === "pending" || index.status === "running") return "pending";
  return "skipped";
}

function relatedSegments(stage: Stage, segments: ReportSegmentDetail[]): string[] {
  const direct = segments.filter((segment) => {
    if (segment.purpose === "fanout-batch") return segment.fanoutStageId === stage.id;
    return segment.purpose === "workflow" || segment.purpose === undefined;
  });
  return direct.map((segment) => segment.segmentId);
}

async function readEvents(dir: string, limits: typeof DEFAULT_LIMITS): Promise<ReportEvent[]> {
  try {
    const text = await fs.readFile(path.join(dir, "events.ndjson"), "utf8");
    const rows = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      const raw = safeJson(line);
      return {
        id: `event-${index + 1}`,
        at: typeof raw.at === "string" ? raw.at : undefined,
        type: typeof raw.type === "string" ? raw.type : undefined,
        preview: makePreview(JSON.stringify(raw, null, 2), limits.rawJsonPreviewChars),
        raw
      };
    });
    return rows.slice(-limits.eventLimit);
  } catch {
    return [];
  }
}

async function readDiagnostics(dir: string, limits: typeof DEFAULT_LIMITS): Promise<ReportDiagnostic[]> {
  const files = await listJsonFiles(path.join(dir, "diagnostics"));
  return Promise.all(files.map(async (file) => {
    const value = await readJsonIfExists(file);
    return {
      id: path.basename(file, ".json"),
      path: file,
      status: stringField(value, "status"),
      summary: stringField(value, "summary"),
      preview: makePreview(JSON.stringify(value ?? {}, null, 2), limits.diagnosticPreviewChars, file)
    };
  }));
}

async function collectArtifacts(stages: ReportStageDetail[]): Promise<ReportArtifact[]> {
  const nested = await Promise.all(stages.map(async (stage) => {
    const output = stage.outputPath ? objectRecord(await readJsonIfExists(stage.outputPath)) ?? {} : {};
    const artifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
    return artifacts
      .filter((artifact): artifact is Record<string, unknown> => Boolean(artifact && typeof artifact === "object"))
      .map((artifact) => ({
        stageId: stage.id,
        kind: stringField(artifact, "kind"),
        path: stringField(artifact, "path"),
        url: stringField(artifact, "url"),
        label: stringField(artifact, "label")
      }));
  }));
  return nested.flat();
}

async function findPromptPath(dir: string, promptId: string): Promise<string | undefined> {
  const root = path.join(dir, "resolved-prompts");
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, `${promptId}.md`);
      try {
        await fs.access(file);
        return file;
      } catch {
        // Continue.
      }
    }
  } catch {
    // No prompt directory.
  }
  return undefined;
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function readJsonIfExists(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function outputShape(output: unknown): ReportStageDetail["outputShape"] | undefined {
  const value = objectRecord(output);
  if (!value) return undefined;
  return {
    keys: Object.keys(value),
    status: stringField(value, "status"),
    verdict: stringField(value, "verdict"),
    finalVerdict: stringField(value, "finalVerdict"),
    findingsCount: Array.isArray(value.findings) ? value.findings.length : undefined,
    checksCount: Array.isArray(value.checks) ? value.checks.length : undefined,
    artifactsCount: Array.isArray(value.artifacts) ? value.artifacts.length : undefined
  };
}

function graphMetrics(detail: ReportStageDetail | undefined): Record<string, string | number | boolean> {
  if (!detail) return {};
  return {
    ...(detail.outputShape?.findingsCount !== undefined ? { findings: detail.outputShape.findingsCount } : {}),
    ...(detail.outputShape?.checksCount !== undefined ? { checks: detail.outputShape.checksCount } : {}),
    ...(detail.fanout?.totalItems !== undefined ? { items: detail.fanout.totalItems, blockedItems: detail.fanout.blockedItems ?? 0 } : {})
  };
}

function stageRoleName(stage: Stage): string | undefined {
  if ("role" in stage && typeof stage.role === "string") return stage.role;
  return undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const record = objectRecord(value);
  const field = record?.[key];
  return typeof field === "string" ? field : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return objectRecord(value) ?? {};
  } catch {
    return {};
  }
}

function terminalStatus(status: RunViewStatus): boolean {
  return status !== "pending" && status !== "running";
}

function positiveDuration(start: string, end: string): number | undefined {
  const started = Date.parse(start);
  const ended = Date.parse(end);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return undefined;
  return ended - started;
}

function isReportStageStatus(value: string | undefined): value is ReportStageStatus {
  return value === "pending" || value === "running" || value === "completed" || value === "blocked" || value === "failed" || value === "skipped" || value === "unknown";
}
