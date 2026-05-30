import fs from "node:fs/promises";
import path from "node:path";
import { readFlowResult, type AcpxFlowRunProjection } from "../acpx/bundle.js";
import { findAcpxRunForFlow, startAcpxFlow } from "../acpx/run-flow.js";
import { runDir } from "../run-index/paths.js";
import { appendEvent, readRunIndex, writeRunIndex, type RunIndex } from "../run-index/read-write.js";
import type { RunViewStatus } from "../projections/run-view.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../schema/workflow-spec.js";
import { prepareContinuationSegment, prepareFanoutBatchSegments } from "./fanout-batches.js";
import { fanoutSplitPlan, readSourceStageId, resolveFanoutItems } from "./segmentation.js";

export async function syncRun(cwd: string, logicalRunId: string, options: { startPending?: boolean } = {}): Promise<RunIndex> {
  const index = await readRunIndex(cwd, logicalRunId);
  const spec = await readRunSpec(cwd, logicalRunId);
  const authorStageIds = new Set(spec.stages.map((stage) => stage.id));
  const fanoutStageIds = spec.stages.filter((stage) => stage.kind === "fanout").map((stage) => stage.id);
  const summarizeStage = spec.stages.find((stage) => stage.kind === "summarize")?.id;
  let changed = false;
  const outputsDir = path.join(runDir(logicalRunId, cwd), "outputs");
  const diagnosticsDir = path.join(runDir(logicalRunId, cwd), "diagnostics");
  await fs.mkdir(outputsDir, { recursive: true });
  await fs.mkdir(diagnosticsDir, { recursive: true });

  const segments: RunIndex["segments"] = [];
  let actualAgentCalls = 0;
  let recoveryCalls = 0;
  let repairCalls = 0;
  let finalVerdict: RunIndex["finalVerdict"] | undefined;
  let blockedReason: string | undefined = index.blockedReason;
  for (const segment of index.segments) {
    let currentSegment = segment;
    if (!currentSegment.acpxRunDir) {
      const earliest = Date.parse(index.createdAt);
      const found = await findAcpxRunForFlow(currentSegment.materializedFlow, Number.isFinite(earliest) ? earliest - 1000 : 0);
      if (found) {
        currentSegment = { ...currentSegment, acpxRunId: found.runId, acpxRunDir: found.runDir };
        changed = true;
      }
    }
    if (!currentSegment.acpxRunDir) {
      segments.push(currentSegment);
      continue;
    }
    const projection = await readFlowResult(currentSegment.acpxRunDir);
    if (!projection) {
      segments.push(currentSegment);
      continue;
    }
    const segmentAgentCalls = countAgentSteps(projection);
    actualAgentCalls += segmentAgentCalls;
    if (currentSegment.purpose === "diagnostic") recoveryCalls += segmentAgentCalls;
    repairCalls += countRepairSteps(projection);
    finalVerdict = finalVerdict ?? finalVerdictFromOutputs(projection.outputs, summarizeStage);
    blockedReason = blockedReason ?? blockedReasonFromOutputs(projection.outputs);
    const mapped = mapSegmentStatus(currentSegment, projection, summarizeStage);
    if (mapped !== segment.status) changed = true;
    if (projection.outputs) {
      for (const [stageId, output] of Object.entries(projection.outputs)) {
        if (currentSegment.purpose === "diagnostic") {
          await fs.writeFile(path.join(diagnosticsDir, `${stageId}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8");
        } else if (currentSegment.purpose === "fanout-batch") {
          const fanoutId = currentSegment.fanoutStageId;
          const match = fanoutId ? new RegExp(`^${escapeRegExp(fanoutId)}__item_([0-9]+)$`).exec(stageId) : undefined;
          if (fanoutId && match) {
            const globalIndex = (currentSegment.itemStart ?? 0) + Number(match[1]);
            const globalStageId = `${fanoutId}__item_${globalIndex}`;
            await fs.mkdir(path.join(outputsDir, fanoutId), { recursive: true });
            await fs.writeFile(path.join(outputsDir, fanoutId, `${globalStageId}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8");
          }
        } else if (authorStageIds.has(stageId)) {
          await fs.writeFile(path.join(outputsDir, `${stageId}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8");
        } else {
          const fanoutId = fanoutStageIds.find((id) => new RegExp(`^${escapeRegExp(id)}__item_[0-9]+$`).test(stageId));
          if (fanoutId) {
            await fs.mkdir(path.join(outputsDir, fanoutId), { recursive: true });
            await fs.writeFile(path.join(outputsDir, fanoutId, `${stageId}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8");
          }
        }
      }
    }
    segments.push({ ...currentSegment, status: mapped });
  }

  let nextSegments = segments;
  const planned = await maybePlanFanoutBatches(cwd, spec, { ...index, segments: nextSegments });
  if (planned.changed) {
    changed = true;
    nextSegments = planned.index.segments;
  }
  const aggregated = await maybeAggregateFanoutBatches(cwd, spec, { ...index, segments: nextSegments });
  if (aggregated.changed) {
    changed = true;
    nextSegments = aggregated.index.segments;
  }
  const continued = await maybePrepareContinuation(cwd, spec, { ...index, segments: nextSegments });
  if (continued.changed) {
    changed = true;
    nextSegments = continued.index.segments;
  }
  if (options.startPending !== false) {
    const started = await startPendingSegments(cwd, spec, { ...index, segments: nextSegments });
    if (started.changed) {
      changed = true;
      nextSegments = started.index.segments;
    }
  }

  const blockedAuthorReason = await blockedReasonFromAuthorOutputs(cwd, logicalRunId);
  blockedReason = blockedReason ?? blockedAuthorReason;
  let nextStatus = summarizeStatus(nextSegments);
  if (nextStatus === "completed" && blockedAuthorReason) nextStatus = "blocked";
  if (nextStatus !== index.status) changed = true;
  if (actualAgentCalls !== index.agentUsage.actual) changed = true;
  if (recoveryCalls !== index.agentUsage.recoveryCalls) changed = true;
  if (repairCalls !== index.agentUsage.repairCalls) changed = true;
  if (finalVerdict !== index.finalVerdict) changed = true;
  if (blockedReason !== index.blockedReason) changed = true;
  const next = {
    ...index,
    status: nextStatus,
    segments: nextSegments,
    finalVerdict,
    blockedReason,
    agentUsage: {
      ...index.agentUsage,
      actual: actualAgentCalls,
      repairCalls,
      recoveryCalls
    }
  };
  if (changed) {
    await writeRunIndex(cwd, next);
    await appendEvent(cwd, logicalRunId, { type: "run_synced", status: nextStatus });
  }
  return changed ? await readRunIndex(cwd, logicalRunId) : index;
}

async function readRunSpec(cwd: string, logicalRunId: string): Promise<WorkflowSpec> {
  const filePath = path.join(runDir(logicalRunId, cwd), "workflow.spec.json");
  return WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
}

function mapAcpxStatus(projection: AcpxFlowRunProjection, summarizeStage?: string): RunViewStatus {
  if (projection.outputs && Object.values(projection.outputs).some((output) => isBlockedOutput(output))) return "blocked";
  const finalVerdict = finalVerdictFromOutputs(projection.outputs, summarizeStage);
  if (finalVerdict && finalVerdict !== "success" && finalVerdict !== "success_with_warnings") return "blocked";
  if (projection.status === "completed") return "completed";
  if (projection.status === "timed_out") return "blocked";
  if (projection.status === "failed") return "failed";
  if (projection.status === "running" || projection.status === "pending") return "running";
  return "running";
}

function mapSegmentStatus(segment: RunIndex["segments"][number], projection: AcpxFlowRunProjection, summarizeStage?: string): RunViewStatus {
  if (segment.purpose === "fanout-batch") {
    if (projection.status === "completed") return "completed";
    if (projection.status === "failed") return "failed";
    if (projection.status === "timed_out") return "blocked";
    if (projection.status === "running" || projection.status === "pending") return "running";
    return "running";
  }
  return mapAcpxStatus(projection, summarizeStage);
}

function isBlockedOutput(output: unknown): boolean {
  return Boolean(output && typeof output === "object" && (output as Record<string, unknown>).status === "blocked");
}

function summarizeStatus(segments: RunIndex["segments"]): RunViewStatus {
  const statuses = segments.map((segment) => segment.status);
  const workflowStatuses = segments.filter((segment) => segment.purpose !== "diagnostic").map((segment) => segment.status);
  const diagnosticDone = segments.some((segment) => segment.purpose === "diagnostic" && (segment.status === "completed" || segment.status === "blocked"));
  if (diagnosticDone && (workflowStatuses.includes("blocked") || workflowStatuses.includes("failed"))) return "diagnosed_blocked";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("running") || statuses.includes("pending")) return "running";
  if (statuses.every((status) => status === "completed")) return "completed";
  return "running";
}

async function maybePlanFanoutBatches(cwd: string, spec: WorkflowSpec, index: RunIndex): Promise<{ index: RunIndex; changed: boolean }> {
  const plan = fanoutSplitPlan(spec);
  if (!plan) return { index, changed: false };
  if (index.segments.some((segment) => segment.purpose === "fanout-batch" && segment.fanoutStageId === plan.fanout.id)) return { index, changed: false };
  if (await hasAuthorOutput(cwd, index.logicalRunId, plan.fanout.id)) return { index, changed: false };
  const upstreamDone = plan.upstreamStageIds.length === 0
    ? true
    : index.segments.some((segment) => segment.purpose === "workflow" && segment.segmentId === `pre-${plan.fanout.id}` && segment.status === "completed");
  if (!upstreamDone) return { index, changed: false };
  const workflowInput = await readWorkflowInput(cwd, index.logicalRunId);
  const outputs = await readAuthorOutputs(cwd, index.logicalRunId);
  const sourceStage = readSourceStageId(plan.fanout.items.source);
  if (sourceStage && !outputs[sourceStage]) return { index, changed: false };
  const resumePolicy = await readFanoutResumePolicyFromSegments(index, plan.fanout.id);
  const items = applyFanoutResumePolicy(resolveFanoutItems(plan.fanout, workflowInput, outputs), resumePolicy);
  const batchSegments = await prepareFanoutBatchSegments({
    cwd,
    logicalRunId: index.logicalRunId,
    spec,
    workflowInput,
    fanoutStageId: plan.fanout.id,
    items,
    preloadedOutputs: outputs,
    batchSize: plan.batchSize
  });
  await appendEvent(cwd, index.logicalRunId, {
    type: "fanout_batches_prepared",
    fanoutStageId: plan.fanout.id,
    itemCount: items.length,
    batchCount: batchSegments.length
  });
  if (batchSegments.length === 0) {
    await writeAuthorOutput(cwd, index.logicalRunId, plan.fanout.id, {
      status: "completed",
      summary: "Fanout completed with 0 item outputs.",
      items: [],
      blockedItems: [],
      artifacts: [],
      nextFocus: "reduce"
    });
    return { index, changed: true };
  }
  return {
    index: { ...index, segments: [...index.segments, ...batchSegments] },
    changed: batchSegments.length > 0
  };
}

async function maybeAggregateFanoutBatches(cwd: string, spec: WorkflowSpec, index: RunIndex): Promise<{ index: RunIndex; changed: boolean }> {
  const plan = fanoutSplitPlan(spec);
  if (!plan) return { index, changed: false };
  if (await hasAuthorOutput(cwd, index.logicalRunId, plan.fanout.id)) return { index, changed: false };
  const batches = index.segments.filter((segment) => segment.purpose === "fanout-batch" && segment.fanoutStageId === plan.fanout.id);
  if (batches.length === 0) return { index, changed: false };
  if (batches.some((segment) => segment.status === "pending" || segment.status === "running")) return { index, changed: false };
  if (batches.some((segment) => segment.status === "failed")) return { index: { ...index, status: "failed" }, changed: true };
  const itemOutputs = await readFanoutItemOutputs(cwd, index.logicalRunId, plan.fanout.id);
  const blockedItems = itemOutputs.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).status === "blocked");
  const policy = plan.fanout.fanoutPolicy;
  const resumePolicy = await readFanoutResumePolicyFromSegments(index, plan.fanout.id);
  const allowPartial = resumePolicy?.allowPartial ?? policy?.allowPartial ?? false;
  const completed = itemOutputs.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).status === "completed").length;
  const ratio = itemOutputs.length === 0 ? 1 : completed / itemOutputs.length;
  const partialAllowed = allowPartial
    && (policy?.minCompletedRatio == null || ratio >= policy.minCompletedRatio)
    && (policy?.maxBlockedItems == null || blockedItems.length <= policy.maxBlockedItems);
  const aggregate = {
    status: blockedItems.length > 0 && !partialAllowed ? "blocked" : "completed",
    summary: `Fanout completed with ${itemOutputs.length} item outputs.`,
    items: itemOutputs,
    blockedItems,
    artifacts: [],
    nextFocus: "reduce"
  };
  await writeAuthorOutput(cwd, index.logicalRunId, plan.fanout.id, aggregate);
  await appendEvent(cwd, index.logicalRunId, {
    type: "fanout_batches_aggregated",
    fanoutStageId: plan.fanout.id,
    status: aggregate.status,
    itemCount: itemOutputs.length,
    blockedCount: blockedItems.length
  });
  if (aggregate.status === "blocked") return { index, changed: true };
  if (!plan.continuationStartStageId || plan.downstreamStageIds.length === 0) return { index, changed: true };
  if (index.segments.some((segment) => segment.segmentId === "continuation")) return { index, changed: true };
  const workflowInput = await readWorkflowInput(cwd, index.logicalRunId);
  const outputs = await readAuthorOutputs(cwd, index.logicalRunId);
  const continuation = await prepareContinuationSegment({
    cwd,
    logicalRunId: index.logicalRunId,
    spec,
    workflowInput,
    stageIds: plan.downstreamStageIds,
    startStageId: plan.continuationStartStageId,
    preloadedOutputs: outputs
  });
  return {
    index: continuation ? { ...index, segments: [...index.segments, continuation] } : index,
    changed: true
  };
}

