import { acp, compute, defineFlow, shell } from "acpx/flows";

type FlowInput = {
  task?: string;
  cwd?: string;
  implAgent?: string;
  testAgent?: string;
  testHints?: string;
  maxFixRounds?: number;
};

const AGENT_PROFILES = {
  impl: "trae",
  test: "aiden",
} as const;

type NormalizedInput = {
  task: string;
  cwd: string;
  implAgent: string;
  testAgent: string;
  testHints: string;
  maxFixRounds: 0;
};

function profileAgent(profile: string, field: string): string {
  if (!profile.trim()) {
    throw new Error(`Flow profile \`${field}\` must be a non-empty string.`);
  }
  return profile.trim();
}

function normalizeInput(input: unknown): NormalizedInput {
  const record = input && typeof input === "object" ? (input as FlowInput) : {};
  const task = typeof record.task === "string" ? record.task.trim() : "";
  if (!task) {
    throw new Error("Input field `task` is required.");
  }
  if (record.maxFixRounds !== undefined && record.maxFixRounds !== 0) {
    throw new Error("quick-bugfix.flow.ts requires maxFixRounds=0.");
  }
  return {
    task,
    cwd: typeof record.cwd === "string" && record.cwd.trim() ? record.cwd.trim() : process.cwd(),
    implAgent: profileAgent(AGENT_PROFILES.impl, "impl"),
    testAgent: profileAgent(AGENT_PROFILES.test, "test"),
    testHints: typeof record.testHints === "string" ? record.testHints.trim() : "",
    maxFixRounds: 0,
  };
}

function spec(outputs: Record<string, unknown>): NormalizedInput {
  const value = outputs.normalize_input;
  if (!value || typeof value !== "object") {
    throw new Error("normalize_input output missing");
  }
  return value as NormalizedInput;
}

function trimText(text: string): string {
  return text.trim();
}

function testVerdict(text: unknown): "pass" | "fail" | "unknown" {
  const value = String(text || "");
  if (/^\s*TEST_VERDICT:\s*fail\s*$/im.test(value)) return "fail";
  if (/^\s*TEST_VERDICT:\s*pass\s*$/im.test(value)) return "pass";
  return "unknown";
}

export default defineFlow({
  name: "quick-bugfix",
  run: {
    title: ({ input }) => {
      const task = typeof (input as FlowInput)?.task === "string" ? (input as FlowInput).task?.trim() : "";
      return task ? `Quick bugfix: ${task.slice(0, 80)}` : "Quick bugfix";
    },
  },
  startAt: "normalize_input",
  nodes: {
    normalize_input: compute({
      statusDetail: "Normalizing quick bugfix input",
      run: ({ input }) => normalizeInput(input),
    }),
    prepare_workspace: shell({
      statusDetail: "Ensuring target working directory exists",
      exec: ({ outputs }) => ({
        command: "mkdir",
        args: ["-p", spec(outputs).cwd],
      }),
      parse: (result) => ({
        cwd: result.cwd,
        exitCode: result.exitCode,
      }),
    }),
    implement: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 60 * 60 * 1000,
      statusDetail: "Applying quick bugfix",
      prompt: ({ outputs }) => {
        const input = spec(outputs);
        return `You are the implementation agent in a quick bugfix workflow.

Task:
${input.task}

Working directory:
${input.cwd}

Fix the bug with the smallest safe scoped change. Do not revert unrelated user changes. Run relevant checks when feasible, then summarize exactly what changed and what you verified.`;
      },
      parse: trimText,
    }),
    agent_test: acp({
      profile: AGENT_PROFILES.test,
      session: { handle: "test" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 40 * 60 * 1000,
      statusDetail: "Independently testing quick bugfix",
      prompt: ({ outputs }) => {
        const input = spec(outputs);
        return `You are the independent testing agent in a quick bugfix workflow.

Task:
${input.task}

Implementation summary:
${String(outputs.implement || "")}

User-provided test hints:
${input.testHints || "(none)"}

Do not accept the implementation agent's testing claims as sufficient evidence. Inspect the workspace, run black-box or regression checks, and create temporary test scripts or fixtures if useful. You have permission to run commands and create test artifacts, but do not make unrelated production code changes. If you must modify test files or fixtures, say exactly what you changed.

Return:
- commands/actions run
- pass/fail verdict
- observed output
- suspected cause if failed
- residual risk

End with exactly one marker line:
TEST_VERDICT: pass
or
TEST_VERDICT: fail`;
      },
      parse: trimText,
    }),
    summarize: compute({
      statusDetail: "Summarizing quick bugfix result",
      run: ({ outputs, state }) => {
        const input = spec(outputs);
        const verdict = testVerdict(outputs.agent_test);
        return {
          task: input.task,
          cwd: input.cwd,
          template: "quick-bugfix",
          agents: {
            implement: input.implAgent,
            test: input.testAgent,
          },
          maxFixRounds: input.maxFixRounds,
          implementation: outputs.implement,
          test: outputs.agent_test,
          testVerdict: verdict,
          testFailed: verdict === "fail",
          recommendation: verdict === "fail"
            ? "Test agent reported failure. The orchestrator should inspect artifacts and decide whether to run a higher-complexity self-healing flow or issue a focused follow-up fix."
            : verdict === "pass"
              ? "Test agent reported pass. The orchestrator should still inspect final diff before reporting completion."
              : "Test agent did not emit a parseable TEST_VERDICT marker. The orchestrator should inspect the test output before reporting completion.",
          flowRunId: state.runId,
          artifactHint: `~/.acpx/flows/runs/${state.runId}/`,
        };
      },
    }),
  },
  edges: [
    { from: "normalize_input", to: "prepare_workspace" },
    { from: "prepare_workspace", to: "implement" },
    { from: "implement", to: "agent_test" },
    { from: "agent_test", to: "summarize" },
  ],
});
