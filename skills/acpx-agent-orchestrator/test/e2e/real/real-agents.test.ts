import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const runReal = process.env.RUN_REAL_ACPX_E2E === "1";

function findAcpxOrSkip(): string {
  try {
    return execFileSync("zsh", ["-lc", "command -v acpx"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("RUN_REAL_ACPX_E2E=1 requires acpx on PATH");
  }
}

describe.skipIf(!runReal)("real acpx agents e2e", () => {
  it("runs a deterministic blocked contract through the CLI and real acpx", async () => {
    const acpx = findAcpxOrSkip();
    expect(acpx).toBeTruthy();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-orchestrator-real-contract-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const specPath = path.join(cwd, "workflow.spec.json");
    await fs.writeFile(specPath, JSON.stringify({
      schemaVersion: "acpx-orchestrator.workflow/v1",
      name: "real-deterministic-contract",
      root: "discover",
      inputs: {
        cwd: { type: "path", default: cwd }
      },
      roles: {
        summarizer: { category: "summarization", agent: "aiden", mode: "readOnly" }
      },
      limits: { maxAgents: 2, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 1 },
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
    }, null, 2), "utf8");

    const raw = execFileSync(tsxPath(), [cliPath(), "run", "--spec", specPath, "--yes", "--wait", "--json"], {
      cwd,
      encoding: "utf8",
      timeout: 2 * 60 * 1000,
      env: { ...process.env, PATH: `${path.dirname(acpx)}:${process.env.PATH ?? ""}` }
    });
    const result = JSON.parse(raw);
    expect(result.status).toBe("blocked");
    expect(result.runView.status).toBe("blocked");
    await expect(fs.stat(path.join(result.runDir, "outputs", "discover.json"))).resolves.toBeTruthy();
  }, 3 * 60 * 1000);

  it("runs a small code task through real configured agents", async () => {
    const acpx = findAcpxOrSkip();
    expect(acpx).toBeTruthy();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-orchestrator-real-"));
    await fs.mkdir(path.join(cwd, "src"));
    await fs.writeFile(path.join(cwd, "src", "status.txt"), "initial\n", "utf8");
    const specPath = path.join(cwd, "workflow.spec.json");
    const inputPath = path.join(cwd, "input.json");
    await fs.writeFile(specPath, JSON.stringify({
      schemaVersion: "acpx-orchestrator.workflow/v1",
      name: "real-small-code-task",
      root: "plan",
      inputs: {
        task: { type: "string", default: "" },
        cwd: { type: "path", default: cwd }
      },
      roles: {
        planner: { category: "planning", agent: "aiden", mode: "readOnly" },
        implementer: { category: "implementation", agent: "trae", mode: "edit" },
        validator: { category: "validation", agent: "aiden", mode: "readOnly" },
        summarizer: { category: "summarization", agent: "aiden", mode: "readOnly" }
      },
      limits: { maxAgents: 8, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 20 },
      stages: [
        {
          id: "plan",
          kind: "agentTask",
          role: "planner",
          variables: [{ name: "task", source: "input.task" }],
          prompt: "Plan the smallest safe change for this task in the current repo. Task: ${task}"
        },
        {
          id: "implement",
          kind: "agentTask",
          role: "implementer",
          dependsOn: ["plan"],
          variables: [{ name: "task", source: "input.task" }, { name: "plan", source: "outputs.plan.summary" }],
          prompt: "Implement only this small task. Task: ${task}\n\nPlan:\n${plan}"
        },
        {
          id: "validate",
          kind: "agentTask",
          role: "validator",
          dependsOn: ["implement"],
          variables: [{ name: "task", source: "input.task" }, { name: "implementation", source: "outputs.implement.summary" }],
          prompt: "Validate the implementation. Task: ${task}\n\nImplementation:\n${implementation}"
        },
        {
          id: "summarize",
          kind: "summarize",
          role: "summarizer",
          dependsOn: ["validate"],
          variables: [{ name: "validation", source: "outputs.validate.summary" }],
          prompt: "Summarize the run outcome.\n\nValidation:\n${validation}"
        }
      ]
    }, null, 2), "utf8");
    await fs.writeFile(inputPath, JSON.stringify({
      cwd,
      task: "Edit src/status.txt so it contains exactly the line: done"
    }, null, 2), "utf8");

    const raw = execFileSync(tsxPath(), [cliPath(), "run", "--spec", specPath, "--input-json", inputPath, "--yes", "--wait", "--json"], {
      cwd,
      encoding: "utf8",
      timeout: 30 * 60 * 1000,
      env: { ...process.env, PATH: `${path.dirname(acpx)}:${process.env.PATH ?? ""}` }
    });
    const result = JSON.parse(raw);
    expect(["completed", "blocked", "diagnosed_blocked"]).toContain(result.status);
    expect(await fs.readFile(path.join(cwd, "src", "status.txt"), "utf8")).toContain("done");
  }, 35 * 60 * 1000);
});

function cliPath(): string {
  return path.resolve(__dirname, "..", "..", "..", "src", "cli.ts");
}

function tsxPath(): string {
  return path.resolve(__dirname, "..", "..", "..", "node_modules", ".bin", "tsx");
}