async function maybePrepareContinuation(cwd: string, spec: WorkflowSpec, index: RunIndex): Promise<{ index: RunIndex; changed: boolean }> {
  const plan = fanoutSplitPlan(spec);
  if (!plan?.continuationStartStageId || plan.downstreamStageIds.length === 0) return { index, changed: false };
  if (index.segments.some((segment) => segment.segmentId === "continuation")) return { index, changed: false };
  if (index.segments.some((segment) => segment.purpose === "fanout-batch" && segment.fanoutStageId === plan.fanout.id && (segment.status === "pending" || segment.status === "running"))) {
    return { index, changed: false };
  }
  const outputs = await readAuthorOutputs(cwd, index.logicalRunId);
  const fanoutOutput = outputs[plan.fanout.id];
  if (!fanoutOutput || typeof fanoutOutput !== "object" || (fanoutOutput as Record<string, unknown>).status !== "completed") return { index, changed: false };
  const workflowInput = await readWorkflowInput(cwd, index.logicalRunId);
  const continuation = await prepareContinuationSegment({
    cwd,
    logicalRunId: index.logicalRunId,
    spec,
    workflowInput,
    stageIds: plan.downstreamStageIds,
    startStageId: plan.continuationStartStageId,
    preloadedOutputs: outputs
  });
  return {
    index: continuation ? { ...index, segments: [...index.segments, continuation] } : index,
    changed: Boolean(continuation)
  };
}

