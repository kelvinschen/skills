import { acp, compute, decision, decisionEdge, defineFlow, shell } from "acpx/flows";
import {
  asHandoff,
  expectedHandoffPath,
  flowMemoryPath,
  handoffBlock as formatHandoffBlock,
  handoffIndex,
  handoffRoot,
  handoffSummary,
  normalizeHandoffDir,
  parseHandoff as parseSharedHandoff,
  parseSeverityCounts,
  profileAgent,
  routeOf,
} from "./shared/flow-helpers";
import {
  automaticFixGuardrail,
  handoffPrompt,
  validationReviewGuidance,
  validationVerdictMarkerPrompt,
} from "./shared/prompt-templates";

type FlowInput = {
  task?: string;
  cwd?: string;
  planAgent?: string;
  planReviewAgent?: string;
  implAgent?: string;
  validateAgent?: string;
  testAgent?: string;
  reviewAgent?: string;
  testHints?: string;
  handoffDir?: string;
  maxFixRounds?: number;
};

const AGENT_PROFILES = {
  plan: "claude",
  planReview: "aiden",
  impl: "trae",
  validate: "aiden",
} as const;

type NormalizedInput = {
  task: string;
  cwd: string;
  planAgent: string;
  planReviewAgent: string;
  implAgent: string;
  validateAgent: string;
  testHints: string;
  handoffDir: string;
  maxFixRounds: 2;
};

const DECISION_CHOICES = ["pass", "fix"] as const;

