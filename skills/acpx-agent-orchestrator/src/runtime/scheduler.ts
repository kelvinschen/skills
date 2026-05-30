import fs from "node:fs/promises";
import path from "node:path";
import type { ExecutionPlan, ExecutionPlanStage } from "../compiler/execution-plan.js";
import { stageRoleName } from "../compiler/compile-execution-plan.js";
import { runDir as resolveRunDir } from "../run-index/paths.js";
import { appendEvent, readRunIndex, writeRunIndex, type RunIndex, type StageIndexEntry, type StageStatus } from "../run-index/read-write.js";
import { WorkflowSpecSchema, type Stage, type WorkflowSpec } from "../schema/workflow-spec.js";
import { createOrchestratorAgentRuntime } from "./agent-runtime.js";
import { safeFileName, upsertAttemptIndex } from "./attempts.js";
import { resolveSource, runAgentWork, runProgramStage, stableItemId, type AgentWorkResult, type AgentWorkUnit } from "./stage-runner.js";

export type SyncRunOptions = {
  startPending?: boolean;
};

type RuntimeSnapshot = {
  cwd: string;
  runId: string;
  runDir: string;
  spec: WorkflowSpec;
  plan: ExecutionPlan;
  input: Record<string, unknown>;
  index: RunIndex;
};

export async function syncRun(cwd: string, logicalRunId: string, options: SyncRunOptions = {}): Promise<RunIndex> {
  const snapshot = await loadSnapshot(cwd, logicalRunId);
  let index = ensureStageEntries(snapshot.index, snapshot.spec);
  let changed = index !== snapshot.index;
  const deterministic = await advanceDeterministicStages({ ...snapshot, index });
  index = deterministic.index;
  changed ||= deterministic.changed;
  if (changed) await writeRunIndex(cwd, index);

  if (options.startPending === false) {
    index = updateRunStatus(index, snapshot.spec);
    await writeRunIndex(cwd, index);
    await appendEvent(cwd, logicalRunId, { type: "run_synced", status: index.status, startPending: false });
    return readRunIndex(cwd, logicalRunId);
  }

  const readyUnits = await collectReadyAgentWork({ ...snapshot, index });
  index = await readRunIndex(cwd, logicalRunId);
  const selected = selectRunnableUnits(index, snapshot.plan, readyUnits);
  if (selected.length === 0) {
    const next = updateRunStatus(index, snapshot.spec);
    if (changed || next.status !== index.status || next.blockedReason !== index.blockedReason || next.finalVerdict !== index.finalVerdict) {
      await writeRunIndex(cwd, next);
      await appendEvent(cwd, logicalRunId, { type: "run_synced", status: next.status });
      return readRunIndex(cwd, logicalRunId);
    }
    return index;
  }

  index = markUnitsRunning(index, selected);
  index = { ...index, status: "running" };
  await writeRunIndex(cwd, index);
  await appendEvent(cwd, logicalRunId, { type: "scheduler_batch_started", count: selected.length, stages: selected.map((unit) => unit.itemId ? `${unit.stageId}/${unit.itemId}` : unit.stageId) });

  const runtime = createOrchestratorAgentRuntime({ cwd, runDir: snapshot.runDir });
  const batchOutputs = await readAuthorOutputs(snapshot.runDir);
  let results: AgentWorkResult[];
  try {
    results = await Promise.all(selected.map((unit) => runAgentWork({
      cwd,
      runDir: snapshot.runDir,
      runId: logicalRunId,
      workflowInput: snapshot.input,
      outputs: batchOutputs,
      plan: snapshot.plan,
      unit,
      runtime
    })));
  } finally {
    await runtime.dispose?.();
  }

  // Refresh outputs after each batch; fanout item prompts already received their item local context.
  let merged = await readRunIndex(cwd, logicalRunId);
  merged = { ...merged, stages: index.stages, attempts: index.attempts, agentUsage: index.agentUsage };
  for (const result of results) {
    merged = mergeAgentResult(merged, result, snapshot.runDir);
  }
  const afterFanout = await completeReadyFanoutAggregates({ ...snapshot, index: merged });
  merged = afterFanout.index;
  const afterDeterministic = await advanceDeterministicStages({ ...snapshot, index: merged });
  merged = updateRunStatus(afterDeterministic.index, snapshot.spec);
  await writeRunIndex(cwd, merged);
  await appendEvent(cwd, logicalRunId, { type: "scheduler_batch_completed", status: merged.status });
  return readRunIndex(cwd, logicalRunId);

}

