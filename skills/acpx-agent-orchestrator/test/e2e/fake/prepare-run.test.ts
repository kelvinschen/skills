import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareRun, startPreparedRun } from "../../../src/runtime/run-workflow.js";
import { syncRun } from "../../../src/runtime/sync.js";
import { prepareFanoutBatchSegments } from "../../../src/runtime/fanout-batches.js";
import { writeRunIndex } from "../../../src/run-index/read-write.js";
import { WorkflowSpecSchema } from "../../../src/schema/workflow-spec.js";

describe("fake e2e run preparation", () => {
  it("creates a logical run snapshot", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-orchestrator-test-"));
    const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows/examples/simple-feature.workflow.spec.json"), "utf8")));
    const prepared = await prepareRun(spec, {
      cwd: temp,
      input: { task: "test", cwd: temp, testHints: "" },
      sourcePath: "example"
    });
    await expect(fs.stat(path.join(prepared.dir, "run.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "segments/main/materialized.flow.ts"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "resolved-prompts/main/plan.md"))).resolves.toBeTruthy();
  });

  it("syncs fanout item outputs under the author fanout directory", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-orchestrator-sync-"));
    const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows/examples/review-only-fanout.workflow.spec.json"), "utf8")));
    const prepared = await prepareRun(spec, {
      cwd: temp,
      input: { task: "review", cwd: temp },
      sourcePath: "example"
    });
    const acpxRunDir = path.join(temp, "fake-acpx-run");
    await fs.mkdir(path.join(acpxRunDir, "projections"), { recursive: true });
    await fs.writeFile(path.join(acpxRunDir, "projections", "run.json"), JSON.stringify({
      runId: "fake",
      flowName: "fake",
      flowPath: prepared.index.segments[0].materializedFlow,
      status: "completed",
      outputs: {
        review_files__item_1: { status: "completed", summary: "ok", artifacts: [], nextFocus: "reduce", verdict: "pass", severityCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, findings: [], checks: [] },
        review_files: { status: "completed", summary: "fanout", artifacts: [], nextFocus: "reduce", items: [] },
        reduce_findings: { status: "completed", summary: "reduce", artifacts: [], nextFocus: "summarize", verdict: "pass", severityCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, findings: [], checks: [] },
        summarize: { status: "completed", summary: "done", artifacts: [], nextFocus: "", finalVerdict: "success", deliverables: [], changedFiles: [], checks: [], warnings: [], risks: [], nextActions: [] }
      },
      steps: []
    }, null, 2), "utf8");
    const index = {
      ...prepared.index,
      status: "running" as const,
      segments: [{ ...prepared.index.segments[0], status: "running" as const, acpxRunDir }]
    };
    await writeRunIndex(temp, index);
    await syncRun(temp, prepared.logicalRunId, { startPending: false });
    await expect(fs.stat(path.join(prepared.dir, "outputs", "review_files", "review_files__item_1.json"))).resolves.toBeTruthy();
  });

  it("materializes pending fanout batch segment snapshots", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-orchestrator-batches-"));
    const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows/examples/review-only-fanout.workflow.spec.json"), "utf8")));
    const prepared = await prepareRun(spec, {
      cwd: temp,
      input: { task: "review", cwd: temp },
      sourcePath: "example"
    });
    const segments = await prepareFanoutBatchSegments({
      cwd: temp,
      logicalRunId: prepared.logicalRunId,
      spec,
      workflowInput: { task: "review", cwd: temp },
      fanoutStageId: "review_files",
      items: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }],
      preloadedOutputs: {
        discover_changed_files: { status: "completed", summary: "discovered", artifacts: [], nextFocus: "review", files: [{ path: "a.ts" }] }
      },
      batchSize: 2
    });
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      segmentId: "review_files-batch-1",
      purpose: "fanout-batch",
      fanoutStageId: "review_files",
      itemStart: 0,
      itemCount: 2
    });
    const input = JSON.parse(await fs.readFile(segments[0].input, "utf8"));
    expect(input.workflowInput.__fanoutBatchItems).toHaveLength(2);
    expect(input.runtime.preloadedOutputs.discover_changed_files.summary).toBe("discovered");
    await expect(fs.stat(segments[0].materializedFlow)).resolves.toBeTruthy();
  });

  it("syncs pre segment into fanout batches, aggregates them, and prepares continuation", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-orchestrator-scheduler-"));
    const base = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows/examples/review-only-fanout.workflow.spec.json"), "utf8")));
    const spec = WorkflowSpecSchema.parse({
      ...base,
      limits: { ...base.limits, maxConcurrency: 2, maxFanoutItems: 4 },
      stages: base.stages.map((stage) => stage.id === "review_files" ? { ...stage, limits: { maxConcurrency: 2 }, fanoutPolicy: { allowPartial: false } } : stage)
    });
    const prepared = await prepareRun(spec, {
      cwd: temp,
      input: { task: "review", cwd: temp },
      sourcePath: "example"
    });
    expect(prepared.index.segments.map((segment) => segment.segmentId)).toEqual(["pre-review_files"]);

    const preRunDir = path.join(temp, "fake-pre-run");
    await fs.mkdir(path.join(preRunDir, "projections"), { recursive: true });
    await fs.writeFile(path.join(preRunDir, "projections", "run.json"), JSON.stringify({
      runId: "pre",
      flowName: "pre",
      flowPath: prepared.index.segments[0].materializedFlow,
      status: "completed",
      outputs: {
        discover_changed_files: {
          status: "completed",
          summary: "discovered",
          artifacts: [],
          nextFocus: "review",
          files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }]
        }
      },
      steps: []
    }, null, 2), "utf8");
    await writeRunIndex(temp, {
      ...prepared.index,
      status: "running",
      segments: [{ ...prepared.index.segments[0], status: "running", acpxRunDir: preRunDir }]
    });
    const planned = await syncRun(temp, prepared.logicalRunId, { startPending: false });
    const batches = planned.segments.filter((segment) => segment.purpose === "fanout-batch");
    expect(batches).toHaveLength(2);
    expect(batches.map((segment) => segment.itemCount)).toEqual([2, 1]);

    const firstBatchInput = JSON.parse(await fs.readFile(batches[0].input, "utf8"));
    firstBatchInput.runtime.resumePolicy = { fanout: { review_files: { allowPartial: true } } };
    await fs.writeFile(batches[0].input, `${JSON.stringify(firstBatchInput, null, 2)}\n`, "utf8");

    const batchOutputs = [
      {
        review_files__item_1: completedValidation("a"),
        review_files__item_2: blockedValidation("b"),
        review_files: { status: "completed", summary: "batch 1", artifacts: [], nextFocus: "reduce", items: [] }
      },
      {
        review_files__item_1: completedValidation("c"),
        review_files: { status: "completed", summary: "batch 2", artifacts: [], nextFocus: "reduce", items: [] }
      }
    ];
    const nextSegments = [...planned.segments];
    for (let index = 0; index < batches.length; index += 1) {
      const runDir = path.join(temp, `fake-batch-${index + 1}`);
      await fs.mkdir(path.join(runDir, "projections"), { recursive: true });
      await fs.writeFile(path.join(runDir, "projections", "run.json"), JSON.stringify({
        runId: `batch-${index + 1}`,
        flowName: "batch",
        flowPath: batches[index].materializedFlow,
        status: "completed",
        outputs: batchOutputs[index],
        steps: []
      }, null, 2), "utf8");
      const segmentIndex = nextSegments.findIndex((segment) => segment.segmentId === batches[index].segmentId);
      nextSegments[segmentIndex] = { ...nextSegments[segmentIndex], status: "running", acpxRunDir: runDir };
    }
    await writeRunIndex(temp, { ...planned, status: "running", segments: nextSegments });
    const aggregated = await syncRun(temp, prepared.logicalRunId, { startPending: false });
    const aggregate = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "review_files.json"), "utf8"));
    expect(aggregate.status).toBe("completed");
    expect(aggregate.items).toHaveLength(3);
    expect(aggregate.blockedItems).toHaveLength(1);
    expect(await fs.readdir(path.join(prepared.dir, "outputs", "review_files"))).toContain("review_files__item_3.json");
    expect(aggregated.segments.some((segment) => segment.segmentId === "continuation" && segment.status === "pending")).toBe(true);
  });

  it("applies fanout resume policy while planning batches from a completed pre segment", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-orchestrator-scheduler-policy-"));
    const base = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows/examples/review-only-fanout.workflow.spec.json"), "utf8")));
    const spec = WorkflowSpecSchema.parse({
      ...base,
      limits: { ...base.limits, maxConcurrency: 2, maxFanoutItems: 4 },
      stages: base.stages.map((stage) => stage.id === "review_files" ? { ...stage, limits: { maxConcurrency: 2 } } : stage)
    });
    const prepared = await prepareRun(spec, {
      cwd: temp,
      input: { task: "review", cwd: temp },
      sourcePath: "example"
    });
    const preInput = JSON.parse(await fs.readFile(prepared.index.segments[0].input, "utf8"));
    preInput.runtime.resumePolicy = { fanout: { review_files: { maxItems: 2, skipItemIndexes: [1] } } };
    await fs.writeFile(prepared.index.segments[0].input, `${JSON.stringify(preInput, null, 2)}\n`, "utf8");

    const preRunDir = path.join(temp, "fake-pre-run");
    await fs.mkdir(path.join(preRunDir, "projections"), { recursive: true });
    await fs.writeFile(path.join(preRunDir, "projections", "run.json"), JSON.stringify({
      runId: "pre",
      flowName: "pre",
      flowPath: prepared.index.segments[0].materializedFlow,
      status: "completed",
      outputs: {
        discover_changed_files: {
          status: "completed",
          summary: "discovered",
          artifacts: [],
          nextFocus: "review",
          files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }]
        }
      },
      steps: []
    }, null, 2), "utf8");
    await writeRunIndex(temp, {
      ...prepared.index,
      status: "running",
      segments: [{ ...prepared.index.segments[0], status: "running", acpxRunDir: preRunDir }]
    });
    const planned = await syncRun(temp, prepared.logicalRunId, { startPending: false });
    const batches = planned.segments.filter((segment) => segment.purpose === "fanout-batch");
    expect(batches).toHaveLength(1);
    expect(batches[0].itemCount).toBe(1);
    const batchInput = JSON.parse(await fs.readFile(batches[0].input, "utf8"));
    expect(batchInput.workflowInput.__fanoutBatchItems).toEqual([{ path: "a.ts" }]);
  });

  it("handles root fanout with zero items by creating an empty aggregate and continuation", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-orchestrator-empty-root-fanout-"));
    const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows/examples/edit-fanout-reconcile.workflow.spec.json"), "utf8")));
    const prepared = await prepareRun(spec, {
      cwd: temp,
      input: { task: "edit", cwd: temp, items: [] },
      sourcePath: "example"
    });
    expect(prepared.index.segments).toEqual([]);
    const started = await startPreparedRun(temp, prepared);
    expect(started.status).toBe("running");
    const synced = await syncRun(temp, prepared.logicalRunId, { startPending: false });
    const aggregate = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "edit_items.json"), "utf8"));
    expect(aggregate.status).toBe("completed");
    expect(aggregate.items).toEqual([]);
    expect(synced.segments.some((segment) => segment.segmentId === "continuation" && segment.status === "pending")).toBe(true);
  });
});

function completedValidation(label: string) {
  return {
    status: "completed",
    summary: label,
    artifacts: [],
    nextFocus: "reduce",
    verdict: "pass",
    severityCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
    findings: [],
    checks: []
  };
}

function blockedValidation(label: string) {
  return {
    ...completedValidation(label),
    status: "blocked",
    blockedReason: "item blocked"
  };
}