function normalizeInput(input: unknown): NormalizedInput {
  const record = input && typeof input === "object" ? (input as FlowInput) : {};
  const task = typeof record.task === "string" ? record.task.trim() : "";
  if (!task) {
    throw new Error("Input field `task` is required.");
  }
  if (record.maxFixRounds !== undefined && record.maxFixRounds !== 2) {
    throw new Error("complex-feature-refactor.flow.ts requires maxFixRounds=2.");
  }
  const cwd = typeof record.cwd === "string" && record.cwd.trim() ? record.cwd.trim() : process.cwd();
  return {
    task,
    cwd,
    planAgent: profileAgent(AGENT_PROFILES.plan, "plan"),
    planReviewAgent: profileAgent(AGENT_PROFILES.planReview, "planReview"),
    implAgent: profileAgent(AGENT_PROFILES.impl, "impl"),
    validateAgent: profileAgent(AGENT_PROFILES.validate, "validate"),
    testHints: typeof record.testHints === "string" ? record.testHints.trim() : "",
    handoffDir: normalizeHandoffDir(record.handoffDir, cwd),
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

function validationVerdictText(text: string): "pass" | "fix" | "unknown" {
  if (/^\s*VALIDATION_VERDICT:\s*fix\s*$/im.test(text)) return "fix";
  if (/^\s*VALIDATION_VERDICT:\s*pass\s*$/im.test(text)) return "pass";
  if (/\b(typecheck|tests?|unit tests?|checks?)\b[^\n]*(failed|failing|failure|error)/i.test(text)) return "fix";
  if (/\b(no blocking findings|no must-fix findings|looks good|approved)\b/i.test(text)) return "pass";
  if (/\bno\s+P0\b/i.test(text) && /\bno\s+P1\b/i.test(text)) return "pass";
  const severity = parseSeverityCounts(text);
  if (severity.P0 > 0) return "fix";
  return "unknown";
}

function finalValidationVerdictText(text: string): "pass" | "needs_human_orchestrator_decision" | "unknown" {
  if (/^\s*FINAL_VERDICT:\s*pass\s*$/im.test(text)) return "pass";
  if (/^\s*FINAL_VERDICT:\s*needs_human_orchestrator_decision\s*$/im.test(text)) {
    return "needs_human_orchestrator_decision";
  }
  const severity = parseSeverityCounts(text);
  if (severity.P0 > 0 || severity.P1 > 0) return "needs_human_orchestrator_decision";
  if (/\b(no blocking findings|no must-fix findings|looks good|approved)\b/i.test(text)) return "pass";
  if (/\bno\s+P0\b/i.test(text) && /\bno\s+P1\b/i.test(text)) return "pass";
  return "unknown";
}

function parseHandoff(node: string, text: string, context: { outputs: Record<string, unknown>; state: { runId: string } }, options: {
  verdict?: string;
  includeSeverity?: boolean;
} = {}) {
  return parseSharedHandoff(node, text, spec(context.outputs), context.state, options);
}

function handoffInstructions(outputs: Record<string, unknown>, state: { runId: string }, node: string, focus: string, extraMarkers = ""): string {
  const input = spec(outputs);
  const targetPath = expectedHandoffPath(input, state, node);
  return handoffPrompt({
    targetPath,
    memoryPath: flowMemoryPath(input, state),
    nextFocus: focus,
    extraMarkers,
  });
}

function handoffBlock(items: Array<[string, unknown]>): string {
  return formatHandoffBlock(
    items,
    "先读取 shared flow memory；只有需要更多细节时，才打开被引用的 handoff files。不要依赖被省略的 raw agent responses。",
  );
}

function validationContextBlock(items: Array<[string, unknown]>): string {
  return formatHandoffBlock(
    items,
    "先读取 shared flow memory；只有 task-focused validation 需要细节时，才打开被引用的 handoff files。不要把 scope 扩大到被省略的 raw agent responses。",
  );
}

function validationVerdict(text: unknown): "pass" | "fix" | "unknown" {
  const ref = asHandoff(text);
  if (ref?.verdict === "pass" || ref?.verdict === "fix") return ref.verdict;
  return validationVerdictText(String(text || ""));
}

function finalValidationVerdict(text: unknown): "pass" | "needs_human_orchestrator_decision" | "unknown" {
  const ref = asHandoff(text);
  if (ref?.verdict === "pass" || ref?.verdict === "needs_human_orchestrator_decision") return ref.verdict;
  return finalValidationVerdictText(String(text || ""));
}

function finalStatusFrom(validation: unknown, passStatus: string, finalRound: boolean): string {
  const validationResult = finalRound ? finalValidationVerdict(validation) : validationVerdict(validation);
  if (validationResult === "fix" || validationResult === "needs_human_orchestrator_decision") {
    return "needs_human_orchestrator_decision";
  }
  if (validationResult === "pass") {
    return passStatus;
  }
  return "unknown_needs_human_orchestrator_decision";
}

function validatePrompt(round: number, implementationKey: "implement_1" | "implement_fix_1" | "implement_fix_2", finalRound: boolean) {
  return ({ outputs, state }: { outputs: Record<string, unknown>; state: { runId: string } }) => {
    const input = spec(outputs);
    const node = round === 1 ? "validate_1" : round === 2 ? "validate_2" : "validate_3";
    return `你是 complex feature/refactor workflow 中的 independent validation agent。

Round：${round}

任务：
${input.task}

Plan reference：
${validationContextBlock([["Plan", outputs.plan]])}

Plan review reference：
${validationContextBlock([["Plan review", outputs.plan_review]])}

Implementation summary：
${validationContextBlock([["Implementation", outputs[implementationKey]]])}

用户提供的 test hints：
${input.testHints || "(无)"}

${validationReviewGuidance({ finalRound })}

${validationVerdictMarkerPrompt({ finalRound })}

${handoffInstructions(
      outputs,
      state,
      node,
      finalRound ? "final review 后交由 human orchestrator decision" : "决定是否需要另一轮 fix round",
      finalRound
        ? "\nFINAL_VERDICT: pass|needs_human_orchestrator_decision\nSEVERITY_COUNTS: P0=0 P1=0 P2=0 P3=0"
        : "\nVALIDATION_VERDICT: pass|fix\nSEVERITY_COUNTS: P0=0 P1=0 P2=0 P3=0",
    )}`;
  };
}

export default defineFlow({
  name: "complex-feature-refactor",
  run: {
    title: ({ input }) => {
      const task = typeof (input as FlowInput)?.task === "string" ? (input as FlowInput).task?.trim() : "";
      return task ? `Complex feature/refactor：${task.slice(0, 80)}` : "Complex feature/refactor";
    },
  },
  startAt: "normalize_input",
  nodes: {
    normalize_input: compute({
      statusDetail: "正在规范化 complex feature/refactor input",
      run: ({ input }) => normalizeInput(input),
    }),
    prepare_workspace: shell({
      statusDetail: "正在确保 target working directory 存在",
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
      timeoutMs: 30 * 60 * 1000,
      statusDetail: "正在规划 complex feature/refactor",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `你是 complex feature/refactor workflow 中的 planning agent。

任务：
${input.task}

Working directory：
${input.cwd}

创建一份详细但简洁的 implementation plan。不要编辑 files。包含 intended behavior、affected areas、migration/refactor constraints、implementation phases、risks、rollback considerations 和 verification strategy。

${handoffInstructions(outputs, state, "plan", "implementation 前的 plan review")}`;
      },
      parse: (text, context) => parseHandoff("plan", text, context),
    }),
    plan_review: acp({
      profile: AGENT_PROFILES.planReview,
      session: { handle: "plan_review" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 20 * 60 * 1000,
      statusDetail: "正在 review complex plan",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `你是 complex feature/refactor workflow 中的 plan review agent。

任务：
${input.task}

Proposed plan reference：
${handoffBlock([["Plan", outputs.plan]])}

在 implementation 前 review 该 plan。不要编辑 files。识别 missing constraints、high-risk areas、edge cases、test strategy gaps，以及所需的 sequencing changes。返回一段 concise amended guidance，供 implementation agent 遵循。

${handoffInstructions(outputs, state, "plan_review", "使用 reviewed plan 进行 implementation")}`;
      },
      parse: (text, context) => parseHandoff("plan_review", text, context),
    }),
    implement_1: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 90 * 60 * 1000,
      statusDetail: "正在实现 complex feature/refactor",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `你是 complex feature/refactor workflow 中的 implementation agent。

任务：
${input.task}

Accepted plan reference：
${handoffBlock([["Plan", outputs.plan]])}

Plan review guidance reference：
${handoffBlock([["Plan review", outputs.plan_review]])}

在 working directory 中实现任务。不要 revert unrelated user changes。保持 change scoped to task and plan。可行时运行 relevant checks。

${handoffInstructions(outputs, state, "implement_1", "对 implementation 进行 independent validation review")}`;
      },
      parse: (text, context) => parseHandoff("implement_1", text, context),
    }),
    validate_1: acp({
      profile: AGENT_PROFILES.validate,
      session: { handle: "validate" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 45 * 60 * 1000,
      statusDetail: "正在验证 complex feature/refactor round 1",
      prompt: validatePrompt(1, "implement_1", false),
      parse: (text, context) => parseHandoff("validate_1", text, context, {
        verdict: validationVerdictText(text),
        includeSeverity: true,
      }),
    }),
    decide_1: decision({
      profile: AGENT_PROFILES.validate,
      session: { handle: "validate" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 5 * 60 * 1000,
      statusDetail: "正在决定 complex workflow 是否需要 fix round 1",
      choices: DECISION_CHOICES,
      question: ({ outputs }) => `决定 complex feature/refactor workflow 应 pass，还是运行 fix round 1。

Rules：
- 如果 validation 包含真实 P0，选择 fix，除非你明确识别它是 false-positive severity label。
- 如果 validation 包含 VALIDATION_VERDICT: fix、失败的 task-relevant checks，或应在此 flow 中修复的 P1，选择 fix。
- P2 和 P3 findings 仅作参考材料，不得单独触发 fix。
- 否则选择 pass。

Parsed validation verdict：${validationVerdict(outputs.validate_1)}
Validation reference：
${handoffBlock([["Validation", outputs.validate_1]])}

只返回包含 route 和 reason 的 JSON。`,
    }),
    implement_fix_1: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 90 * 60 * 1000,
      statusDetail: "正在应用 complex fix round 1",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `你是 complex feature/refactor workflow 中应用 fix round 1 的 implementation agent。

任务：
${input.task}

Original plan reference：
${handoffBlock([["Plan", outputs.plan]])}

Plan review guidance reference：
${handoffBlock([["Plan review", outputs.plan_review]])}

Previous implementation summary：
${handoffBlock([["Previous implementation", outputs.implement_1]])}

Validation findings：
${handoffBlock([["Validation", outputs.validate_1]])}

Decision：
${JSON.stringify(outputs.decide_1 || {}, null, 2)}

${automaticFixGuardrail()}

只修复上面识别的问题。不要进行 unrelated refactors，也不要 revert unrelated user changes。可行时运行 relevant checks。

${handoffInstructions(outputs, state, "implement_fix_1", "对 fix round 1 进行 independent validation")}`;
      },
      parse: (text, context) => parseHandoff("implement_fix_1", text, context),
    }),
    validate_2: acp({
      profile: AGENT_PROFILES.validate,
      session: { handle: "validate" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 45 * 60 * 1000,
      statusDetail: "正在验证 complex fix round 1",
      prompt: validatePrompt(2, "implement_fix_1", false),
      parse: (text, context) => parseHandoff("validate_2", text, context, {
        verdict: validationVerdictText(text),
        includeSeverity: true,
      }),
    }),
    decide_2: decision({
      profile: AGENT_PROFILES.validate,
      session: { handle: "validate" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 5 * 60 * 1000,
      statusDetail: "正在决定 complex workflow 是否需要 final fix round",
      choices: DECISION_CHOICES,
      question: ({ outputs }) => `决定 complex feature/refactor workflow 应 pass，还是运行 final fix round。

Rules：
- 如果 validation 包含真实 P0，选择 fix，除非你明确识别它是 false-positive severity label。
- 如果 validation 包含 VALIDATION_VERDICT: fix、失败的 task-relevant checks，或应在此 flow 中修复的 P1，选择 fix。
- P2 和 P3 findings 仅作参考材料，不得单独触发 fix。
- 否则选择 pass。
- 这是最后一个 decision point。如果选择 fix，flow 将运行一次 final fix/validation pass，然后停止等待 orchestrator review。

Parsed validation verdict：${validationVerdict(outputs.validate_2)}
Validation reference：
${handoffBlock([["Validation", outputs.validate_2]])}

只返回包含 route 和 reason 的 JSON。`,
    }),
    implement_fix_2: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 90 * 60 * 1000,
      statusDetail: "正在应用 final complex fix round",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `你是 complex feature/refactor workflow 中应用 final automatic fix round 的 implementation agent。

任务：
${input.task}

Original plan reference：
${handoffBlock([["Plan", outputs.plan]])}

Plan review guidance reference：
${handoffBlock([["Plan review", outputs.plan_review]])}

Previous implementation summaries：
Round 1：
${handoffBlock([["Round 1 implementation", outputs.implement_1]])}

Fix round 1：
${handoffBlock([["Fix round 1 implementation", outputs.implement_fix_1]])}

Latest validation findings：
${handoffBlock([["Latest validation", outputs.validate_2]])}

Earlier validation findings：
${handoffBlock([["Earlier validation", outputs.validate_1]])}

Decision：
${JSON.stringify(outputs.decide_2 || {}, null, 2)}

${automaticFixGuardrail()}

只修复上面识别的问题。这是 final automatic fix round。不要进行 unrelated refactors，也不要 revert unrelated user changes。可行时运行 relevant checks。

${handoffInstructions(outputs, state, "implement_fix_2", "对 final fix round 进行 independent validation")}`;
      },
      parse: (text, context) => parseHandoff("implement_fix_2", text, context),
    }),
    validate_3: acp({
      profile: AGENT_PROFILES.validate,
      session: { handle: "validate" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 45 * 60 * 1000,
      statusDetail: "正在验证 final complex fix round",
      prompt: validatePrompt(3, "implement_fix_2", true),
      parse: (text, context) => parseHandoff("validate_3", text, context, {
        verdict: finalValidationVerdictText(text),
        includeSeverity: true,
      }),
    }),
    summarize: compute({
      statusDetail: "正在总结 complex feature/refactor result",
      run: ({ outputs, state }) => {
        const input = spec(outputs);
        const decision1 = routeOf(outputs.decide_1);
        const decision2 = routeOf(outputs.decide_2);
        const fixRoundsUsed = decision1 === "fix" ? (decision2 === "fix" ? 2 : 1) : 0;
        const finalValidation = fixRoundsUsed === 2
          ? outputs.validate_3
          : fixRoundsUsed === 1
            ? outputs.validate_2
            : outputs.validate_1;
        const finalStatus = finalStatusFrom(
          finalValidation,
          fixRoundsUsed === 2 ? "passed_after_fix_round_2" : fixRoundsUsed === 1 ? "passed_after_fix_round_1" : "passed_without_fix",
          fixRoundsUsed === 2,
        );
        return {
          task: input.task,
          cwd: input.cwd,
          template: "complex-feature-refactor",
          agents: {
            plan: input.planAgent,
            planReview: input.planReviewAgent,
            implement: input.implAgent,
            validation: input.validateAgent,
          },
          maxFixRounds: input.maxFixRounds,
          fixRoundsUsed,
          finalStatus,
          finalValidationVerdict: fixRoundsUsed === 2 ? finalValidationVerdict(finalValidation) : validationVerdict(finalValidation),
          firstPass: {
            implementation: handoffSummary(outputs.implement_1),
            validation: handoffSummary(outputs.validate_1),
            decision: outputs.decide_1,
          },
          fixPass1: fixRoundsUsed >= 1 ? {
            implementation: handoffSummary(outputs.implement_fix_1),
            validation: handoffSummary(outputs.validate_2),
            decision: outputs.decide_2,
          } : null,
          fixPass2: fixRoundsUsed >= 2 ? {
            implementation: handoffSummary(outputs.implement_fix_2),
            validation: handoffSummary(outputs.validate_3),
          } : null,
          flowRunId: state.runId,
          artifactHint: `~/.acpx/flows/runs/${state.runId}/`,
          handoffRoot: handoffRoot(input, state),
          flowMemoryPath: flowMemoryPath(input, state),
          handoffs: handoffIndex(outputs, [
            "plan",
            "plan_review",
            "implement_1",
            "validate_1",
            "implement_fix_1",
            "validate_2",
            "implement_fix_2",
            "validate_3",
          ]),
        };
      },
    }),
  },
  edges: [
    { from: "normalize_input", to: "prepare_workspace" },
    { from: "prepare_workspace", to: "plan" },
    { from: "plan", to: "plan_review" },
    { from: "plan_review", to: "implement_1" },
    { from: "implement_1", to: "validate_1" },
    { from: "validate_1", to: "decide_1" },
    decisionEdge({
      from: "decide_1",
      choices: DECISION_CHOICES,
      cases: {
        pass: "summarize",
        fix: "implement_fix_1",
      },
    }),
    { from: "implement_fix_1", to: "validate_2" },
    { from: "validate_2", to: "decide_2" },
    decisionEdge({
      from: "decide_2",
      choices: DECISION_CHOICES,
      cases: {
        pass: "summarize",
        fix: "implement_fix_2",
      },
    }),
    { from: "implement_fix_2", to: "validate_3" },
    { from: "validate_3", to: "summarize" },
  ],
});