async function startPendingSegments(cwd: string, spec: WorkflowSpec, index: RunIndex): Promise<{ index: RunIndex; changed: boolean }> {
  const maxConcurrency = spec.limits.maxConcurrency ?? 1;
  let running = index.segments.filter((segment) => segment.status === "running" && segment.purpose !== "diagnostic").length;
  const segments = [...index.segments];
  let changed = false;
  for (let i = 0; i < segments.length && running < maxConcurrency; i += 1) {
    const segment = segments[i];
    if (segment.status !== "pending" || segment.purpose === "diagnostic") continue;
    const started = await startAcpxFlow({
      cwd,
      flowPath: segment.materializedFlow,
      inputPath: segment.input,
      approveAll: true
    });
    segments[i] = {
      ...segment,
      status: "running",
      acpxRunId: started.acpxRunId,
      acpxRunDir: started.acpxRunDir
    };
    running += 1;
    changed = true;
    await appendEvent(cwd, index.logicalRunId, {
      type: "segment_started",
      segmentId: segment.segmentId,
      pid: started.pid,
      logPath: started.logPath,
      acpxRunId: started.acpxRunId,
      acpxRunDir: started.acpxRunDir
    });
  }
  return { index: { ...index, segments }, changed };
}

function countAgentSteps(projection: AcpxFlowRunProjection): number {
  return (projection.steps ?? []).filter((step) => step.nodeType === "acp").length;
}

