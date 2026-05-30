import fs from "node:fs/promises";
import path from "node:path";
import type { ExecutionPlan, ExecutionPlanStage } from "../compiler/execution-plan.js";
import { stageRoleName } from "../compiler/compile-execution-plan.js";
import { runDir as resolveRunDir } from "../run-index/paths.js";
import { appendEvent, readRunIndex, RuntimeErrorCodes, writeRunIndex, type AttemptIndexEntry, type RunIndex, type StageIndexEntry, type StageStatus } from "../run-index/read-write.js";
import { WorkflowSpecSchema, type Stage, type WorkflowSpec } from "../schema/workflow-spec.js";
import { createOrchestratorAgentRuntime } from "./agent-runtime.js";
import { attemptDir, attemptId, safeFileName, upsertAttemptIndex, writeAttemptFile } from "./attempts.js";
import { resolveSource, runAgentWork, runProgramStage, stableItemId, type AgentWorkResult, type AgentWorkUnit } from "./stage-runner.js";

const STALE_FANOUT_ITEM_RECOVERY_MS = 30_000;

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
  const reconciled = await reconcileFanoutRuntimeState({ ...snapshot, index });
  index = reconciled.index;
  changed ||= reconciled.changed;
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

  index = markUnitsRunning(index, selected, snapshot.runDir);
  index = { ...index, status: "running" };
  await writeRunIndex(cwd, index);
  await appendEvent(cwd, logicalRunId, { type: "scheduler_batch_started", count: selected.length, stages: selected.map((unit) => unit.itemId ? `${unit.stageId}/${unit.itemId}` : unit.stageId) });

  const runtime = createOrchestratorAgentRuntime({ cwd, runDir: snapshot.runDir });
  const batchOutputs = await readAuthorOutputs(snapshot.runDir);
  let results: AgentWorkResult[];
  try {
    const settled = await Promise.allSettled(selected.map((unit) => runAgentWork({
      cwd,
      runDir: snapshot.runDir,
      runId: logicalRunId,
      workflowInput: snapshot.input,
      outputs: batchOutputs,
      plan: snapshot.plan,
      unit,
      runtime
    }).catch(async (error: unknown) => {
      if (unit.type !== "fanoutItem") throw error;
      await appendEvent(cwd, logicalRunId, {
        type: "fanout_item_runtime_error",
        stageId: unit.stageId,
        itemId: unit.itemId,
        errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
        errorMessage: errorMessage(error)
      });
      return fanoutItemRuntimeErrorResult({
        cwd,
        runDir: snapshot.runDir,
        runId: logicalRunId,
        unit,
        error
      });
    })));
    const fatal = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (fatal) throw fatal.reason;
    results = settled.map((result) => (result as PromiseFulfilledResult<AgentWorkResult>).value);
  } finally {
    await runtime.dispose?.();
  }

  // Refresh outputs after each batch; fanout item prompts already received their item local context.
  let merged = await readRunIndex(cwd, logicalRunId);
  merged = { ...merged, stages: index.stages, attempts: index.attempts, agentUsage: index.agentUsage };
  for (const result of results) {
    merged = mergeAgentResult(merged, result, snapshot.runDir);
    await appendEvent(cwd, logicalRunId, { type: "agent_result_merged", stageId: result.stageId, itemId: result.itemId, status: result.status, errorCode: result.errorCode, outputPath: result.outputPath ? path.relative(snapshot.runDir, result.outputPath) : undefined });
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

async function reconcileFanoutRuntimeState(snapshot: RuntimeSnapshot): Promise<{ index: RunIndex; changed: boolean }> {
  let index = snapshot.index;
  let changed = false;
  for (const stage of snapshot.spec.stages.filter((candidate): candidate is Extract<Stage, { kind: "fanout" }> => candidate.kind === "fanout")) {
    const state = index.stages[stage.id];
    if (!state?.fanout || state.status === "completed" || state.status === "blocked" || state.status === "failed") continue;
    let stageChanged = false;
    const items = [...state.fanout.items];
    const attempts: AttemptIndexEntry[] = [];
    for (const [itemPosition, item] of items.entries()) {
      const outputPath = fanoutItemOutputPath(snapshot.runDir, stage.id, item);
      const output = await readJsonIfExists(outputPath);
      if (output) {
        const status = statusFromItemOutput(output);
        const relativeOutputPath = path.relative(snapshot.runDir, outputPath);
        if (item.status !== status || item.outputPath !== relativeOutputPath || item.completedAt === undefined) {
          if (item.status === "running") {
            await appendEvent(snapshot.cwd, snapshot.runId, {
              type: "run_index_output_mismatch",
              code: RuntimeErrorCodes.RUN_INDEX_OUTPUT_MISMATCH,
              stageId: stage.id,
              itemId: item.id,
              outputPath: relativeOutputPath,
              previousStatus: item.status,
              recoveredStatus: status
            });
          }
          items[itemPosition] = {
            ...item,
            status,
            outputPath: relativeOutputPath,
            blockedReason: stringField(output, "blockedReason") ?? item.blockedReason,
            completedAt: item.completedAt ?? new Date().toISOString(),
            errorCode: stringField(output, "blockedReason") ?? item.errorCode
          };
          stageChanged = true;
        }
        continue;
      }

      if (item.status === "running" && isStaleFanoutItem(item.startedAt ?? state.startedAt)) {
        const code = item.attemptId ? RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR : RuntimeErrorCodes.FANOUT_ITEM_UNSTARTED_TIMEOUT;
        const message = item.attemptId
          ? "Fanout item attempt did not produce a terminal output before scheduler recovery."
          : "Fanout item was selected but no attempt was started before scheduler recovery.";
        const result = await writeRecoveredFanoutItemFailure({
          cwd: snapshot.cwd,
          runDir: snapshot.runDir,
          runId: snapshot.runId,
          stageId: stage.id,
          itemId: item.id,
          attemptId: item.attemptId ?? attemptId({ stageId: stage.id, itemId: item.id, kind: "attempt", ordinal: 1 }),
          startedAt: item.startedAt ?? state.startedAt,
          code,
          message,
          outputPath
        });
        items[itemPosition] = {
          ...item,
          status: "blocked",
          outputPath: path.relative(snapshot.runDir, result.outputPath),
          blockedReason: code,
          completedAt: new Date().toISOString(),
          errorCode: code,
          errorMessage: message,
          attemptId: result.attempt.id
        };
        attempts.push(result.attempt);
        stageChanged = true;
        await appendEvent(snapshot.cwd, snapshot.runId, {
          type: "fanout_item_recovered",
          stageId: stage.id,
          itemId: item.id,
          attemptId: result.attempt.id,
          errorCode: code,
          outputPath: path.relative(snapshot.runDir, result.outputPath)
        });
      }
    }
    if (!stageChanged) continue;
    const completedItems = items.filter((item) => item.status === "completed").length;
    const blockedItems = items.filter((item) => item.status === "blocked").length;
    const failedItems = items.filter((item) => item.status === "failed").length;
    index = updateStage(index, stage.id, {
      ...state,
      fanout: {
        ...state.fanout,
        items,
        completedItems,
        blockedItems,
        failedItems
      }
    });
    for (const attempt of attempts) index = upsertAttemptIndex(index, attempt);
    changed = true;
  }
  return { index, changed };
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

function markUnitsRunning(index: RunIndex, units: AgentWorkUnit[], runDir: string): RunIndex {
  let next = index;
  for (const unit of units) {
    const stage = next.stages[unit.stageId];
    if (!stage) continue;
    const startedAt = new Date().toISOString();
    if (unit.itemId && stage.fanout) {
      const selectedAttemptId = attemptId({ stageId: unit.stageId, itemId: unit.itemId, kind: "attempt", ordinal: 1 });
      const items = stage.fanout.items.map((item) => item.id === unit.itemId ? {
        ...item,
        status: "running" as StageStatus,
        attemptId: item.attemptId ?? selectedAttemptId,
        startedAt: item.startedAt ?? startedAt,
        errorCode: undefined,
        errorMessage: undefined
      } : item);
      next = updateStage(next, unit.stageId, {
        ...stage,
        status: "running",
        startedAt: stage.startedAt ?? startedAt,
        fanout: { ...stage.fanout, items }
      });
      next = upsertAttemptIndex(next, {
        id: selectedAttemptId,
        stageId: unit.stageId,
        itemId: unit.itemId,
        kind: "attempt",
        status: "running",
        path: path.relative(runDir, attemptDir(runDir, { stageId: unit.stageId, itemId: unit.itemId, kind: "attempt", ordinal: 1 })),
        startedAt,
        sessionKey: unit.sessionKey,
        requestId: selectedAttemptId,
        agent: unit.role.agent,
        roleMode: unit.role.mode,
        runtimeDisposeInvoked: false
      });
    } else {
      next = updateStage(next, unit.stageId, {
        status: "running",
        startedAt: stage.startedAt ?? startedAt
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
        blockedReason: result.blockedReason,
        completedAt: new Date().toISOString(),
        errorCode: result.errorCode ?? result.blockedReason ?? item.errorCode,
        errorMessage: result.errorMessage ?? result.error ?? item.errorMessage
      };
    });
    const completedItems = items.filter((item) => item.status === "completed").length;
    const blockedItems = items.filter((item) => item.status === "blocked").length;
    const failedItems = items.filter((item) => item.status === "failed").length;
    next = updateStage(next, result.stageId, {
      ...stage,
      status: items.some((item) => item.status === "pending" || item.status === "ready" || item.status === "running") ? "running" : stage.status,
      fanout: {
        ...stage.fanout,
        items,
        completedItems,
        blockedItems,
        failedItems
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
    const failed = items.filter((item) => item.status === "failed").length;
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
        blockedItems: blockedItems.length,
        failedItems: failed
      }
    });
    await appendEvent(snapshot.cwd, snapshot.runId, { type: "fanout_aggregated", stageId: stage.id, status, itemCount: outputs.length, blockedCount: blockedItems.length });
    changed = true;
  }
  return { index, changed };
}

async function fanoutItemRuntimeErrorResult(input: {
  cwd: string;
  runDir: string;
  runId: string;
  unit: AgentWorkUnit;
  error: unknown;
}): Promise<AgentWorkResult> {
  const itemId = input.unit.itemId ?? "item";
  const id = attemptId({ stageId: input.unit.stageId, itemId, kind: "attempt", ordinal: 1 });
  const dir = attemptDir(input.runDir, { stageId: input.unit.stageId, itemId, kind: "attempt", ordinal: 1 });
  const message = errorMessage(input.error);
  const output = runtimeBlockedOutput({
    code: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
    message,
    requestId: id,
    sessionKey: input.unit.sessionKey,
    agent: input.unit.role.agent,
    roleMode: input.unit.role.mode
  });
  const now = new Date().toISOString();
  await writeAttemptFile(dir, "output.json", output);
  await fs.mkdir(path.dirname(input.unit.outputPath), { recursive: true });
  await fs.writeFile(input.unit.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await appendEvent(input.cwd, input.runId, {
    type: "output_written",
    stageId: input.unit.stageId,
    itemId,
    attemptId: id,
    outputPath: path.relative(input.runDir, input.unit.outputPath),
    status: output.status,
    errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR
  });
  return {
    stageId: input.unit.stageId,
    itemId,
    status: "blocked",
    output,
    outputPath: input.unit.outputPath,
    attempts: [{
      id,
      stageId: input.unit.stageId,
      itemId,
      kind: "attempt",
      status: "failed",
      path: path.relative(input.runDir, dir),
      startedAt: now,
      endedAt: now,
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      rawPreview: "",
      promptPreview: "",
      sessionKey: input.unit.sessionKey,
      requestId: id,
      runtimeErrorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      agent: input.unit.role.agent,
      roleMode: input.unit.role.mode,
      runtimeDisposeInvoked: false
    }],
    agentCalls: 0,
    repairCalls: 0,
    blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
    errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
    errorMessage: message
  };
}

async function writeRecoveredFanoutItemFailure(input: {
  cwd: string;
  runDir: string;
  runId: string;
  stageId: string;
  itemId: string;
  attemptId: string;
  startedAt?: string;
  code: string;
  message: string;
  outputPath: string;
}): Promise<{ outputPath: string; attempt: AttemptIndexEntry }> {
  const dir = attemptDir(input.runDir, { stageId: input.stageId, itemId: input.itemId, kind: "attempt", ordinal: 1 });
  const output = runtimeBlockedOutput({
    code: input.code,
    message: input.message,
    requestId: input.attemptId,
    sessionKey: undefined,
    agent: undefined,
    roleMode: undefined
  });
  const now = new Date().toISOString();
  await writeAttemptFile(dir, "output.json", output);
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
  await fs.writeFile(input.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await appendEvent(input.cwd, input.runId, {
    type: "output_written",
    stageId: input.stageId,
    itemId: input.itemId,
    attemptId: input.attemptId,
    outputPath: path.relative(input.runDir, input.outputPath),
    status: output.status,
    errorCode: input.code
  });
  return {
    outputPath: input.outputPath,
    attempt: {
      id: input.attemptId,
      stageId: input.stageId,
      itemId: input.itemId,
      kind: "attempt",
      status: "failed",
      path: path.relative(input.runDir, dir),
      startedAt: input.startedAt,
      endedAt: now,
      blockedReason: input.code,
      runtimeErrorCode: input.code,
      rawPreview: "",
      promptPreview: ""
    }
  };
}

function runtimeBlockedOutput(input: {
  code: string;
  message: string;
  requestId: string;
  sessionKey?: string;
  agent?: string;
  roleMode?: string;
}): Record<string, unknown> {
  return {
    status: "blocked",
    summary: input.message,
    artifacts: [],
    nextFocus: "diagnose",
    blockedReason: input.code,
    runtimeDiagnostics: {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      agent: input.agent,
      roleMode: input.roleMode,
      runtimeDisposeInvoked: false,
      errorCode: input.code,
      rawTextPreview: ""
    }
  };
}

function fanoutItemOutputPath(runDir: string, stageId: string, item: { id: string; outputPath?: string }): string {
  return item.outputPath ? path.join(runDir, item.outputPath) : path.join(runDir, "outputs", stageId, `${safeFileName(item.id)}.json`);
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function statusFromItemOutput(output: Record<string, unknown>): StageStatus {
  if (output.status === "completed") return "completed";
  if (output.status === "failed") return "failed";
  return "blocked";
}

function isStaleFanoutItem(startedAt: string | undefined): boolean {
  if (!startedAt) return false;
  const start = Date.parse(startedAt);
  return Number.isFinite(start) && Date.now() - start >= STALE_FANOUT_ITEM_RECOVERY_MS;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  } else if (statuses.length > 0 && statuses.every((stageStatus) => stageStatus === "completed" || stageStatus === "skipped")) {
    status = "completed";
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
