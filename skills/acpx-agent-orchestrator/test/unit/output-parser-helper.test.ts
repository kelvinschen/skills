import crypto from "node:crypto";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { outputParserHelperSource } from "../../src/compiler/output-parser-helper.js";

type ParserHarness = {
  extractWorkflowOutput: (text: string, contract: string, maxOutputChars: number | null, options?: Record<string, unknown>) => Record<string, unknown>;
  formatRepairPrompt: (output: Record<string, unknown>, contract: string) => string;
  isRepairableOutputFailure: (output: Record<string, unknown>) => boolean;
  markRepairResult: (output: Record<string, unknown>) => Record<string, unknown>;
};

function createHarness(): ParserHarness {
  const context: Record<string, unknown> = { crypto, path };
  vm.runInNewContext(`${outputParserHelperSource()}\nglobalThis.__parser = { extractWorkflowOutput, formatRepairPrompt, isRepairableOutputFailure, markRepairResult };`, context);
  return context.__parser as ParserHarness;
}

function implementationOutput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "completed",
    summary: "Implemented safely.",
    artifacts: [],
    nextFocus: "summarize",
    changedFiles: ["src/app.ts"],
    checks: [{ command: "npm test", status: "pass", summary: "ok" }],
    ...extra
  };
}

function fenced(tag: string, value: unknown): string {
  return `\`\`\`${tag}\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

describe("output parser helper", () => {
  it("accepts exact workflow-output fences and preserves metadata", () => {
    const helper = createHarness();
    const output = helper.extractWorkflowOutput(fenced("workflow-output", implementationOutput()), "implementation", null);

    expect(output.status).toBe("completed");
    expect(output.metadata).toMatchObject({
      outputParse: {
        mode: "workflowOutputFence",
        repaired: false,
        unwrapped: false,
        candidateCount: 1
      }
    });
  });

  it("accepts json fences with a single workflow-output wrapper", () => {
    const helper = createHarness();
    const output = helper.extractWorkflowOutput(fenced("json", { "workflow-output": implementationOutput() }), "implementation", null);

    expect(output.status).toBe("completed");
    expect(output.metadata).toMatchObject({
      outputParse: {
        mode: "jsonFence",
        unwrapped: true,
        candidateCount: 1
      }
    });
  });

  it("accepts malformed json workflow-output fence headers when the contract validates", () => {
    const helper = createHarness();
    const output = helper.extractWorkflowOutput(fenced("json workflow-output", implementationOutput()), "implementation", null);

    expect(output.status).toBe("completed");
    expect(output.metadata).toMatchObject({
      outputParse: {
        mode: "malformedFence",
        unwrapped: false
      }
    });
  });

  it("accepts a final trailing raw JSON object", () => {
    const helper = createHarness();
    const output = helper.extractWorkflowOutput(`Done.\n\n${JSON.stringify(implementationOutput())}`, "implementation", null);

    expect(output.status).toBe("completed");
    expect(output.metadata).toMatchObject({
      outputParse: {
        mode: "trailingRawJson",
        candidateCount: 1
      }
    });
  });

  it("returns schema diagnostics for domain reports such as the 67-zhaopin shape", () => {
    const helper = createHarness();
    const domainReport = {
      card: "67-zhaopin",
      path: "packages/tt-search/business/Lego/67-zhaopin",
      timestamp: "20260530_090752",
      steps: { "1_type_refactor": { status: "pass" } },
      overall_result: "PASS",
      artifacts_dir: "packages/tt-search/business/Lego/67-zhaopin/.type-fix-artifacts/20260530_090752"
    };
    const raw = [
      "Here's the final workflow-output JSON:",
      fenced("json", { "workflow-output": domainReport }),
      fenced("json workflow-output", domainReport)
    ].join("\n");

    const output = helper.extractWorkflowOutput(raw, "implementation", null);

    expect(output.status).toBe("blocked");
    expect(output.blockedReason).toBe("OUTPUT_SCHEMA_FAILED");
    expect(output.summary).not.toContain("Missing workflow-output");
    expect(output.parseDiagnostics).toMatchObject({
      errorCode: "OUTPUT_SCHEMA_FAILED",
      candidateCount: 2,
      recoverability: "repairable"
    });
    const diagnostics = output.parseDiagnostics as { candidates: Array<{ schemaErrors: Array<{ path: string }> }> };
    expect(diagnostics.candidates.flatMap((candidate) => candidate.schemaErrors.map((error) => error.path))).toEqual(expect.arrayContaining(["/status", "/summary", "/artifacts", "/nextFocus", "/changedFiles", "/checks"]));
  });

  it("fails closed when multiple different valid candidates exist", () => {
    const helper = createHarness();
    const raw = [
      fenced("workflow-output", implementationOutput({ summary: "First" })),
      fenced("json", implementationOutput({ summary: "Second" }))
    ].join("\n");

    const output = helper.extractWorkflowOutput(raw, "implementation", null);

    expect(output.status).toBe("blocked");
    expect(output.blockedReason).toBe("OUTPUT_AMBIGUOUS");
    expect(output.parseDiagnostics).toMatchObject({
      errorCode: "OUTPUT_AMBIGUOUS",
      candidateCount: 2,
      recoverability: "repairable"
    });
  });

  it("formats schema-aware repair prompts and marks failed repair results", () => {
    const helper = createHarness();
    const blocked = helper.extractWorkflowOutput(fenced("json", { "workflow-output": { card: "67-zhaopin" } }), "implementation", null);

    expect(helper.isRepairableOutputFailure(blocked)).toBe(true);
    const prompt = helper.formatRepairPrompt(blocked, "implementation");
    expect(prompt).toContain("Blocked reason: OUTPUT_SCHEMA_FAILED");
    expect(prompt).toContain("candidateCount: 1");
    expect(prompt).toContain("schemaError /status");

    const repaired = helper.markRepairResult(blocked);
    expect(repaired.blockedReason).toBe("OUTPUT_REPAIR_FAILED");
    expect(repaired.metadata).toMatchObject({ repairAttempts: 1 });
  });
});
