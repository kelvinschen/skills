import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileFanoutBatchSegment, compileWorkflow } from "../../src/compiler/compile.js";
import { WorkflowSpecSchema } from "../../src/schema/workflow-spec.js";

describe("compileWorkflow", () => {
  it("materializes a self-contained acpx flow snapshot", () => {
    const spec = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/simple-feature.workflow.spec.json"), "utf8")));
    const compiled = compileWorkflow(spec);
    expect(compiled.flowSource).toContain("defineFlow");
    expect(compiled.flowSource).toContain("extractWorkflowOutput");
    expect(compiled.flowSource).toContain("collectWorkflowOutputCandidates");
    expect(compiled.flowSource).toContain("OUTPUT_SCHEMA_FAILED");
    expect(compiled.flowSource).toContain("OUTPUT_AMBIGUOUS");
    expect(compiled.flowSource).toContain("formatRepairPrompt");
    expect(compiled.flowSource).toContain("isRepairableOutputFailure(output)");
    expect(compiled.flowSource).toContain("markRepairResult(repaired)");
    expect(compiled.flowSource).toContain('"plan__repair"');
    expect(compiled.flowSource).toContain('"plan"');
    expect(compiled.flowSource).toContain('"summarize"');
    expect(compiled.stageOrder).toEqual(["plan", "implement", "validate", "summarize"]);
  });

  it("compiles fanout as a single-outgoing switch chain with blockedStop", () => {
    const spec = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/review-only-fanout.workflow.spec.json"), "utf8")));
    const compiled = compileWorkflow(spec);
    expect(compiled.flowSource).toContain('"review_files__gate_1"');
    expect(compiled.flowSource).toContain('switch: { on: "$.route"');
    expect(compiled.flowSource).toContain('"run":"review_files__item_1__agent"');
    expect(compiled.flowSource).toContain("resumePolicy");
    expect(compiled.flowSource).toContain('"skip":"review_files__gate_2"');
    expect(compiled.flowSource).toContain('"done":"review_files"');
    expect(compiled.flowSource).toContain('"__blocked_stop"');
  });

  it("normalizes invalid decision routes to blocked before switching", () => {
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpx-orchestrator.workflow/v1",
      name: "decision-normalize",
      root: "gate",
      inputs: { task: { type: "string", default: "" } },
      roles: {
        decider: { category: "coordination", agent: "aiden", mode: "readOnly" },
        summarizer: { category: "summarization", agent: "claude", mode: "readOnly" }
      },
      limits: { maxAgents: 4 },
      stages: [
        {
          id: "gate",
          kind: "decisionGate",
          mode: "agent",
          role: "decider",
          variables: [{ name: "task", source: "input.task" }],
          prompt: "Choose route for ${task}",
          rules: [{ when: { source: "outputs.gate.route", op: "eq", value: "summarize" }, to: "summarize" }],
          default: "blocked"
        },
        {
          id: "summarize",
          kind: "summarize",
          role: "summarizer",
          dependsOn: ["gate"],
          variables: [{ name: "route", source: "outputs.gate.route" }],
          prompt: "Summarize ${route}"
        }
      ]
    });
    const compiled = compileWorkflow(spec);
    expect(compiled.flowSource).toContain('"gate__normalize_route"');
    expect(compiled.flowSource).toContain('"blocked":"__blocked_stop"');
    expect(compiled.flowSource).toContain("decision output requires route string");
  });

  it("compiles all built-in program reducer operations", () => {
    const base = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/review-only-fanout.workflow.spec.json"), "utf8")));
    for (const operation of ["mergeArrays", "severitySummary", "dedupeFindings", "sortBySeverity"] as const) {
      const spec = WorkflowSpecSchema.parse({
        ...base,
        limits: { ...base.limits, maxAgents: 26 },
        stages: base.stages.map((stage) => stage.id === "reduce_findings"
          ? { id: "reduce_findings", kind: "reduce", mode: "program", from: "review_files", dependsOn: ["review_files"], operation }
          : stage)
      });
      const compiled = compileWorkflow(spec);
      const marker = {
        mergeArrays: "Merged ",
        severitySummary: "severitySummary",
        dedupeFindings: "dedupeFindings",
        sortBySeverity: "Sorted "
      }[operation];
      expect(compiled.flowSource).toContain(marker);
    }
  });

  it("compiles workflow slices that read preloaded upstream outputs", () => {
    const spec = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/review-only-fanout.workflow.spec.json"), "utf8")));
    const compiled = compileWorkflow(spec, {
      stageIds: ["reduce_findings", "summarize"],
      startStageId: "reduce_findings",
      nameSuffix: "__after_review_files"
    });
    expect(compiled.stageOrder).toEqual(["reduce_findings", "summarize"]);
    expect(compiled.flowSource).toContain('name: "review-only-fanout__after_review_files"');
    expect(compiled.flowSource).toContain('startAt: "reduce_findings__agent"');
    expect(compiled.flowSource).toContain("preloadedOutputs");
    expect(compiled.flowSource).not.toContain('"discover_changed_files"');
    expect(compiled.flowSource).not.toContain('"review_files__gate_1"');
  });

  it("compiles program decisions against preloaded outputs", () => {
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpx-orchestrator.workflow/v1",
      name: "decision-slice",
      root: "gate",
      inputs: {},
      roles: {
        summarizer: { category: "summarization", agent: "claude", mode: "readOnly" }
      },
      limits: { maxAgents: 2 },
      stages: [
        {
          id: "gate",
          kind: "decisionGate",
          mode: "program",
          rules: [{ when: { source: "outputs.previous.verdict", op: "eq", value: "pass" }, to: "summarize" }],
          default: "blocked"
        },
        {
          id: "summarize",
          kind: "summarize",
          role: "summarizer",
          dependsOn: ["gate"],
          variables: [{ name: "verdict", source: "outputs.previous.verdict" }],
          prompt: "Verdict ${verdict}"
        }
      ]
    });
    const compiled = compileWorkflow(spec);
    expect(compiled.flowSource).toContain("evaluate(rule.when, outputs, input)");
    expect(compiled.flowSource).toContain("preloadedOutputs");
  });

  it("compiles a standalone fanout batch segment", () => {
    const spec = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/review-only-fanout.workflow.spec.json"), "utf8")));
    const compiled = compileFanoutBatchSegment(spec, "review_files", 2);
    expect(compiled.fanoutStageId).toBe("review_files");
    expect(compiled.batchInputKey).toBe("__fanoutBatchItems");
    expect(compiled.batchSize).toBe(2);
    expect(compiled.stageOrder).toEqual(["review_files"]);
    expect(compiled.flowSource).toContain('name: "review-only-fanout__review_files_batch"');
    expect(compiled.flowSource).toContain('"review_files__gate_1"');
    expect(compiled.flowSource).toContain('"review_files__gate_2"');
    expect(compiled.flowSource).toContain("input.__fanoutBatchItems");
    expect(compiled.flowSource).not.toContain('"discover_changed_files"');
    expect(compiled.flowSource).not.toContain('"reduce_findings"');
  });

  it("compiles fixLoop routes so pass skips fixer and final fix blocks", () => {
    const spec = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/bugfix-fixloop.workflow.spec.json"), "utf8")));
    const compiled = compileWorkflow(spec);
    expect(compiled.flowSource).toContain('"quality_loop__validate_1"');
    expect(compiled.flowSource).toContain('"quality_loop__route_1"');
    expect(compiled.flowSource).toContain('"completed":"quality_loop__validate_1__agent"');
    expect(compiled.flowSource).toContain('"pass":"quality_loop"');
    expect(compiled.flowSource).toContain('"fix":"quality_loop__fix_1__agent"');
    expect(compiled.flowSource).toContain('"completed":"quality_loop__validate_2__agent"');
    expect(compiled.flowSource).toContain('"fix":"__blocked_stop"');
  });
});
