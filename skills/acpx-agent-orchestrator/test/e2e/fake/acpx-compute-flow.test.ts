import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareRun } from "../../../src/runtime/run-workflow.js";
import { WorkflowSpecSchema } from "../../../src/schema/workflow-spec.js";

function findAcpx(): string | undefined {
  try {
    return execFileSync("zsh", ["-lc", "command -v acpx"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

const maybeIt = findAcpx() ? it : it.skip;

describe("deterministic acpx flow contract", () => {
  maybeIt("executes a compute-only segment and produces structured blocked output", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-orchestrator-contract-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpx-orchestrator.workflow/v1",
      name: "compute-contract",
      root: "discover",
      inputs: {
        cwd: { type: "path", default: cwd }
      },
      roles: {
        summarizer: { category: "summarization", agent: "claude", mode: "readOnly" }
      },
      limits: {
        maxAgents: 2,
        maxConcurrency: 1,
        maxFanoutItems: 1,
        maxFixRounds: 0,
        stageTimeoutMinutes: 1
      },
      stages: [
        { id: "discover", kind: "discover", method: "glob", args: { scope: ["**/*.txt"] }, output: "files" },
        {
          id: "gate",
          kind: "decisionGate",
          mode: "program",
          dependsOn: ["discover"],
          rules: [{ when: { source: "outputs.discover.files", op: "exists" }, to: "blocked" }],
          default: "blocked"
        },
        {
          id: "summarize",
          kind: "summarize",
          role: "summarizer",
          dependsOn: ["gate"],
          variables: [{ name: "summary", source: "outputs.gate.summary" }],
          prompt: "Summarize ${summary}"
        }
      ]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });
    const acpx = findAcpx();
    expect(acpx).toBeTruthy();
    const raw = execFileSync(acpx!, [
      "--format",
      "json",
      "--timeout",
      "60",
      "flow",
      "run",
      prepared.index.segments[0].materializedFlow,
      "--input-file",
      prepared.index.segments[0].input
    ], { encoding: "utf8" });
    const result = JSON.parse(raw);
    expect(result.status).toBe("completed");
    expect(result.outputs.discover.files).toHaveLength(1);
    expect(result.outputs.__blocked_stop.status).toBe("blocked");
  });
});
