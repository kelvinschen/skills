import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { acp, compute, decision, decisionEdge, defineFlow, shell } from "acpx/flows";
import {
  handoffPrompt,
  independentTestingGuidance,
  reviewGuidance,
  reviewVerdictMarkerPrompt,
  testVerdictMarkerPrompt,
} from "./shared/prompt-templates";

type FlowInput = {
  task?: string;
  cwd?: string;
  planAgent?: string;
  implAgent?: string;
  testAgent?: string;
  reviewAgent?: string;
  testHints?: string;
  handoffDir?: string;
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
  handoffDir: string;
  maxFixRounds: 1;
};

type FlowContext = {
  outputs: Record<string, unknown>;
  state: {
    runId: string;
  };
};

type SeverityCounts = {
  P0: number;
  P1: number;
  P2: number;
  P3: number;
};

type HandoffRef = {
  node: string;
  responseText: string;
  handoffPath?: string;
  summaryPreview: string;
  nextFocus: string;
  rawChars: number;
  verdict?: string;
  severityCounts?: SeverityCounts;
};

type HandoffSummary = Omit<HandoffRef, "responseText"> & {
  responsePreview: string;
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
  const cwd = typeof record.cwd === "string" && record.cwd.trim() ? record.cwd.trim() : process.cwd();
  return {
    task,
    cwd,
    planAgent: profileAgent(AGENT_PROFILES.plan, "plan"),
    implAgent: profileAgent(AGENT_PROFILES.impl, "impl"),
    testAgent: profileAgent(AGENT_PROFILES.test, "test"),
    reviewAgent: profileAgent(AGENT_PROFILES.review, "review"),
    testHints: typeof record.testHints === "string" ? record.testHints.trim() : "",
    handoffDir: normalizeHandoffDir(record.handoffDir, cwd),
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

function repoRoot(cwd: string): string {
  try {
    const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root || cwd;
  } catch {
    return cwd;
  }
}

function normalizeHandoffDir(value: unknown, cwd: string): string {
  if (typeof value === "string" && value.trim()) {
    const raw = value.trim();
    return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  }
  return path.join(repoRoot(cwd), "tmp", "flow_handoffs");
}

function handoffRoot(outputs: Record<string, unknown>, state: { runId: string }): string {
  return path.join(spec(outputs).handoffDir, state.runId);
}

function expectedHandoffPath(outputs: Record<string, unknown>, state: { runId: string }, node: string): string {
  return path.join(handoffRoot(outputs, state), `${node.replace(/[^a-z0-9_-]/gi, "_")}.md`);
}

function compactText(text: string, maxChars = 1800): string {
  const value = text.trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n... [truncated; inspect the flow run or handoff file for full detail]`;
}

function nextFocus(text: string): string {
  const match = text.match(/(?:next focus|next steps?|handoff)\s*:?\s*([\s\S]{1,800})/i);
  return compactText(match?.[1] || text, 600);
}

function testVerdictText(text: string): "pass" | "fail" | "unknown" {
  if (/^\s*TEST_VERDICT:\s*fail\s*$/im.test(text)) return "fail";
  if (/^\s*TEST_VERDICT:\s*pass\s*$/im.test(text)) return "pass";
  if (/\b(typecheck|tests?|unit tests?|checks?)\b[^\n]*(failed|failing|failure|error)/i.test(text)) return "fail";
  if (/\b(all\s+)?(tests?|unit tests?|checks?)\b[^\n]*(pass(ed|ing)?|clean|green)/i.test(text)) return "pass";
  if (/\btypecheck:\s*clean\b/i.test(text)) return "pass";
  return "unknown";
}

function reviewVerdictText(text: string): "pass" | "fix" | "unknown" {
  if (/^\s*REVIEW_VERDICT:\s*fix\s*$/im.test(text)) return "fix";
  if (/^\s*REVIEW_VERDICT:\s*pass\s*$/im.test(text)) return "pass";
  if (/\b(no blocking findings|no must-fix findings|looks good|approved)\b/i.test(text)) return "pass";
  if (/\bno\s+P0\b/i.test(text) && /\bno\s+P1\b/i.test(text)) return "pass";
  const severity = parseSeverityCounts(text);
  if (severity.P0 > 0) return "fix";
  return "unknown";
}

function asHandoff(value: unknown): HandoffRef | null {
  if (value && typeof value === "object" && "responseText" in value) {
    return value as HandoffRef;
  }
  return null;
}

function markerValue(text: string, marker: string): string {
  const match = text.match(new RegExp(`^\\s*${marker}:\\s*(.+?)\\s*$`, "im"));
  return match?.[1]?.trim() || "";
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseSeverityCounts(text: string): SeverityCounts {
  const marker = markerValue(text, "SEVERITY_COUNTS");
  const inlineCounts = marker || (/\bP[0-3]\s*=\s*\d+\b/i.test(text) ? text : "");
  if (inlineCounts) {
    return {
      P0: Number(inlineCounts.match(/\bP0\s*=\s*(\d+)/i)?.[1] || 0),
      P1: Number(inlineCounts.match(/\bP1\s*=\s*(\d+)/i)?.[1] || 0),
      P2: Number(inlineCounts.match(/\bP2\s*=\s*(\d+)/i)?.[1] || 0),
      P3: Number(inlineCounts.match(/\bP3\s*=\s*(\d+)/i)?.[1] || 0),
    };
  }
  if (!marker) {
    return {
      P0: Array.from(text.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?\[?\s*P0\b(?=\s*[:\]-])/gi)).length,
      P1: Array.from(text.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?\[?\s*P1\b(?=\s*[:\]-])/gi)).length,
      P2: Array.from(text.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?\[?\s*P2\b(?=\s*[:\]-])/gi)).length,
      P3: Array.from(text.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?\[?\s*P3\b(?=\s*[:\]-])/gi)).length,
    };
  }
  return { P0: 0, P1: 0, P2: 0, P3: 0 };
}

function inferHandoffPath(text: string, context: FlowContext): string | undefined {
  const root = handoffRoot(context.outputs, context.state);
  const input = spec(context.outputs);
  const candidates = [
    markerValue(text, "HANDOFF_PATH"),
    ...Array.from(text.matchAll(/(?:^|[\s:])((?:~|\.{1,2}|\/)?[^\s`'")]*tmp\/flow_handoffs\/[^\s`'")]+\.md)/g), (match) => match[1]),
  ].filter(Boolean);
  const bases = Array.from(new Set([input.cwd, repoRoot(input.cwd), input.handoffDir, root]));
  for (const rawCandidate of candidates) {
    const raw = rawCandidate.replace(/^["'`]+|["'`.,;:]+$/g, "");
    const resolvedCandidates = path.isAbsolute(raw)
      ? [raw]
      : bases.map((base) => path.resolve(base, raw));
    const accepted = resolvedCandidates.find((candidate) => isWithin(root, candidate));
    if (accepted) return accepted;
  }
  return undefined;
}

function parseHandoff(node: string, text: string, context: FlowContext, options: {
  verdict?: string;
  includeSeverity?: boolean;
} = {}): HandoffRef {
  const responseText = text.trim();
  const summary = markerValue(text, "HANDOFF_SUMMARY") || responseText;
  return {
    node,
    responseText,
    handoffPath: inferHandoffPath(text, context),
    summaryPreview: compactText(summary),
    nextFocus: nextFocus(summary),
    rawChars: responseText.length,
    verdict: options.verdict,
    severityCounts: options.includeSeverity ? parseSeverityCounts(text) : undefined,
  };
}

function handoffInstructions(outputs: Record<string, unknown>, state: { runId: string }, node: string, focus: string, extraMarkers = ""): string {
  const targetPath = expectedHandoffPath(outputs, state, node);
  return handoffPrompt({
    targetPath,
    nextFocus: focus,
    extraMarkers,
  });
}

function handoffBlock(items: Array<[string, unknown]>): string {
  return items.map(([label, value]) => {
    const ref = asHandoff(value);
    if (!ref) return `${label}: (missing)`;
    const severity = ref.severityCounts
      ? `\n- severity: P0=${ref.severityCounts.P0} P1=${ref.severityCounts.P1} P2=${ref.severityCounts.P2} P3=${ref.severityCounts.P3}`
      : "";
    return `${label}:
- handoff: ${ref.handoffPath || "(not specified; use the agent response below)"}
- verdict: ${ref.verdict || "n/a"}${severity}
- agent response:
${ref.responseText || "(empty)"}`;
  }).join("\n\n");
}

function handoffSummary(value: unknown): HandoffSummary | null {
  const ref = asHandoff(value);
  if (!ref) return null;
  return {
    node: ref.node,
    handoffPath: ref.handoffPath,
    summaryPreview: ref.summaryPreview,
    responsePreview: compactText(ref.responseText),
    nextFocus: ref.nextFocus,
    rawChars: ref.rawChars,
    verdict: ref.verdict,
    severityCounts: ref.severityCounts,
  };
}

function handoffIndex(outputs: Record<string, unknown>, keys: string[]): Record<string, HandoffSummary> {
  const index: Record<string, HandoffSummary> = {};
  for (const key of keys) {
    const ref = handoffSummary(outputs[key]);
    if (ref) index[key] = ref;
  }
  return index;
}

function routeOf(value: unknown): string {
  if (value && typeof value === "object" && "route" in value) {
    return String((value as { route?: unknown }).route || "");
  }
  return "";
}

function testVerdict(text: unknown): "pass" | "fail" | "unknown" {
  const ref = asHandoff(text);
  if (ref?.verdict === "pass" || ref?.verdict === "fail") return ref.verdict;
  return testVerdictText(String(text || ""));
}

function reviewVerdict(text: unknown): "pass" | "fix" | "unknown" {
  const ref = asHandoff(text);
  if (ref?.verdict === "pass" || ref?.verdict === "fix") return ref.verdict;
  return reviewVerdictText(String(text || ""));
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
  return ({ outputs, state }: { outputs: Record<string, unknown>; state: { runId: string } }) => {
    const input = spec(outputs);
    const node = round === 1 ? "agent_test_1" : "agent_test_2";
    return `You are the independent testing agent in a simple feature workflow.

Round: ${round}

Task:
${input.task}

Plan reference:
${handoffBlock([["Plan", outputs.plan]])}

Implementation summary:
${handoffBlock([["Implementation", outputs[implementationKey]]])}

User-provided test hints:
${input.testHints || "(none)"}

${independentTestingGuidance()}

${testVerdictMarkerPrompt()}

${handoffInstructions(outputs, state, node, "review of test evidence and current implementation", "\nTEST_VERDICT: pass|fail")}`;
  };
}

function reviewPrompt(round: number, implementationKey: "implement_1" | "implement_fix_1", testKey: "agent_test_1" | "agent_test_2") {
  return ({ outputs, state }: { outputs: Record<string, unknown>; state: { runId: string } }) => {
    const input = spec(outputs);
    const node = round === 1 ? "review_1" : "review_2";
    return `You are the review agent in a simple feature workflow.

Round: ${round}

Task:
${input.task}

Plan reference:
${handoffBlock([["Plan", outputs.plan]])}

Implementation summary:
${handoffBlock([["Implementation", outputs[implementationKey]]])}

Independent test result:
${handoffBlock([["Independent test", outputs[testKey]]])}

${reviewGuidance()}

${reviewVerdictMarkerPrompt()}

${handoffInstructions(outputs, state, node, "decision on whether a fix round is needed", "\nREVIEW_VERDICT: pass|fix\nSEVERITY_COUNTS: P0=0 P1=0 P2=0 P3=0")}`;
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
      timeoutMs: 20 * 60 * 1000,
      statusDetail: "Planning simple feature",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `You are the planning agent in a simple feature workflow.

Task:
${input.task}

Working directory:
${input.cwd}

Create a concise implementation plan. Do not edit files. Include intended behavior, likely files, implementation steps, risks, and verification strategy.

${handoffInstructions(outputs, state, "plan", "implementation using the accepted plan")}`;
      },
      parse: (text, context) => parseHandoff("plan", text, context),
    }),
    implement_1: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 60 * 60 * 1000,
      statusDetail: "Implementing simple feature",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `You are the implementation agent in a simple feature workflow.

Task:
${input.task}

Accepted plan reference:
${handoffBlock([["Plan", outputs.plan]])}

Implement the task in the working directory. Do not revert unrelated user changes. Keep the change scoped. Run relevant checks when feasible.

${handoffInstructions(outputs, state, "implement_1", "independent testing of the implementation")}`;
      },
      parse: (text, context) => parseHandoff("implement_1", text, context),
    }),
    agent_test_1: acp({
      profile: AGENT_PROFILES.test,
      session: { handle: "test_1" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 30 * 60 * 1000,
      statusDetail: "Independently testing simple feature round 1",
      prompt: testPrompt(1, "implement_1"),
      parse: (text, context) => parseHandoff("agent_test_1", text, context, {
        verdict: testVerdictText(text),
      }),
    }),
    review_1: acp({
      profile: AGENT_PROFILES.review,
      session: { handle: "review_1" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 20 * 60 * 1000,
      statusDetail: "Reviewing simple feature round 1",
      prompt: reviewPrompt(1, "implement_1", "agent_test_1"),
      parse: (text, context) => parseHandoff("review_1", text, context, {
        verdict: reviewVerdictText(text),
        includeSeverity: true,
      }),
    }),
    decide_1: decision({
      profile: AGENT_PROFILES.review,
      session: { handle: "decide_1" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 5 * 60 * 1000,
      statusDetail: "Deciding whether simple feature needs one fix round",
      choices: DECISION_CHOICES,
      question: ({ outputs }) => `Decide whether the simple feature workflow should pass or run one fix round.

Rules:
- If the independent test contains TEST_VERDICT: fail, choose fix.
- If review contains a true P0, choose fix unless you explicitly identify it as a false-positive severity label.
- If review contains REVIEW_VERDICT: fix or a P1 that should be fixed in this flow, choose fix.
- P2 and P3 findings are reference material only and must not alone trigger fix.
- Otherwise choose pass.

Parsed independent test verdict: ${testVerdict(outputs.agent_test_1)}
Independent test reference:
${handoffBlock([["Independent test", outputs.agent_test_1]])}

Parsed review verdict: ${reviewVerdict(outputs.review_1)}
Review reference:
${handoffBlock([["Review", outputs.review_1]])}

Return only JSON with route and reason.`,
    }),
    implement_fix_1: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 60 * 60 * 1000,
      statusDetail: "Applying simple feature fix round 1",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `You are the implementation agent applying the only automatic fix round in a simple feature workflow.

Task:
${input.task}

Original plan reference:
${handoffBlock([["Plan", outputs.plan]])}

Previous implementation summary:
${handoffBlock([["Previous implementation", outputs.implement_1]])}

Independent test result:
${handoffBlock([["Independent test", outputs.agent_test_1]])}

Review findings:
${handoffBlock([["Review", outputs.review_1]])}

Decision:
${JSON.stringify(outputs.decide_1 || {}, null, 2)}

Fix only the issues identified above. Do not do unrelated refactors and do not revert unrelated user changes. Run relevant checks when feasible.

${handoffInstructions(outputs, state, "implement_fix_1", "independent testing of the fix round")}`;
      },
      parse: (text, context) => parseHandoff("implement_fix_1", text, context),
    }),
    agent_test_2: acp({
      profile: AGENT_PROFILES.test,
      session: { handle: "test_2" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 30 * 60 * 1000,
      statusDetail: "Independently testing simple feature fix round",
      prompt: testPrompt(2, "implement_fix_1"),
      parse: (text, context) => parseHandoff("agent_test_2", text, context, {
        verdict: testVerdictText(text),
      }),
    }),
    review_2: acp({
      profile: AGENT_PROFILES.review,
      session: { handle: "review_2" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 20 * 60 * 1000,
      statusDetail: "Reviewing simple feature fix round",
      prompt: reviewPrompt(2, "implement_fix_1", "agent_test_2"),
      parse: (text, context) => parseHandoff("review_2", text, context, {
        verdict: reviewVerdictText(text),
        includeSeverity: true,
      }),
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
          firstPass: {
            implementation: handoffSummary(outputs.implement_1),
            test: handoffSummary(outputs.agent_test_1),
            review: handoffSummary(outputs.review_1),
            decision: outputs.decide_1,
          },
          fixPass: usedFixRound ? {
            implementation: handoffSummary(outputs.implement_fix_1),
            test: handoffSummary(outputs.agent_test_2),
            review: handoffSummary(outputs.review_2),
          } : null,
          flowRunId: state.runId,
          artifactHint: `~/.acpx/flows/runs/${state.runId}/`,
          handoffRoot: handoffRoot(outputs, state),
          handoffs: handoffIndex(outputs, [
            "plan",
            "implement_1",
            "agent_test_1",
            "review_1",
            "implement_fix_1",
            "agent_test_2",
            "review_2",
          ]),
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