function countRepairSteps(projection: AcpxFlowRunProjection): number {
  return (projection.steps ?? []).filter((step) => step.nodeType === "acp" && step.nodeId.endsWith("__repair")).length;
}

function finalVerdictFromOutputs(outputs?: Record<string, unknown>, summarizeStage?: string): RunIndex["finalVerdict"] | undefined {
  const output = summarizeStage ? outputs?.[summarizeStage] : undefined;
  if (!output || typeof output !== "object") return undefined;
  const value = (output as Record<string, unknown>).finalVerdict;
  if (value === "success" || value === "success_with_warnings" || value === "blocked" || value === "failed" || value === "unknown") return value;
  return undefined;
}

function blockedReasonFromOutputs(outputs?: Record<string, unknown>): string | undefined {
  const blocked = outputs ? Object.values(outputs).find(isBlockedOutput) : undefined;
  if (!blocked || typeof blocked !== "object") return undefined;
  const reason = (blocked as Record<string, unknown>).blockedReason;
  return typeof reason === "string" ? reason : undefined;
}

async function hasAuthorOutput(cwd: string, logicalRunId: string, stageId: string): Promise<boolean> {
  try {
    await fs.stat(path.join(runDir(logicalRunId, cwd), "outputs", `${stageId}.json`));
    return true;
  } catch {
    return false;
  }
}

