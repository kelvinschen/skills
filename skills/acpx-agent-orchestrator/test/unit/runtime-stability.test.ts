import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcpRuntimeEvent, AcpRuntimeHandle } from "acpx/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { buildRunReportView } from "../../src/projections/run-report.js";
import { runDir } from "../../src/run-index/paths.js";
import { appendEvent, readRunIndex, RuntimeErrorCodes, writeRunIndex } from "../../src/run-index/read-write.js";
import { setAgentRuntimeFactoryForTests, type AgentTurnRequest, type AgentTurnResult, type OrchestratorAgentRuntime } from "../../src/runtime/agent-runtime.js";
import { startDiagnosticRun } from "../../src/runtime/diagnose-run.js";
import { prepareRun, startPreparedRun } from "../../src/runtime/run-workflow.js";
import { syncRun } from "../../src/runtime/sync.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../../src/schema/workflow-spec.js";
import { baseOutput, summarizeOutput, workflowOutput } from "../helpers/fake-runtime.js";

describe("fanout runtime stability", () => {
  afterEach(() => setAgentRuntimeFactoryForTests(undefined));

  it("serializes concurrent event appends without leaking lock contention", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-event-queue-"));
    const logicalRunId = "event-queue";

    await Promise.all(Array.from({ length: 50 }, (_, index) =>
      appendEvent(cwd, logicalRunId, { type: "probe", sequence: index })
    ));

    const text = await fs.readFile(path.join(runDir(logicalRunId, cwd), "events.ndjson"), "utf8");
    const events = text.trim().split("\n").map((line) => JSON.parse(line) as { sequence: number });
    expect(events).toHaveLength(50);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(50);
    expect(text).not.toContain("Lock file is already being held");
  });

  it("converts one thrown fanout item into an item-level blocked result", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-isolation-"));
    const runtime = new SelectiveFanoutRuntime("item-2");
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = fanoutSpec(3, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }, { id: "item-2" }, { id: "item-3" }] }
    });

    const index = await startPreparedRun(cwd, prepared);
    const stage = index.stages.fanout;
    const itemStatuses = stage?.fanout?.items.map((item) => [item.id, item.status, item.errorCode]);
    const failedOutput = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "fanout", "item-2.json"), "utf8")) as { blockedReason: string };
    const events = await fs.readFile(path.join(prepared.dir, "events.ndjson"), "utf8");

    expect(index.status).toBe("blocked");
    expect(itemStatuses).toEqual([
      ["item-1", "completed", undefined],
      ["item-2", "blocked", RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR],
      ["item-3", "completed", undefined]
    ]);
    expect(failedOutput.blockedReason).toBe(RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR);
    expect(stage?.fanout?.completedItems).toBe(2);
    expect(stage?.fanout?.blockedItems).toBe(1);
    expect(events).toContain("scheduler_batch_completed");
  });

  it("recovers a running fanout item when its output file already exists", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-recover-"));
    const spec = fanoutSpec(1, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }] }
    });
    const staleStartedAt = new Date(Date.now() - 60_000).toISOString();
    const outputPath = path.join(prepared.dir, "outputs", "fanout", "item-1.json");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(baseOutput({ summary: "already done" }), null, 2)}\n`, "utf8");
    await writeRunIndex(cwd, {
      ...prepared.index,
      status: "running",
      stages: {
        ...prepared.index.stages,
        fanout: {
          stageId: "fanout",
          status: "running",
          attempts: [],
          startedAt: staleStartedAt,
          fanout: {
            totalItems: 1,
            completedItems: 0,
            blockedItems: 0,
            allowPartial: false,
            items: [{ id: "item-1", index: 0, status: "running", startedAt: staleStartedAt, attemptId: "fanout:item-1:attempt-1" }]
          }
        }
      }
    });

    const recovered = await syncRun(cwd, prepared.logicalRunId, { startPending: false });
    const item = recovered.stages.fanout?.fanout?.items[0];

    expect(recovered.status).toBe("completed");
    expect(item).toMatchObject({
      id: "item-1",
      status: "completed",
      outputPath: path.join("outputs", "fanout", "item-1.json")
    });
    await expect(fs.stat(path.join(prepared.dir, "outputs", "fanout.json"))).resolves.toBeTruthy();
  });

  it("preserves cancelled turn diagnostics in output and attempt index", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cancelled-turn-"));
    setAgentRuntimeFactoryForTests(() => new CancelledRuntime());
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpx-orchestrator.workflow/v1",
      name: "cancelled-turn",
      root: "task",
      inputs: { cwd: { type: "path", default: cwd } },
      roles: { worker: { category: "coordination", agent: "fake", mode: "readOnly" } },
      limits: { maxAgents: 1, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 1 },
      stages: [{ id: "task", kind: "agentTask", role: "worker", prompt: "Do work" }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "task.json"), "utf8")) as { runtimeDiagnostics: Record<string, unknown> };
    const persisted = await readRunIndex(cwd, prepared.logicalRunId);
    const attempt = persisted.attempts["task:attempt-1"];

    expect(index.status).toBe("blocked");
    expect(output.runtimeDiagnostics).toMatchObject({
      stopReason: "cancelled",
      requestId: "task:attempt-1",
      sessionKey: "role:worker",
      agent: "fake",
      roleMode: "readOnly",
      runtimeDisposeInvoked: false,
      rawTextPreview: "partial cancelled text"
    });
    expect(attempt).toMatchObject({
      stopReason: "cancelled",
      requestId: "task:attempt-1",
      sessionKey: "role:worker",
      runtimeErrorCode: "AGENT_TURN_CANCELLED"
    });
  });

  it("surfaces item runtime errors in detailed report diagnostics", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-report-"));
    setAgentRuntimeFactoryForTests(() => new SelectiveFanoutRuntime("item-2"));
    const spec = fanoutSpec(2, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }, { id: "item-2" }] }
    });
    const index = await startPreparedRun(cwd, prepared);

    const report = await buildRunReportView(cwd, spec, index, { mode: "snapshot" });
    const fanout = report.stages.find((stage) => stage.id === "fanout")?.fanout;

    expect(fanout?.items.find((item) => item.id === "item-2")).toMatchObject({
      status: "blocked",
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR
    });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      stageId: "fanout",
      itemId: "item-2"
    }));
  });

  it("records a run-level blocked reason when the final verdict is unknown", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-final-verdict-"));
    setAgentRuntimeFactoryForTests(() => new FinalVerdictRuntime("unknown"));
    const spec = summarizeSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);
    const report = await buildRunReportView(cwd, spec, index, { mode: "snapshot" });

    expect(index.status).toBe("blocked");
    expect(index.blockedReason).toBe(RuntimeErrorCodes.FINAL_VERDICT_UNKNOWN);
    expect(report.run.blockedReason).toBe(RuntimeErrorCodes.FINAL_VERDICT_UNKNOWN);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FINAL_VERDICT_UNKNOWN,
      stageId: undefined,
      itemId: undefined
    }));
  });

  it("applies persisted resume policy when re-aggregating blocked fanout", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-resume-policy-"));
    setAgentRuntimeFactoryForTests(() => new SelectiveFanoutRuntime("item-2"));
    const spec = fanoutSpec(3, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }, { id: "item-2" }, { id: "item-3" }] }
    });
    const blocked = await startPreparedRun(cwd, prepared);

    await writeRunIndex(cwd, {
      ...blocked,
      status: "running",
      blockedReason: undefined,
      resumePolicy: { fanout: { fanout: { allowPartial: true } } },
      stages: {
        ...blocked.stages,
        fanout: {
          ...blocked.stages.fanout,
          status: "running",
          blockedReason: undefined,
          completedAt: undefined
        }
      }
    });

    const resumed = await syncRun(cwd, prepared.logicalRunId);

    expect(resumed.status).toBe("completed");
    expect(resumed.stages.fanout?.status).toBe("completed");
    expect(resumed.stages.fanout?.fanout).toMatchObject({
      totalItems: 3,
      completedItems: 2,
      blockedItems: 1,
      allowPartial: true
    });
  });

  it("preserves diagnosed_blocked status during observation-only sync", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-diagnosed-sync-"));
    setAgentRuntimeFactoryForTests(() => new SelectiveFanoutRuntime("item-2"));
    const spec = fanoutSpec(2, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }, { id: "item-2" }] }
    });
    await startPreparedRun(cwd, prepared);

    const diagnosed = await startDiagnosticRun(cwd, prepared.logicalRunId);
    const observed = await syncRun(cwd, prepared.logicalRunId, { startPending: false });

    expect(diagnosed.status).toBe("diagnosed_blocked");
    expect(observed.status).toBe("diagnosed_blocked");
  });

  it("terminates ready work as blocked when the agent budget is exhausted", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-agent-budget-"));
    setAgentRuntimeFactoryForTests(() => new StaticRuntime());
    const spec = budgetSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const firstTick = await startPreparedRun(cwd, prepared);
    const secondTick = await syncRun(cwd, prepared.logicalRunId);
    const report = await buildRunReportView(cwd, spec, secondTick, { mode: "snapshot" });

    expect(firstTick.status).toBe("running");
    expect(secondTick.status).toBe("blocked");
    expect(secondTick.blockedReason).toBe(RuntimeErrorCodes.LIMIT_AGENT_BUDGET_EXHAUSTED);
    expect(secondTick.stages.validate).toMatchObject({
      status: "blocked",
      blockedReason: RuntimeErrorCodes.LIMIT_AGENT_BUDGET_EXHAUSTED
    });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.LIMIT_AGENT_BUDGET_EXHAUSTED,
      stageId: undefined,
      itemId: undefined
    }));
  });
});

function fanoutSpec(count: number, policy: { allowPartial: boolean }): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-orchestrator.workflow/v1",
    name: "fanout-stability",
    root: "fanout",
    inputs: {
      cwd: { type: "path" },
      items: { type: "array<json>" }
    },
    roles: { worker: { category: "coordination", agent: "fake", mode: "readOnly" } },
    limits: { maxAgents: count, maxConcurrency: count, maxFanoutItems: count, maxFixRounds: 0, stageTimeoutMinutes: 1 },
    stages: [{
      id: "fanout",
      kind: "fanout",
      items: { source: "input.items" },
      role: "worker",
      prompt: "Handle one item",
      fanoutPolicy: policy
    }]
  });
}

function summarizeSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-orchestrator.workflow/v1",
    name: "final-verdict",
    root: "summarize",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: { summarizer: { category: "summarization", agent: "fake", mode: "readOnly" } },
    limits: { maxAgents: 1, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 1 },
    stages: [{ id: "summarize", kind: "summarize", role: "summarizer", prompt: "Summarize" }]
  });
}

function budgetSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-orchestrator.workflow/v1",
    name: "agent-budget",
    root: "plan",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      worker: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { maxAgents: 1, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 1 },
    stages: [
      { id: "plan", kind: "agentTask", role: "worker", prompt: "Plan" },
      { id: "validate", kind: "agentTask", role: "worker", dependsOn: ["plan"], prompt: "Validate" }
    ]
  });
}

class SelectiveFanoutRuntime implements OrchestratorAgentRuntime {
  readonly requests: AgentTurnRequest[] = [];

  constructor(private readonly failingItemId: string) {}

  async runTurn(input: AgentTurnRequest, onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void): Promise<AgentTurnResult> {
    this.requests.push(input);
    if (input.sessionKey.includes(`item:${this.failingItemId}`)) {
      throw new Error("backend queue rejected item turn");
    }
    const rawText = workflowOutput(baseOutput({ summary: input.sessionKey }));
    const event: AcpRuntimeEvent = { type: "text_delta", text: rawText, stream: "output" };
    await onEvent?.(event);
    return {
      handle: fakeHandle(input),
      rawText,
      events: [event],
      status: "completed"
    };
  }
}

class CancelledRuntime implements OrchestratorAgentRuntime {
  async runTurn(input: AgentTurnRequest): Promise<AgentTurnResult> {
    return {
      handle: fakeHandle(input),
      rawText: "partial cancelled text",
      events: [],
      status: "cancelled",
      stopReason: "cancelled"
    };
  }
}

class FinalVerdictRuntime implements OrchestratorAgentRuntime {
  constructor(private readonly verdict: "blocked" | "failed" | "unknown") {}

  async runTurn(input: AgentTurnRequest, onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void): Promise<AgentTurnResult> {
    const rawText = workflowOutput(summarizeOutput({ finalVerdict: this.verdict }));
    const event: AcpRuntimeEvent = { type: "text_delta", text: rawText, stream: "output" };
    await onEvent?.(event);
    return {
      handle: fakeHandle(input),
      rawText,
      events: [event],
      status: "completed"
    };
  }
}

class StaticRuntime implements OrchestratorAgentRuntime {
  async runTurn(input: AgentTurnRequest, onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void): Promise<AgentTurnResult> {
    const rawText = workflowOutput(baseOutput({ summary: input.sessionKey }));
    const event: AcpRuntimeEvent = { type: "text_delta", text: rawText, stream: "output" };
    await onEvent?.(event);
    return {
      handle: fakeHandle(input),
      rawText,
      events: [event],
      status: "completed"
    };
  }
}

function fakeHandle(input: AgentTurnRequest): AcpRuntimeHandle {
  return {
    sessionKey: input.sessionKey,
    backend: "fake",
    runtimeSessionName: input.sessionKey,
    cwd: input.cwd,
    acpxRecordId: `record-${input.sessionKey}`,
    backendSessionId: `backend-${input.sessionKey}`,
    agentSessionId: `agent-${input.sessionKey}`
  };
}
