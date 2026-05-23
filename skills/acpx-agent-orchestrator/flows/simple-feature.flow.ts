import { acp, compute, decision, decisionEdge, defineFlow, shell } from "acpx/flows";

type FlowInput = {
  task?: string;
  cwd?: string;
  planAgent?: string;
  implAgent?: string;
  testAgent?: string;
  reviewAgent?: string;
  testHints?: string;
  maxFixRounds?: number;
};

const AGENT_PROFILES = {
  plan: "aiden",
  impl: "trae",
  test: "aiden",
  review: "aiden",
} as const;

type NormalizedInput = {
  task: string;
  cwd: string;
  planAgent: string;
  implAgent: string;
  testAgent: string;
  reviewAgent: string;
  testHints: string;
  maxFixRounds: 1;
};

const DECISION_CHOICES = ["pass", "fix"] as const;

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
  if (record.maxFixRounds !== undefined && record.maxFixRounds !== 1) {
    throw new Error("simple-feature.flow.ts requires maxFixRounds=1.");
  }
  return {
    task,
    cwd: typeof record.cwd === "string" && record.cwd.trim() ? record.cwd.trim() : process.cwd(),
    planAgent: profileAgent(AGENT_PROFILES.plan, "plan"),
    implAgent: profileAgent(AGENT_PROFILES.impl, "impl"),
    testAgent: profileAgent(AGENT_PROFILES.test, "test"),
    reviewAgent: profileAgent(AGENT_PROFILES.review, "review"),
    testHints: typeof record.testHints === "string" ? record.testHints.trim() : "",
    maxFixRounds: 1,
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

function routeOf(value: unknown): string {
  if (value && typeof value === "object" && "route" in value) {
    return String((value as { route?: unknown }).route || "");
  }
  return "";
}

function testVerdict(text: unknown): "pass" | "fail" | "unknown" {
  const value = String(text || "");
  if (/^\s*TEST_VERDICT:\s*fail\s*$/im.test(value)) return "fail";
  if (/^\s*TEST_VERDICT:\s*pass\s*$/im.test(value)) return "pass";
  return "unknown";
}

function reviewVerdict(text: unknown): "pass" | "fix" | "unknown" {
  const value = String(text || "");
  if (/^\s*REVIEW_VERDICT:\s*fix\s*$/im.test(value)) return "fix";
  if (/^\s*REVIEW_VERDICT:\s*pass\s*$/im.test(value)) return "pass";
  return "unknown";
}

function finalStatusFrom(test: unknown, review: unknown, passStatus: string): string {
  const testResult = testVerdict(test);
  const reviewResult = reviewVerdict(review);
  if (testResult === "fail" || reviewResult === "fix") {
    return "needs_human_orchestrator_decision";
  }
  if (testResult === "pass" && reviewResult === "pass") {
    return passStatus;
  }
  return "unknown_needs_human_orchestrator_decision";
}

function testPrompt(round: number, implementationKey: "implement_1" | "implement_fix_1") {
  return ({ outputs }: { outputs: Record<string, unknown> }) => {
    const input = spec(outputs);
    return `You are the independent testing agent in a simple feature workflow.

Round: ${round}

Task:
${input.task}

Plan:
${String(outputs.plan || "")}

Implementation summary:
${String(outputs[implementationKey] || "")}

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
  };
}

function reviewPrompt(round: number, implementationKey: "implement_1" | "implement_fix_1", testKey: "agent_test_1" | "agent_test_2") {
  return ({ outputs }: { outputs: Record<string, unknown> }) => {
    const input = spec(outputs);
    return `You are the review agent in a simple feature workflow.

Round: ${round}

Task:
${input.task}

Plan:
${String(outputs.plan || "")}

Implementation summary:
${String(outputs[implementationKey] || "")}

Independent test result:
${String(outputs[testKey] || "")}

Review the current working tree for bugs, regressions, missing tests, and scope drift. Do not edit files. Findings must include severity markers P0/P1/P2/P3 and concrete file references when possible.

Return findings first. If there are no blocking findings, say that clearly and mention residual risk.

End with exactly one marker line:
REVIEW_VERDICT: pass
or
REVIEW_VERDICT: fix`;
  };
}

export default defineFlow({
  name: "simple-feature",
  run: {
    title: ({ input }) => {
      const task = typeof (input as FlowInput)?.task === "string" ? (input as FlowInput).task?.trim() : "";
      return task ? `Simple feature: ${task.slice(0, 80)}` : "Simple feature";
    },
  },
  startAt: "normalize_input",
  nodes: {
    normalize_input: compute({
      statusDetail: "Normalizing simple feature input",
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
    plan: acp({
      profile: AGENT_PROFILES.plan,
      session: { handle: "plan" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      statusDetail: "Planning simple feature",
      prompt: ({ outputs }) => {
        const input = spec(outputs);
        return `You are the planning agent in a simple feature workflow.

Task:
${input.task}

Working directory:
${input.cwd}

Create a concise implementation plan. Do not edit files. Include intended behavior, likely files, implementation steps, risks, and verification strategy.`;
      },
      parse: trimText,
    }),
    implement_1: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 60 * 60 * 1000,
      statusDetail: "Implementing simple feature",
      prompt: ({ outputs }) => {
        const input = spec(outputs);
        return `You are the implementation agent in a simple feature workflow.

Task:
${input.task}

Accepted plan:
${String(outputs.plan || "")}

Implement the task in the working directory. Do not revert unrelated user changes. Keep the change scoped. Run relevant checks when feasible, then summarize exactly what changed and what you verified.`;
      },
      parse: trimText,
    }),
    agent_test_1: acp({
      profile: AGENT_PROFILES.test,
      session: { handle: "test_1" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 40 * 60 * 1000,
      statusDetail: "Independently testing simple feature round 1",
      prompt: testPrompt(1, "implement_1"),
      parse: trimText,
    }),
    review_1: acp({
      profile: AGENT_PROFILES.review,
      session: { handle: "review_1" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 40 * 60 * 1000,
      statusDetail: "Reviewing simple feature round 1",
      prompt: reviewPrompt(1, "implement_1", "agent_test_1"),
      parse: trimText,
    }),
    decide_1: decision({
      profile: AGENT_PROFILES.review,
      session: { handle: "decide_1" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      statusDetail: "Deciding whether simple feature needs one fix round",
      choices: DECISION_CHOICES,
      question: ({ outputs }) => `Decide whether the simple feature workflow should pass or run one fix round.

Rules:
- If the independent test contains TEST_VERDICT: fail, choose fix.
- If review contains REVIEW_VERDICT: fix, P0, P1, P2, or explicit needs changes, choose fix.
- Otherwise choose pass.

Independent test:
${String(outputs.agent_test_1 || "")}

Review:
${String(outputs.review_1 || "")}

Return only JSON with route and reason.`,
    }),
    implement_fix_1: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 60 * 60 * 1000,
      statusDetail: "Applying simple feature fix round 1",
      prompt: ({ outputs }) => {
        const input = spec(outputs);
        return `You are the implementation agent applying the only automatic fix round in a simple feature workflow.

Task:
${input.task}

Original plan:
${String(outputs.plan || "")}

Previous implementation summary:
${String(outputs.implement_1 || "")}

Independent test result:
${String(outputs.agent_test_1 || "")}

Review findings:
${String(outputs.review_1 || "")}

Decision:
${JSON.stringify(outputs.decide_1 || {}, null, 2)}

Fix only the issues identified above. Do not do unrelated refactors and do not revert unrelated user changes. Run relevant checks when feasible, then summarize exactly what changed and what you verified.`;
      },
      parse: trimText,
    }),
    agent_test_2: acp({
      profile: AGENT_PROFILES.test,
      session: { handle: "test_2" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 40 * 60 * 1000,
      statusDetail: "Independently testing simple feature fix round",
      prompt: testPrompt(2, "implement_fix_1"),
      parse: trimText,
    }),
    review_2: acp({
      profile: AGENT_PROFILES.review,
      session: { handle: "review_2" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 40 * 60 * 1000,
      statusDetail: "Reviewing simple feature fix round",
      prompt: reviewPrompt(2, "implement_fix_1", "agent_test_2"),
      parse: trimText,
    }),
    summarize: compute({
      statusDetail: "Summarizing simple feature result",
      run: ({ outputs, state }) => {
        const input = spec(outputs);
        const usedFixRound = routeOf(outputs.decide_1) === "fix";
        const finalTest = usedFixRound ? outputs.agent_test_2 : outputs.agent_test_1;
        const finalReview = usedFixRound ? outputs.review_2 : outputs.review_1;
        return {
          task: input.task,
          cwd: input.cwd,
          template: "simple-feature",
          agents: {
            plan: input.planAgent,
            implement: input.implAgent,
            test: input.testAgent,
            review: input.reviewAgent,
          },
          maxFixRounds: input.maxFixRounds,
          fixRoundsUsed: usedFixRound ? 1 : 0,
          finalStatus: finalStatusFrom(finalTest, finalReview, usedFixRound ? "passed_after_fix_round" : "passed_without_fix"),
          finalTestVerdict: testVerdict(finalTest),
          finalReviewVerdict: reviewVerdict(finalReview),
          plan: outputs.plan,
          implementation: usedFixRound ? outputs.implement_fix_1 : outputs.implement_1,
          firstPass: {
            implementation: outputs.implement_1,
            test: outputs.agent_test_1,
            review: outputs.review_1,
            decision: outputs.decide_1,
          },
          fixPass: usedFixRound ? {
            implementation: outputs.implement_fix_1,
            test: outputs.agent_test_2,
            review: outputs.review_2,
          } : null,
          flowRunId: state.runId,
          artifactHint: `~/.acpx/flows/runs/${state.runId}/`,
        };
      },
    }),
  },
  edges: [
    { from: "normalize_input", to: "prepare_workspace" },
    { from: "prepare_workspace", to: "plan" },
    { from: "plan", to: "implement_1" },
    { from: "implement_1", to: "agent_test_1" },
    { from: "agent_test_1", to: "review_1" },
    { from: "review_1", to: "decide_1" },
    decisionEdge({
      from: "decide_1",
      choices: DECISION_CHOICES,
      cases: {
        pass: "summarize",
        fix: "implement_fix_1",
      },
    }),
    { from: "implement_fix_1", to: "agent_test_2" },
    { from: "agent_test_2", to: "review_2" },
    { from: "review_2", to: "summarize" },
  ],
});
