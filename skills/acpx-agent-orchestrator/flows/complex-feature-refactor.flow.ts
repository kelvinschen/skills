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
  maxFixRounds: 2;
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
  if (record.maxFixRounds !== undefined && record.maxFixRounds !== 2) {
    throw new Error("complex-feature-refactor.flow.ts requires maxFixRounds=2.");
  }
  return {
    task,
    cwd: typeof record.cwd === "string" && record.cwd.trim() ? record.cwd.trim() : process.cwd(),
    planAgent: profileAgent(AGENT_PROFILES.plan, "plan"),
    implAgent: profileAgent(AGENT_PROFILES.impl, "impl"),
    testAgent: profileAgent(AGENT_PROFILES.test, "test"),
    reviewAgent: profileAgent(AGENT_PROFILES.review, "review"),
    testHints: typeof record.testHints === "string" ? record.testHints.trim() : "",
    maxFixRounds: 2,
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

function finalReviewVerdict(text: unknown): "pass" | "needs_human_orchestrator_decision" | "unknown" {
  const value = String(text || "");
  if (/^\s*FINAL_VERDICT:\s*pass\s*$/im.test(value)) return "pass";
  if (/^\s*FINAL_VERDICT:\s*needs_human_orchestrator_decision\s*$/im.test(value)) {
    return "needs_human_orchestrator_decision";
  }
  return "unknown";
}

function finalStatusFrom(test: unknown, review: unknown, passStatus: string, finalRound: boolean): string {
  const testResult = testVerdict(test);
  const reviewResult = finalRound ? finalReviewVerdict(review) : reviewVerdict(review);
  if (testResult === "fail" || reviewResult === "fix" || reviewResult === "needs_human_orchestrator_decision") {
    return "needs_human_orchestrator_decision";
  }
  if (testResult === "pass" && reviewResult === "pass") {
    return passStatus;
  }
  return "unknown_needs_human_orchestrator_decision";
}

function testPrompt(round: number, implementationKey: "implement_1" | "implement_fix_1" | "implement_fix_2") {
  return ({ outputs }: { outputs: Record<string, unknown> }) => {
    const input = spec(outputs);
    return `You are the independent testing agent in a complex feature/refactor workflow.

Round: ${round}

Task:
${input.task}

Plan:
${String(outputs.plan || "")}

Plan review:
${String(outputs.plan_review || "")}

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

function reviewPrompt(
  round: number,
  implementationKey: "implement_1" | "implement_fix_1" | "implement_fix_2",
  testKey: "agent_test_1" | "agent_test_2" | "agent_test_3",
  finalRound: boolean,
) {
  return ({ outputs }: { outputs: Record<string, unknown> }) => {
    const input = spec(outputs);
    const verdictInstruction = finalRound
      ? `End with exactly one marker line:
FINAL_VERDICT: pass
or
FINAL_VERDICT: needs_human_orchestrator_decision`
      : `End with exactly one marker line:
REVIEW_VERDICT: pass
or
REVIEW_VERDICT: fix`;
    return `You are the review agent in a complex feature/refactor workflow.

Round: ${round}

Task:
${input.task}

Plan:
${String(outputs.plan || "")}

Plan review:
${String(outputs.plan_review || "")}

Implementation summary:
${String(outputs[implementationKey] || "")}

Independent test result:
${String(outputs[testKey] || "")}

Review the current working tree for bugs, regressions, missing tests, scope drift, and refactor safety. Do not edit files. Findings must include severity markers P0/P1/P2/P3 and concrete file references when possible.

Return findings first. If there are no blocking findings, say that clearly and mention residual risk.

${verdictInstruction}`;
  };
}

export default defineFlow({
  name: "complex-feature-refactor",
  run: {
    title: ({ input }) => {
      const task = typeof (input as FlowInput)?.task === "string" ? (input as FlowInput).task?.trim() : "";
      return task ? `Complex feature/refactor: ${task.slice(0, 80)}` : "Complex feature/refactor";
    },
  },
  startAt: "normalize_input",
  nodes: {
    normalize_input: compute({
      statusDetail: "Normalizing complex feature/refactor input",
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
      timeoutMs: 20 * 60 * 1000,
      statusDetail: "Planning complex feature/refactor",
      prompt: ({ outputs }) => {
        const input = spec(outputs);
        return `You are the planning agent in a complex feature/refactor workflow.

Task:
${input.task}

Working directory:
${input.cwd}

Create a detailed but concise implementation plan. Do not edit files. Include intended behavior, affected areas, migration/refactor constraints, implementation phases, risks, rollback considerations, and verification strategy.`;
      },
      parse: trimText,
    }),
    plan_review: acp({
      profile: AGENT_PROFILES.review,
      session: { handle: "plan_review" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 20 * 60 * 1000,
      statusDetail: "Reviewing complex plan",
      prompt: ({ outputs }) => {
        const input = spec(outputs);
        return `You are the plan review agent in a complex feature/refactor workflow.

Task:
${input.task}

Proposed plan:
${String(outputs.plan || "")}

Review the plan before implementation. Do not edit files. Identify missing constraints, high-risk areas, edge cases, test strategy gaps, and any sequencing changes needed. Return a concise amended guidance section that the implementation agent should follow.`;
      },
      parse: trimText,
    }),
    implement_1: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 90 * 60 * 1000,
      statusDetail: "Implementing complex feature/refactor",
      prompt: ({ outputs }) => {
        const input = spec(outputs);
        return `You are the implementation agent in a complex feature/refactor workflow.

Task:
${input.task}

Accepted plan:
${String(outputs.plan || "")}

Plan review guidance:
${String(outputs.plan_review || "")}

Implement the task in the working directory. Do not revert unrelated user changes. Keep the change scoped to the task and plan. Run relevant checks when feasible, then summarize exactly what changed and what you verified.`;
      },
      parse: trimText,
    }),
    agent_test_1: acp({
      profile: AGENT_PROFILES.test,
      session: { handle: "test_1" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 30 * 60 * 1000,
      statusDetail: "Independently testing complex feature/refactor round 1",
      prompt: testPrompt(1, "implement_1"),
      parse: trimText,
    }),
    review_1: acp({
      profile: AGENT_PROFILES.review,
      session: { handle: "review_1" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 20 * 60 * 1000,
      statusDetail: "Reviewing complex feature/refactor round 1",
      prompt: reviewPrompt(1, "implement_1", "agent_test_1", false),
      parse: trimText,
    }),
    decide_1: decision({
      profile: AGENT_PROFILES.review,
      session: { handle: "decide_1" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 5 * 60 * 1000,
      statusDetail: "Deciding whether complex workflow needs fix round 1",
      choices: DECISION_CHOICES,
      question: ({ outputs }) => `Decide whether the complex feature/refactor workflow should pass or run fix round 1.

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
      timeoutMs: 90 * 60 * 1000,
      statusDetail: "Applying complex fix round 1",
      prompt: ({ outputs }) => {
        const input = spec(outputs);
        return `You are the implementation agent applying fix round 1 in a complex feature/refactor workflow.

Task:
${input.task}

Original plan:
${String(outputs.plan || "")}

Plan review guidance:
${String(outputs.plan_review || "")}

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
      timeoutMs: 30 * 60 * 1000,
      statusDetail: "Independently testing complex fix round 1",
      prompt: testPrompt(2, "implement_fix_1"),
      parse: trimText,
    }),
    review_2: acp({
      profile: AGENT_PROFILES.review,
      session: { handle: "review_2" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 20 * 60 * 1000,
      statusDetail: "Reviewing complex fix round 1",
      prompt: reviewPrompt(2, "implement_fix_1", "agent_test_2", false),
      parse: trimText,
    }),
    decide_2: decision({
      profile: AGENT_PROFILES.review,
      session: { handle: "decide_2" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 5 * 60 * 1000,
      statusDetail: "Deciding whether complex workflow needs final fix round",
      choices: DECISION_CHOICES,
      question: ({ outputs }) => `Decide whether the complex feature/refactor workflow should pass or run the final fix round.

Rules:
- If the independent test contains TEST_VERDICT: fail, choose fix.
- If review contains REVIEW_VERDICT: fix, P0, P1, P2, or explicit needs changes, choose fix.
- Otherwise choose pass.
- This is the last decision point. If you choose fix, the flow will run one final fix/test/review pass and then stop for orchestrator review.

Independent test:
${String(outputs.agent_test_2 || "")}

Review:
${String(outputs.review_2 || "")}

Return only JSON with route and reason.`,
    }),
    implement_fix_2: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 90 * 60 * 1000,
      statusDetail: "Applying final complex fix round",
      prompt: ({ outputs }) => {
        const input = spec(outputs);
        return `You are the implementation agent applying the final automatic fix round in a complex feature/refactor workflow.

Task:
${input.task}

Original plan:
${String(outputs.plan || "")}

Plan review guidance:
${String(outputs.plan_review || "")}

Previous implementation summaries:
Round 1:
${String(outputs.implement_1 || "")}

Fix round 1:
${String(outputs.implement_fix_1 || "")}

Latest independent test result:
${String(outputs.agent_test_2 || "")}

Earlier independent test result:
${String(outputs.agent_test_1 || "")}

Latest review findings:
${String(outputs.review_2 || "")}

Decision:
${JSON.stringify(outputs.decide_2 || {}, null, 2)}

Fix only the issues identified above. This is the final automatic fix round. Do not do unrelated refactors and do not revert unrelated user changes. Run relevant checks when feasible, then summarize exactly what changed and what you verified.`;
      },
      parse: trimText,
    }),
    agent_test_3: acp({
      profile: AGENT_PROFILES.test,
      session: { handle: "test_3" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 30 * 60 * 1000,
      statusDetail: "Independently testing final complex fix round",
      prompt: testPrompt(3, "implement_fix_2"),
      parse: trimText,
    }),
    review_3: acp({
      profile: AGENT_PROFILES.review,
      session: { handle: "review_3" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 20 * 60 * 1000,
      statusDetail: "Reviewing final complex fix round",
      prompt: reviewPrompt(3, "implement_fix_2", "agent_test_3", true),
      parse: trimText,
    }),
    summarize: compute({
      statusDetail: "Summarizing complex feature/refactor result",
      run: ({ outputs, state }) => {
        const input = spec(outputs);
        const decision1 = routeOf(outputs.decide_1);
        const decision2 = routeOf(outputs.decide_2);
        const fixRoundsUsed = decision1 === "fix" ? (decision2 === "fix" ? 2 : 1) : 0;
        const finalTest = fixRoundsUsed === 2
          ? outputs.agent_test_3
          : fixRoundsUsed === 1
            ? outputs.agent_test_2
            : outputs.agent_test_1;
        const finalReview = fixRoundsUsed === 2
          ? outputs.review_3
          : fixRoundsUsed === 1
            ? outputs.review_2
            : outputs.review_1;
        const finalStatus = finalStatusFrom(
          finalTest,
          finalReview,
          fixRoundsUsed === 2 ? "passed_after_fix_round_2" : fixRoundsUsed === 1 ? "passed_after_fix_round_1" : "passed_without_fix",
          fixRoundsUsed === 2,
        );
        return {
          task: input.task,
          cwd: input.cwd,
          template: "complex-feature-refactor",
          agents: {
            plan: input.planAgent,
            implement: input.implAgent,
            test: input.testAgent,
            review: input.reviewAgent,
          },
          maxFixRounds: input.maxFixRounds,
          fixRoundsUsed,
          finalStatus,
          finalTestVerdict: testVerdict(finalTest),
          finalReviewVerdict: fixRoundsUsed === 2 ? finalReviewVerdict(finalReview) : reviewVerdict(finalReview),
          plan: outputs.plan,
          planReview: outputs.plan_review,
          firstPass: {
            implementation: outputs.implement_1,
            test: outputs.agent_test_1,
            review: outputs.review_1,
            decision: outputs.decide_1,
          },
          fixPass1: fixRoundsUsed >= 1 ? {
            implementation: outputs.implement_fix_1,
            test: outputs.agent_test_2,
            review: outputs.review_2,
            decision: outputs.decide_2,
          } : null,
          fixPass2: fixRoundsUsed >= 2 ? {
            implementation: outputs.implement_fix_2,
            test: outputs.agent_test_3,
            review: outputs.review_3,
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
    { from: "plan", to: "plan_review" },
    { from: "plan_review", to: "implement_1" },
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
    { from: "review_2", to: "decide_2" },
    decisionEdge({
      from: "decide_2",
      choices: DECISION_CHOICES,
      cases: {
        pass: "summarize",
        fix: "implement_fix_2",
      },
    }),
    { from: "implement_fix_2", to: "agent_test_3" },
    { from: "agent_test_3", to: "review_3" },
    { from: "review_3", to: "summarize" },
  ],
});
