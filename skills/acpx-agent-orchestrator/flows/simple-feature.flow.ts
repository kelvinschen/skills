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
  implAgent?: string;
  validateAgent?: string;
  testAgent?: string;
  reviewAgent?: string;
  testHints?: string;
  handoffDir?: string;
  maxFixRounds?: number;
};

const AGENT_PROFILES = {
  plan: "aiden",
  impl: "trae",
  validate: "aiden",
} as const;

type NormalizedInput = {
  task: string;
  cwd: string;
  planAgent: string;
  implAgent: string;
  validateAgent: string;
  testHints: string;
  handoffDir: string;
  maxFixRounds: 1;
};

const DECISION_CHOICES = ["pass", "fix"] as const;

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
    validateAgent: profileAgent(AGENT_PROFILES.validate, "validate"),
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

function finalStatusFrom(validation: unknown, passStatus: string): string {
  const validationResult = validationVerdict(validation);
  if (validationResult === "fix") {
    return "needs_human_orchestrator_decision";
  }
  if (validationResult === "pass") {
    return passStatus;
  }
  return "unknown_needs_human_orchestrator_decision";
}

function validatePrompt(round: number, implementationKey: "implement_1" | "implement_fix_1") {
  return ({ outputs, state }: { outputs: Record<string, unknown>; state: { runId: string } }) => {
    const input = spec(outputs);
    const node = round === 1 ? "validate_1" : "validate_2";
    return `你是 simple feature workflow 中的 independent validation agent。

Round：${round}

任务：
${input.task}

Plan reference：
${validationContextBlock([["Plan", outputs.plan]])}

Implementation summary：
${validationContextBlock([["Implementation", outputs[implementationKey]]])}

用户提供的 test hints：
${input.testHints || "(无)"}

${validationReviewGuidance()}

${validationVerdictMarkerPrompt()}

${handoffInstructions(outputs, state, node, "决定是否需要 fix round", "\nVALIDATION_VERDICT: pass|fix\nSEVERITY_COUNTS: P0=0 P1=0 P2=0 P3=0")}`;
  };
}

export default defineFlow({
  name: "simple-feature",
  run: {
    title: ({ input }) => {
      const task = typeof (input as FlowInput)?.task === "string" ? (input as FlowInput).task?.trim() : "";
      return task ? `Simple feature：${task.slice(0, 80)}` : "Simple feature";
    },
  },
  startAt: "normalize_input",
  nodes: {
    normalize_input: compute({
      statusDetail: "正在规范化 simple feature input",
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
      statusDetail: "正在规划 simple feature",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `你是 simple feature workflow 中的 planning agent。

任务：
${input.task}

Working directory：
${input.cwd}

创建一份简洁的 implementation plan。不要编辑 files。包含 intended behavior、likely files、implementation steps、risks 和 verification strategy。

${handoffInstructions(outputs, state, "plan", "使用 accepted plan 进行 implementation")}`;
      },
      parse: (text, context) => parseHandoff("plan", text, context),
    }),
    implement_1: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 60 * 60 * 1000,
      statusDetail: "正在实现 simple feature",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `你是 simple feature workflow 中的 implementation agent。

任务：
${input.task}

Accepted plan reference：
${handoffBlock([["Plan", outputs.plan]])}

在 working directory 中实现任务。不要 revert unrelated user changes。保持 change scoped。可行时运行 relevant checks。

${handoffInstructions(outputs, state, "implement_1", "对 implementation 进行 independent validation review")}`;
      },
      parse: (text, context) => parseHandoff("implement_1", text, context),
    }),
    validate_1: acp({
      profile: AGENT_PROFILES.validate,
      session: { handle: "validate" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 45 * 60 * 1000,
      statusDetail: "正在验证 simple feature round 1",
      prompt: validatePrompt(1, "implement_1"),
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
      statusDetail: "正在决定 simple feature 是否需要一轮 fix",
      choices: DECISION_CHOICES,
      question: ({ outputs }) => `决定 simple feature workflow 应 pass，还是运行一轮 fix。

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
      timeoutMs: 60 * 60 * 1000,
      statusDetail: "正在应用 simple feature fix round 1",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `你是 simple feature workflow 中应用唯一 automatic fix round 的 implementation agent。

任务：
${input.task}

Original plan reference：
${handoffBlock([["Plan", outputs.plan]])}

Previous implementation summary：
${handoffBlock([["Previous implementation", outputs.implement_1]])}

Validation findings：
${handoffBlock([["Validation", outputs.validate_1]])}

Decision：
${JSON.stringify(outputs.decide_1 || {}, null, 2)}

${automaticFixGuardrail()}

只修复上面识别的问题。不要进行 unrelated refactors，也不要 revert unrelated user changes。可行时运行 relevant checks。

${handoffInstructions(outputs, state, "implement_fix_1", "对 fix round 进行 independent validation")}`;
      },
      parse: (text, context) => parseHandoff("implement_fix_1", text, context),
    }),
    validate_2: acp({
      profile: AGENT_PROFILES.validate,
      session: { handle: "validate" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 45 * 60 * 1000,
      statusDetail: "正在验证 simple feature fix round",
      prompt: validatePrompt(2, "implement_fix_1"),
      parse: (text, context) => parseHandoff("validate_2", text, context, {
        verdict: validationVerdictText(text),
        includeSeverity: true,
      }),
    }),
    summarize: compute({
      statusDetail: "正在总结 simple feature result",
      run: ({ outputs, state }) => {
        const input = spec(outputs);
        const usedFixRound = routeOf(outputs.decide_1) === "fix";
        const finalValidation = usedFixRound ? outputs.validate_2 : outputs.validate_1;
        return {
          task: input.task,
          cwd: input.cwd,
          template: "simple-feature",
          agents: {
            plan: input.planAgent,
            implement: input.implAgent,
            validation: input.validateAgent,
          },
          maxFixRounds: input.maxFixRounds,
          fixRoundsUsed: usedFixRound ? 1 : 0,
          finalStatus: finalStatusFrom(finalValidation, usedFixRound ? "passed_after_fix_round" : "passed_without_fix"),
          finalValidationVerdict: validationVerdict(finalValidation),
          firstPass: {
            implementation: handoffSummary(outputs.implement_1),
            validation: handoffSummary(outputs.validate_1),
            decision: outputs.decide_1,
          },
          fixPass: usedFixRound ? {
            implementation: handoffSummary(outputs.implement_fix_1),
            validation: handoffSummary(outputs.validate_2),
          } : null,
          flowRunId: state.runId,
          artifactHint: `~/.acpx/flows/runs/${state.runId}/`,
          handoffRoot: handoffRoot(input, state),
          flowMemoryPath: flowMemoryPath(input, state),
          handoffs: handoffIndex(outputs, [
            "plan",
            "implement_1",
            "validate_1",
            "implement_fix_1",
            "validate_2",
          ]),
        };
      },
    }),
  },
  edges: [
    { from: "normalize_input", to: "prepare_workspace" },
    { from: "prepare_workspace", to: "plan" },
    { from: "plan", to: "implement_1" },
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
    { from: "validate_2", to: "summarize" },
  ],
});