async function writeAuthorOutput(cwd: string, logicalRunId: string, stageId: string, output: unknown): Promise<void> {
  const outputsDir = path.join(runDir(logicalRunId, cwd), "outputs");
  await fs.mkdir(outputsDir, { recursive: true });
  await fs.writeFile(path.join(outputsDir, `${stageId}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

async function readWorkflowInput(cwd: string, logicalRunId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(runDir(logicalRunId, cwd), "input.json"), "utf8")) as Record<string, unknown>;
}

async function readAuthorOutputs(cwd: string, logicalRunId: string): Promise<Record<string, unknown>> {
  const outputsDir = path.join(runDir(logicalRunId, cwd), "outputs");
  const outputs: Record<string, unknown> = {};
  try {
    const entries = await fs.readdir(outputsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      outputs[path.basename(entry.name, ".json")] = JSON.parse(await fs.readFile(path.join(outputsDir, entry.name), "utf8"));
    }
  } catch {
    // No outputs yet.
  }
  return outputs;
}

async function blockedReasonFromAuthorOutputs(cwd: string, logicalRunId: string): Promise<string | undefined> {
  const outputs = await readAuthorOutputs(cwd, logicalRunId);
  return blockedReasonFromOutputs(outputs);
}

async function readFanoutItemOutputs(cwd: string, logicalRunId: string, fanoutStageId: string): Promise<unknown[]> {
  const dir = path.join(runDir(logicalRunId, cwd), "outputs", fanoutStageId);
  try {
    const entries = await fs.readdir(dir);
    const numbered = entries
      .map((name) => ({ name, match: new RegExp(`^${escapeRegExp(fanoutStageId)}__item_([0-9]+)\\.json$`).exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => Boolean(entry.match))
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
    return Promise.all(numbered.map((entry) => fs.readFile(path.join(dir, entry.name), "utf8").then((text) => JSON.parse(text) as unknown)));
  } catch {
    return [];
  }
}

type FanoutRuntimePolicy = {
  allowPartial?: boolean;
  maxItems?: number;
  skipItemIndexes?: number[];
};

async function readFanoutResumePolicyFromSegments(index: RunIndex, fanoutStageId: string): Promise<FanoutRuntimePolicy | undefined> {
  let merged: FanoutRuntimePolicy | undefined;
  for (const segment of index.segments) {
    try {
      const input = JSON.parse(await fs.readFile(segment.input, "utf8")) as Record<string, unknown>;
      const runtime = objectRecord(input.runtime);
      const resumePolicy = objectRecord(runtime?.resumePolicy);
      const fanout = objectRecord(resumePolicy?.fanout);
      const policy = objectRecord(fanout?.[fanoutStageId]);
      if (!policy) continue;
      merged = merged ?? {};
      if (typeof policy.allowPartial === "boolean") merged.allowPartial = policy.allowPartial;
      if (Number.isInteger(policy.maxItems) && Number(policy.maxItems) >= 0) {
        merged.maxItems = merged.maxItems === undefined ? Number(policy.maxItems) : Math.min(merged.maxItems, Number(policy.maxItems));
      }
      if (Array.isArray(policy.skipItemIndexes)) {
        merged.skipItemIndexes = [
          ...(merged.skipItemIndexes ?? []),
          ...policy.skipItemIndexes.filter((item): item is number => Number.isInteger(item) && item >= 0)
        ];
      }
    } catch {
      // Segment inputs are best-effort audit data for runtime policy recovery.
    }
  }
  return merged;
}

function applyFanoutResumePolicy(items: unknown[], policy?: FanoutRuntimePolicy): unknown[] {
  if (!policy) return items;
  const skipped = new Set(policy.skipItemIndexes ?? []);
  return items.filter((_, index) => {
    if (policy.maxItems !== undefined && index >= policy.maxItems) return false;
    return !skipped.has(index);
  });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
