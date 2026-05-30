import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { compileWorkflow, renderPromptMap } from "../compiler/compile.js";
import { estimateAgentCalls } from "../projections/run-view.js";
import { runDir } from "../run-index/paths.js";
import { appendEvent, writeRunIndex, type RunIndex } from "../run-index/read-write.js";
import type { WorkflowSpec } from "../schema/workflow-spec.js";
import { startAcpxFlow } from "../acpx/run-flow.js";
import { fanoutSplitPlan, resolveFanoutItems } from "./segmentation.js";
import { prepareFanoutBatchSegments } from "./fanout-batches.js";

export type PreparedRun = {
  logicalRunId: string;
  dir: string;
  index: RunIndex;
};

export async function prepareRun(spec: WorkflowSpec, options: {
  cwd: string;
  input: Record<string, unknown>;
  sourcePath?: string;
}): Promise<PreparedRun> {
  const logicalRunId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
  const dir = runDir(logicalRunId, options.cwd);
  const splitPlan = fanoutSplitPlan(spec);
  const segmentId = splitPlan && splitPlan.upstreamStageIds.length > 0 ? `pre-${splitPlan.fanout.id}` : "main";
  const segmentDir = path.join(dir, "segments", segmentId);
  const promptDir = path.join(dir, "resolved-prompts", segmentId);
  const compiled = splitPlan && splitPlan.upstreamStageIds.length > 0
    ? compileWorkflow(spec, { stageIds: splitPlan.upstreamStageIds, startStageId: spec.root, nameSuffix: `__pre_${splitPlan.fanout.id}` })
    : (!splitPlan ? compileWorkflow(spec) : undefined);
  if (compiled) {
    await fs.mkdir(segmentDir, { recursive: true });
    await fs.mkdir(promptDir, { recursive: true });
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "workflow.spec.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(dir, "workflow.flow.ts"), compileWorkflow(spec).flowSource, "utf8");
  if (compiled) await fs.writeFile(path.join(segmentDir, "materialized.flow.ts"), compiled.flowSource, "utf8");
  await fs.writeFile(path.join(dir, "input.json"), `${JSON.stringify(options.input, null, 2)}\n`, "utf8");

  const prompts = renderPromptMap(spec);
  if (compiled) {
    for (const [promptId, prompt] of Object.entries(prompts)) {
      await fs.writeFile(path.join(promptDir, `${promptId}.md`), prompt, "utf8");
    }
  }

  const segmentInput = {
    workflowInput: options.input,
    prompts,
    runtime: {
      logicalRunId,
      segmentId,
      promptDir
    }
  };
  if (compiled) await fs.writeFile(path.join(segmentDir, "input.json"), `${JSON.stringify(segmentInput, null, 2)}\n`, "utf8");

  const now = new Date().toISOString();
  const index: RunIndex = {
    logicalRunId,
    workflowName: spec.name,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    source: options.sourcePath ? { kind: "spec", path: options.sourcePath } : undefined,
    segments: compiled
      ? [
          {
            segmentId,
            purpose: "workflow",
            status: "pending",
            materializedFlow: path.join(segmentDir, "materialized.flow.ts"),
            input: path.join(segmentDir, "input.json")
          }
        ]
      : await prepareFanoutBatchSegments({
          cwd: options.cwd,
          logicalRunId,
          spec,
          workflowInput: options.input,
          fanoutStageId: splitPlan!.fanout.id,
          items: resolveFanoutItems(splitPlan!.fanout, options.input, {}),
          preloadedOutputs: {},
          batchSize: splitPlan!.batchSize
        }),
    agentUsage: {
      planned: estimateAgentCalls(spec),
      actual: 0,
      repairCalls: 0,
      recoveryCalls: 0
    }
  };
  await writeRunIndex(options.cwd, index);
  await appendEvent(options.cwd, logicalRunId, { type: "run_prepared", workflowName: spec.name });
  return { logicalRunId, dir, index };
}

export async function startPreparedRun(cwd: string, prepared: PreparedRun): Promise<RunIndex> {
  const segment = prepared.index.segments[0];
  if (!segment) {
    const next: RunIndex = {
      ...prepared.index,
      status: "running"
    };
    await writeRunIndex(cwd, next);
    await appendEvent(cwd, prepared.logicalRunId, {
      type: "run_started_without_initial_segment",
      reason: "No initial segment was materialized; sync will derive continuation work."
    });
    return next;
  }
  const started = await startAcpxFlow({
    cwd,
    flowPath: segment.materializedFlow,
    inputPath: segment.input,
    approveAll: true
  });
  const next: RunIndex = {
    ...prepared.index,
    status: "running",
    segments: [
      {
        ...segment,
        status: "running",
        acpxRunId: started.acpxRunId,
        acpxRunDir: started.acpxRunDir
      }
    ]
  };
  await writeRunIndex(cwd, next);
  await appendEvent(cwd, prepared.logicalRunId, {
    type: "segment_started",
    segmentId: segment.segmentId,
    pid: started.pid,
    logPath: started.logPath,
    acpxRunId: started.acpxRunId,
    acpxRunDir: started.acpxRunDir
  });
  return next;
}
