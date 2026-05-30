import { describe, expect, it } from "vitest";
import { formatRepairPrompt } from "../../src/runtime/repair.js";
import { parseWorkflowOutput } from "../../src/runtime/output-parser.js";

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

describe("runtime output parser", () => {
  it("accepts exact workflow-output fences and preserves metadata", () => {
    const parsed = parseWorkflowOutput(fenced("workflow-output", implementationOutput()), "implementation");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.outputParse).toMatchObject({
      mode: "workflowOutputFence",
      repaired: false,
      unwrapped: false,
      candidateCount: 1
    });
  });

  it("accepts json fences with a single workflow-output wrapper", () => {
    const parsed = parseWorkflowOutput(fenced("json", { "workflow-output": implementationOutput() }), "implementation");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.outputParse).toMatchObject({
      mode: "jsonFence",
      unwrapped: true,
      candidateCount: 1
    });
  });

  it("repairs JSON syntax before schema validation", () => {
    const raw = "```workflow-output\n{\"status\":\"completed\",\"summary\":\"ok\",\"artifacts\":[],\"nextFocus\":\"done\",\"changedFiles\":[\"a.ts\",],\"checks\":[]}\n```";
    const parsed = parseWorkflowOutput(raw, "implementation");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.outputParse.repaired).toBe(true);
  });

  it("normalizes only checks[].result to checks[].status", () => {
    const parsed = parseWorkflowOutput(fenced("workflow-output", implementationOutput({
      checks: [{ name: "unit", result: "pass" }]
    })), "implementation");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.checks).toEqual([{ name: "unit", status: "pass" }]);
    expect(parsed.outputParse.outputNormalizedAliases).toEqual(["checks[].result->checks[].status"]);
  });

  it("returns schema diagnostics for domain reports such as the 67-zhaopin shape", () => {
    const domainReport = {
      card: "67-zhaopin",
      path: "packages/tt-search/business/Lego/67-zhaopin",
      overall_result: "PASS"
    };
    const parsed = parseWorkflowOutput([
      "Here's the final workflow-output JSON:",
      fenced("json", { "workflow-output": domainReport }),
      fenced("json workflow-output", domainReport)
    ].join("\n"), "implementation");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_SCHEMA_FAILED");
    expect(parsed.diagnostics).toMatchObject({
      errorCode: "OUTPUT_SCHEMA_FAILED",
      candidateCount: 2,
      recoverability: "repairable"
    });
    expect(parsed.diagnostics.candidates.flatMap((candidate) => candidate.schemaErrors.map((error) => error.path))).toEqual(expect.arrayContaining(["/status", "/summary", "/artifacts", "/nextFocus", "/changedFiles", "/checks"]));
  });

  it("fails closed when multiple different valid candidates exist", () => {
    const parsed = parseWorkflowOutput([
      fenced("workflow-output", implementationOutput({ summary: "First" })),
      fenced("json", implementationOutput({ summary: "Second" }))
    ].join("\n"), "implementation");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_AMBIGUOUS");
  });

  it("formats schema-aware repair prompts", () => {
    const parsed = parseWorkflowOutput(fenced("json", { "workflow-output": { card: "67-zhaopin" } }), "implementation");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const prompt = formatRepairPrompt({ contractName: "implementation", failure: parsed });
    expect(prompt).toContain("Blocked reason: OUTPUT_SCHEMA_FAILED");
    expect(prompt).toContain("Canonical schema");
    expect(prompt).toContain("Minimal valid example");
    expect(prompt).toContain("/status");
    expect(prompt).toContain("checks[].result");
  });
});
