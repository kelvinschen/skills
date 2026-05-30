import fs from "node:fs/promises";
import path from "node:path";
import { compileFanoutBatchSegment, compileWorkflow, renderPromptMap } from "../compiler/compile.js";
import { runDir } from "../run-index/paths.js";
import type { RunIndex } from "../run-index/read-write.js";
import type { WorkflowSpec } from "../schema/workflow-spec.js";

export type PreparedFanoutBatchOptions = {
  cwd: string;
  logicalRunId: string;
  spec: WorkflowSpec;
  workflowInput: Record<string, unknown>;
  fanoutStageId: string;
  items: unknown[];
  preloadedOutputs: Record<string, unknown>;
  batchSize: number;
};

export async function prepareFanoutBatchSegments(options: PreparedFanoutBatchOptions): Promise<RunIndex["segments"]> {
  const segments: RunIndex["segments"] = [];
  const batchSize = Math.max(1, Math.floor(options.batchSize));
  const prompts = renderPromptMap(options.spec);
  const batchCompiler = compileFanoutBatchSegment(options.spec, options.fanoutStageId, batchSize);

  for (let itemStart = 0, batchIndex = 0; itemStart < options.items.length; itemStart += batchSize, batchIndex += 1) {
    const segmentId = `${options.fanoutStageId}-batch-${batchIndex + 1}`;
    const segmentDir = path.join(runDir(options.logicalRunId, options.cwd), "segments", segmentId);
    const promptDir = path.join(runDir(options.logicalRunId, options.cwd), "resolved-prompts", segmentId);
    const batchItems = options.items.slice(itemStart, itemStart + batchSize);
    await fs.mkdir(segmentDir, { recursive: true });
    await fs.mkdir(promptDir, { recursive: true });
    await fs.writeFile(path.join(segmentDir, "materialized.flow.ts"), batchCompiler.flowSource, "utf8");
    for (const [promptId, prompt] of Object.entries(prompts)) {
      await fs.writeFile(path.join(promptDir, `${promptId}.md`), prompt, "utf8");
    }
    await fs.writeFile(path.join(segmentDir, "input.json"), `${JSON.stringify({
      workflowInput: {
        ...options.workflowInput,
        __fanoutBatchItems: batchItems
      },
      prompts,
      runtime: {
        logicalRunId: options.logicalRunId,
        segmentId,
        promptDir,
        fanoutStageId: options.fanoutStageId,
        itemStart,
        itemCount: batchItems.length,
        preloadedOutputs: options.preloadedOutputs
      }
    }, null, 2)}\n`, "utf8");
    segments.push({
      segmentId,
      purpose: "fanout-batch",
      status: "pending",
      materializedFlow: path.join(segmentDir, "materialized.flow.ts"),
      input: path.join(segmentDir, "input.json"),
      fanoutStageId: options.fanoutStageId,
      batchIndex,
      itemStart,
      itemCount: batchItems.length
    });
  }

  return segments;
}

export async function prepareContinuationSegment(options: {
  cwd: string;
  logicalRunId: string;
  spec: WorkflowSpec;
  workflowInput: Record<string, unknown>;
  stageIds: string[];
  startStageId: string;
  preloadedOutputs: Record<string, unknown>;
}): Promise<RunIndex["segments"][number] | undefined> {
  if (options.stageIds.length === 0) return undefined;
  const segmentId = "continuation";
  const segmentDir = path.join(runDir(options.logicalRunId, options.cwd), "segments", segmentId);
  const promptDir = path.join(runDir(options.logicalRunId, options.cwd), "resolved-prompts", segmentId);
  const prompts = renderPromptMap(options.spec);
  const compiled = compileWorkflow(options.spec, {
    stageIds: options.stageIds,
    startStageId: options.startStageId,
    nameSuffix: "__continuation"
  });
  await fs.mkdir(segmentDir, { recursive: true });
  await fs.mkdir(promptDir, { recursive: true });
  await fs.writeFile(path.join(segmentDir, "materialized.flow.ts"), compiled.flowSource, "utf8");
  for (const [promptId, prompt] of Object.entries(prompts)) {
    await fs.writeFile(path.join(promptDir, `${promptId}.md`), prompt, "utf8");
  }
  await fs.writeFile(path.join(segmentDir, "input.json"), `${JSON.stringify({
    workflowInput: options.workflowInput,
    prompts,
    runtime: {
      logicalRunId: options.logicalRunId,
      segmentId,
      promptDir,
      preloadedOutputs: options.preloadedOutputs
    }
  }, null, 2)}\n`, "utf8");
  return {
    segmentId,
    purpose: "workflow",
    status: "pending",
    materializedFlow: path.join(segmentDir, "materialized.flow.ts"),
    input: path.join(segmentDir, "input.json")
  };
}