async function loadSnapshot(cwd: string, runId: string): Promise<RuntimeSnapshot> {
  const runDir = resolveRunDir(runId, cwd);
  const [specRaw, planRaw, inputRaw, index] = await Promise.all([
    fs.readFile(path.join(runDir, "workflow.spec.json"), "utf8"),
    fs.readFile(path.join(runDir, "execution-plan.json"), "utf8"),
    fs.readFile(path.join(runDir, "input.json"), "utf8"),
    readRunIndex(cwd, runId)
  ]);
  return {
    cwd,
    runId,
    runDir,
    spec: WorkflowSpecSchema.parse(JSON.parse(specRaw)),
    plan: JSON.parse(planRaw) as ExecutionPlan,
    input: JSON.parse(inputRaw) as Record<string, unknown>,
    index
  };
}

function ensureStageEntries(index: RunIndex, spec: WorkflowSpec): RunIndex {
  let changed = false;
  const stages = { ...index.stages };
  for (const stage of spec.stages) {
    if (stages[stage.id]) continue;
    stages[stage.id] = {
      stageId: stage.id,
      status: "pending",
      attempts: []
    };
    changed = true;
  }
  return changed ? { ...index, stages } : index;
}

async function advanceDeterministicStages(snapshot: RuntimeSnapshot): Promise<{ index: RunIndex; changed: boolean }> {
  let index = snapshot.index;
  let changed = false;
  let progressed = true;
  while (progressed) {
    progressed = false;
    const outputs = await readAuthorOutputs(snapshot.runDir);
    for (const stage of snapshot.spec.stages) {
      const state = index.stages[stage.id];
      if (!state || state.status === "completed" || state.status === "blocked" || state.status === "failed" || state.status === "skipped") continue;
      if (!dependenciesCompleted(stage, index)) continue;
      const planStage = snapshot.plan.stages.find((candidate) => candidate.id === stage.id);
      if (!planStage) continue;
      const programOutput = await runProgramStage({ ...snapshot, workflowInput: snapshot.input, stage, planStage, outputs });
      if (!programOutput) continue;
      const outputPath = path.join(snapshot.runDir, "outputs", `${stage.id}.json`);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(programOutput, null, 2)}\n`, "utf8");
      index = updateStage(index, stage.id, {
        status: programOutput.status === "blocked" ? "blocked" : "completed",
        outputPath: path.relative(snapshot.runDir, outputPath),
        completedAt: new Date().toISOString(),
        blockedReason: typeof programOutput.blockedReason === "string" ? programOutput.blockedReason : undefined
      });
      await appendEvent(snapshot.cwd, snapshot.runId, { type: "program_stage_completed", stageId: stage.id, status: programOutput.status });
      changed = true;
      progressed = true;
      if (stage.kind === "decisionGate") index = markUnselectedDecisionRoutes(index, snapshot.spec, stage, String(programOutput.route ?? "blocked"));
    }
    const fanout = await completeReadyFanoutAggregates({ ...snapshot, index });
    index = fanout.index;
    changed ||= fanout.changed;
    progressed ||= fanout.changed;
  }
  return { index, changed };
}

async function collectReadyAgentWork(snapshot: RuntimeSnapshot): Promise<AgentWorkUnit[]> {
  const outputs = await readAuthorOutputs(snapshot.runDir);
  const units: AgentWorkUnit[] = [];
  for (const stage of snapshot.spec.stages) {
    const state = snapshot.index.stages[stage.id];
    if (!state || state.status === "completed" || state.status === "blocked" || state.status === "failed" || state.status === "skipped" || state.status === "running") continue;
    if (!dependenciesCompleted(stage, snapshot.index)) continue;
    const planStage = snapshot.plan.stages.find((candidate) => candidate.id === stage.id);
    if (!planStage) continue;
    if (stage.kind === "fanout") {
      units.push(...await collectFanoutUnits(snapshot, stage, planStage, outputs));
      continue;
    }
    const unit = agentUnitForStage(snapshot, stage, planStage);
    if (unit) units.push(unit);
  }
  return units;
}

async function collectFanoutUnits(snapshot: RuntimeSnapshot, stage: Extract<Stage, { kind: "fanout" }>, planStage: ExecutionPlanStage, outputs: Record<string, unknown>): Promise<AgentWorkUnit[]> {
  let index = snapshot.index;
  let state = index.stages[stage.id];
  const plan = planStage.fanout;
  if (!state || !plan) return [];
  if (!state.fanout) {
    const resolved = resolveSource(stage.items.source, snapshot.input, outputs);
    const allItems = Array.isArray(resolved) ? resolved : [];
    const items = allItems.slice(0, plan.maxItems).map((item, itemIndex) => ({
      id: stableItemId(item, itemIndex),
      index: itemIndex,
      status: "pending" as StageStatus
    }));
    state = {
      ...state,
      status: items.length === 0 ? "completed" : "ready",
      fanout: {
        totalItems: items.length,
        completedItems: 0,
        blockedItems: 0,
        allowPartial: plan.allowPartial,
        items
      }
    };
    index = updateStage(index, stage.id, state);
    await writeRunIndex(snapshot.cwd, index);
    if (items.length === 0) {
      const output = {
        status: "completed",
        summary: "Fanout completed with 0 item outputs.",
        items: [],
        blockedItems: [],
        artifacts: [],
        nextFocus: "reduce"
      };
      const outputPath = path.join(snapshot.runDir, "outputs", `${stage.id}.json`);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
      index = updateStage(index, stage.id, {
        ...state,
        outputPath: path.relative(snapshot.runDir, outputPath),
        completedAt: new Date().toISOString()
      });
      await writeRunIndex(snapshot.cwd, index);
      return [];
    }
  }
  const sourceItems = Array.isArray(resolveSource(stage.items.source, snapshot.input, outputs)) ? resolveSource(stage.items.source, snapshot.input, outputs) as unknown[] : [];
  return (state.fanout?.items ?? [])
    .filter((item) => item.status === "pending" || item.status === "ready")
    .map((item): AgentWorkUnit => {
      const role = snapshot.spec.roles[stage.role];
      const outputPath = path.join(snapshot.runDir, "outputs", stage.id, `${safeFileName(item.id)}.json`);
      return {
        type: "fanoutItem",
        stageId: stage.id,
        itemId: item.id,
        itemIndex: item.index,
        item: sourceItems[item.index],
        roleName: stage.role,
        role,
        sessionKey: `role:${stage.role}:fanout:${stage.id}:item:${item.id}`,
        promptId: stage.id,
        contract: planStage.contract ?? { name: "base" },
        outputPath,
        cwd: workflowCwd(snapshot.input),
        timeoutMs: timeoutMs(snapshot.plan, planStage)
      };
    });
}

function agentUnitForStage(snapshot: RuntimeSnapshot, stage: Stage, planStage: ExecutionPlanStage): AgentWorkUnit | undefined {
  const needsAgent =
    stage.kind === "agentTask"
    || stage.kind === "summarize"
    || (stage.kind === "discover" && stage.method === "agent")
    || (stage.kind === "reduce" && stage.mode === "agent")
    || (stage.kind === "decisionGate" && stage.mode === "agent")
    || stage.kind === "fixLoop";
  if (!needsAgent) return undefined;
  const roleName = stage.kind === "fixLoop" ? planStage.fixLoop?.validator.roleName : stageRoleName(stage);
  const resolvedRoleName = roleName ?? stageRoleName(stage);
  if (!resolvedRoleName) return undefined;
  const role = snapshot.spec.roles[resolvedRoleName];
  const promptId = stage.kind === "fixLoop" ? planStage.fixLoop?.validator.promptId : planStage.promptId;
  if (!role || !promptId && stage.kind !== "fixLoop") return undefined;
  return {
    type: stage.kind === "fixLoop" ? "fixLoop" : "stage",
    stageId: stage.id,
    roleName: resolvedRoleName,
    role,
    sessionKey: `role:${resolvedRoleName}`,
    promptId: promptId ?? stage.id,
    contract: planStage.contract ?? { name: "base" },
    outputPath: path.join(snapshot.runDir, "outputs", `${stage.id}.json`),
    cwd: workflowCwd(snapshot.input),
    timeoutMs: timeoutMs(snapshot.plan, planStage)
  };
}

function selectRunnableUnits(index: RunIndex, plan: ExecutionPlan, units: AgentWorkUnit[]): AgentWorkUnit[] {
  const remainingAgents = Math.max(0, plan.limits.maxAgents - index.agentUsage.actual);
  if (remainingAgents <= 0) return [];
  const selected: AgentWorkUnit[] = [];
  const sessionKeys = new Set<string>();
  for (const unit of units) {
    const stagePlan = plan.stages.find((stage) => stage.id === unit.stageId);
    const stageMax = stagePlan?.fanout?.maxConcurrency ?? plan.limits.maxConcurrency;
    if (selected.length >= Math.min(plan.limits.maxConcurrency, remainingAgents, stageMax)) break;
    if (sessionKeys.has(unit.sessionKey)) continue;
    sessionKeys.add(unit.sessionKey);
    selected.push(unit);
  }
  return selected;
}

function markUnitsRunning(index: RunIndex, units: AgentWorkUnit[]): RunIndex {
  let next = index;
  for (const unit of units) {
    const stage = next.stages[unit.stageId];
    if (!stage) continue;
    if (unit.itemId && stage.fanout) {
      const items = stage.fanout.items.map((item) => item.id === unit.itemId ? { ...item, status: "running" as StageStatus } : item);
      next = updateStage(next, unit.stageId, {
        ...stage,
        status: "running",
        startedAt: stage.startedAt ?? new Date().toISOString(),
        fanout: { ...stage.fanout, items }
      });
    } else {
      next = updateStage(next, unit.stageId, {
        status: "running",
        startedAt: stage.startedAt ?? new Date().toISOString()
      });
    }
  }
  return next;
}

function mergeAgentResult(index: RunIndex, result: AgentWorkResult, runDir: string): RunIndex {
  let next = index;
  for (const attempt of result.attempts) next = upsertAttemptIndex(next, attempt);
  const stage = next.stages[result.stageId];
  if (!stage) return next;
  if (result.itemId && stage.fanout) {
    const items = stage.fanout.items.map((item) => {
      if (item.id !== result.itemId) return item;
      return {
        ...item,
        status: result.status === "failed" ? "failed" as StageStatus : result.status,
        outputPath: result.outputPath ? path.relative(runDir, result.outputPath) : item.outputPath,
        blockedReason: result.blockedReason
      };
    });
    const completedItems = items.filter((item) => item.status === "completed").length;
    const blockedItems = items.filter((item) => item.status === "blocked").length;
    next = updateStage(next, result.stageId, {
      ...stage,
      status: items.some((item) => item.status === "pending" || item.status === "ready" || item.status === "running") ? "running" : stage.status,
      fanout: {
        ...stage.fanout,
        items,
        completedItems,
        blockedItems
      }
    });
  } else {
    next = updateStage(next, result.stageId, {
      status: result.status === "failed" ? "failed" : result.status,
      outputPath: result.outputPath ? path.relative(runDir, result.outputPath) : stage.outputPath,
      completedAt: new Date().toISOString(),
      blockedReason: result.blockedReason
    });
    const stageSpec = Object.values(next.stages).find((entry) => entry.stageId === result.stageId);
    void stageSpec;
  }
  const finalVerdict = finalVerdictFromOutput(result.output) ?? next.finalVerdict;
  return {
    ...next,
    finalVerdict,
    agentUsage: {
      ...next.agentUsage,
      actual: next.agentUsage.actual + result.agentCalls,
      repairCalls: next.agentUsage.repairCalls + result.repairCalls
    }
  };
}

async function completeReadyFanoutAggregates(snapshot: RuntimeSnapshot): Promise<{ index: RunIndex; changed: boolean }> {
  let index = snapshot.index;
  let changed = false;
  for (const stage of snapshot.spec.stages.filter((candidate): candidate is Extract<Stage, { kind: "fanout" }> => candidate.kind === "fanout")) {
    const state = index.stages[stage.id];
    if (!state?.fanout || state.status === "completed" || state.status === "blocked" || state.status === "failed") continue;
    const items = state.fanout.items;
    if (items.length === 0) continue;
    if (items.some((item) => item.status === "pending" || item.status === "ready" || item.status === "running")) continue;
    const outputs = await Promise.all(items.map(async (item) => {
      const itemPath = path.join(snapshot.runDir, "outputs", stage.id, `${safeFileName(item.id)}.json`);
      try {
        return JSON.parse(await fs.readFile(itemPath, "utf8")) as Record<string, unknown>;
      } catch {
        return {
          status: "blocked",
          summary: `Missing fanout item output ${item.id}.`,
          artifacts: [],
          nextFocus: "diagnose",
          blockedReason: "MISSING_FANOUT_ITEM_OUTPUT"
        };
      }
    }));
    const blockedItems = outputs.filter((output) => output.status === "blocked");
    const completed = outputs.filter((output) => output.status === "completed").length;
    const ratio = outputs.length === 0 ? 1 : completed / outputs.length;
    const policy = stage.fanoutPolicy;
    const partialAllowed = (policy?.allowPartial ?? false)
      && (policy?.minCompletedRatio == null || ratio >= policy.minCompletedRatio)
      && (policy?.maxBlockedItems == null || blockedItems.length <= policy.maxBlockedItems);
    const status = blockedItems.length > 0 && !partialAllowed ? "blocked" : "completed";
    const aggregate = {
      status,
      summary: `Fanout completed with ${outputs.length} item output(s).`,
      items: outputs,
      blockedItems,
      artifacts: [],
      nextFocus: "reduce",
      blockedReason: status === "blocked" ? "FANOUT_ITEM_BLOCKED" : undefined
    };
    const outputPath = path.join(snapshot.runDir, "outputs", `${stage.id}.json`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
    index = updateStage(index, stage.id, {
      ...state,
      status,
      outputPath: path.relative(snapshot.runDir, outputPath),
      blockedReason: aggregate.blockedReason,
      completedAt: new Date().toISOString(),
      fanout: {
        ...state.fanout,
        completedItems: completed,
        blockedItems: blockedItems.length
      }
    });
    await appendEvent(snapshot.cwd, snapshot.runId, { type: "fanout_aggregated", stageId: stage.id, status, itemCount: outputs.length, blockedCount: blockedItems.length });
    changed = true;
  }
  return { index, changed };
}

function updateRunStatus(index: RunIndex, spec: WorkflowSpec): RunIndex {
  const statuses = Object.values(index.stages).map((stage) => stage.status);
  const summarize = spec.stages.find((stage) => stage.kind === "summarize");
  let finalVerdict = index.finalVerdict;
  if (summarize && index.stages[summarize.id]?.status === "completed") {
    finalVerdict = readFinalVerdictFromOutput(index, summarize.id) ?? finalVerdict;
  }
  let status = index.status;
  if (statuses.includes("failed")) status = "failed";
  else if (statuses.includes("blocked")) status = "blocked";
  else if (summarize && index.stages[summarize.id]?.status === "completed") {
    status = finalVerdict && finalVerdict !== "success" && finalVerdict !== "success_with_warnings" ? "blocked" : "completed";
  } else if (statuses.includes("running") || statuses.includes("ready") || statuses.includes("pending")) {
    status = "running";
  }
  const blocked = Object.values(index.stages).find((stage) => stage.status === "blocked");
  return {
    ...index,
    status,
    finalVerdict,
    blockedReason: blocked?.blockedReason ?? index.blockedReason
  };
}

function readFinalVerdictFromOutput(_index: RunIndex, _stageId: string): RunIndex["finalVerdict"] | undefined {
  return undefined;
}

function finalVerdictFromOutput(output: Record<string, unknown> | undefined): RunIndex["finalVerdict"] | undefined {
  const value = output?.finalVerdict;
  if (value === "success" || value === "success_with_warnings" || value === "blocked" || value === "failed" || value === "unknown") return value;
  return undefined;
}

async function readAuthorOutputs(runDir: string): Promise<Record<string, unknown>> {
  const outputs: Record<string, unknown> = {};
  const outputDir = path.join(runDir, "outputs");
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      outputs[path.basename(entry.name, ".json")] = JSON.parse(await fs.readFile(path.join(outputDir, entry.name), "utf8"));
    }
  } catch {
    // Missing output directory means no stages have completed.
  }
  return outputs;
}

function dependenciesCompleted(stage: Stage, index: RunIndex): boolean {
  return (stage.dependsOn ?? []).every((dep) => index.stages[dep]?.status === "completed");
}

function markUnselectedDecisionRoutes(index: RunIndex, spec: WorkflowSpec, stage: Extract<Stage, { kind: "decisionGate" }>, selectedRoute: string): RunIndex {
  const dependents = spec.stages.filter((candidate) => (candidate.dependsOn ?? []).includes(stage.id));
  let next = index;
  for (const dependent of dependents) {
    if (dependent.id === selectedRoute) continue;
    const state = next.stages[dependent.id];
    if (!state || state.status !== "pending") continue;
    next = updateStage(next, dependent.id, { status: "skipped", skippedReason: `Decision ${stage.id} selected ${selectedRoute}.` });
  }
  return next;
}

function updateStage(index: RunIndex, stageId: string, patch: Partial<StageIndexEntry>): RunIndex {
  const current = index.stages[stageId] ?? { stageId, status: "pending", attempts: [] };
  return {
    ...index,
    stages: {
      ...index.stages,
      [stageId]: {
        ...current,
        ...patch,
        stageId,
        attempts: patch.attempts ?? current.attempts
      }
    }
  };
}

function workflowCwd(input: Record<string, unknown>): string {
  return path.resolve(typeof input.cwd === "string" ? input.cwd : process.cwd());
}

function timeoutMs(plan: ExecutionPlan, stage: ExecutionPlanStage): number {
  return (stage.limits.stageTimeoutMinutes ?? plan.limits.stageTimeoutMinutes) * 60 * 1000;
}
