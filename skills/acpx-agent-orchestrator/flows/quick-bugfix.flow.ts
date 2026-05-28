import { acp, compute, defineFlow, shell } from "acpx/flows";
import {
  asHandoff,
  expectedHandoffPath,
  flowMemoryPath,
  handoffBlock as formatHandoffBlock,
  handoffIndex,
  handoffRoot,
  normalizeHandoffDir,
  parseHandoff as parseSharedHandoff,
  profileAgent,
} from "./shared/flow-helpers";
import { handoffPrompt, independentTestingGuidance, testVerdictMarkerPrompt } from "./shared/prompt-templates";

type FlowInput = {
  task?: string;
  cwd?: string;
  implAgent?: string;
  testAgent?: string;
  testHints?: string;
  handoffDir?: string;
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
  handoffDir: string;
  maxFixRounds: 0;
};

function normalizeInput(input: unknown): NormalizedInput {
  const record = input && typeof input === "object" ? (input as FlowInput) : {};
  const task = typeof record.task === "string" ? record.task.trim() : "";
  if (!task) {
    throw new Error("Input field `task` is required.");
  }
  if (record.maxFixRounds !== undefined && record.maxFixRounds !== 0) {
    throw new Error("quick-bugfix.flow.ts requires maxFixRounds=0.");
  }
  const cwd = typeof record.cwd === "string" && record.cwd.trim() ? record.cwd.trim() : process.cwd();
  return {
    task,
    cwd,
    implAgent: profileAgent(AGENT_PROFILES.impl, "impl"),
    testAgent: profileAgent(AGENT_PROFILES.test, "test"),
    testHints: typeof record.testHints === "string" ? record.testHints.trim() : "",
    handoffDir: normalizeHandoffDir(record.handoffDir, cwd),
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

function testVerdictText(text: string): "pass" | "fail" | "unknown" {
  if (/^\s*TEST_VERDICT:\s*fail\s*$/im.test(text)) return "fail";
  if (/^\s*TEST_VERDICT:\s*pass\s*$/im.test(text)) return "pass";
  if (/\b(typecheck|tests?|unit tests?|checks?)\b[^\n]*(failed|failing|failure|error)/i.test(text)) return "fail";
  if (/\b(all\s+)?(tests?|unit tests?|checks?)\b[^\n]*(pass(ed|ing)?|clean|green)/i.test(text)) return "pass";
  if (/\btypecheck:\s*clean\b/i.test(text)) return "pass";
  return "unknown";
}

function parseHandoff(node: string, text: string, context: { outputs: Record<string, unknown>; state: { runId: string } }, verdict?: string) {
  return parseSharedHandoff(node, text, spec(context.outputs), context.state, { verdict });
}

function handoffInstructions(outputs: Record<string, unknown>, state: { runId: string }, node: string, focus: string): string {
  const input = spec(outputs);
  const targetPath = expectedHandoffPath(input, state, node);
  return handoffPrompt({
    targetPath,
    memoryPath: flowMemoryPath(input, state),
    nextFocus: focus,
  });
}

function handoffBlock(items: Array<[string, unknown]>): string {
  return formatHandoffBlock(
    items,
    "先读取 shared flow memory；只有需要更多细节时，才打开被引用的 handoff files。不要依赖被省略的 raw agent responses。",
  );
}

function testVerdict(text: unknown): "pass" | "fail" | "unknown" {
  const ref = asHandoff(text);
  if (ref?.verdict === "pass" || ref?.verdict === "fail") return ref.verdict;
  return testVerdictText(String(text || ""));
}

export default defineFlow({
  name: "quick-bugfix",
  run: {
    title: ({ input }) => {
      const task = typeof (input as FlowInput)?.task === "string" ? (input as FlowInput).task?.trim() : "";
      return task ? `Quick bugfix：${task.slice(0, 80)}` : "Quick bugfix";
    },
  },
  startAt: "normalize_input",
  nodes: {
    normalize_input: compute({
      statusDetail: "正在规范化 quick bugfix input",
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
    implement: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 60 * 60 * 1000,
      statusDetail: "正在应用 quick bugfix",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `你是 quick bugfix workflow 中的 implementation agent。

任务：
${input.task}

Working directory：
${input.cwd}

用最小且安全有界的 change 修复 bug。不要 revert unrelated user changes。可行时运行 relevant checks。

${handoffInstructions(outputs, state, "implement", "对 bugfix 进行 independent testing")}`;
      },
      parse: (text, context) => parseHandoff("implement", text, context),
    }),
    agent_test: acp({
      profile: AGENT_PROFILES.test,
      session: { handle: "test" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 30 * 60 * 1000,
      statusDetail: "正在独立测试 quick bugfix",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `你是 quick bugfix workflow 中的 independent testing agent。

任务：
${input.task}

Implementation summary：
${handoffBlock([["Implementation", outputs.implement]])}

用户提供的 test hints：
${input.testHints || "(无)"}

${independentTestingGuidance()}

${testVerdictMarkerPrompt()}

${handoffInstructions(outputs, state, "agent_test", "orchestrator review test evidence 和 final diff")}`;
      },
      parse: (text, context) => parseHandoff("agent_test", text, context, testVerdictText(text)),
    }),
    summarize: compute({
      statusDetail: "正在总结 quick bugfix result",
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
          testVerdict: verdict,
          testFailed: verdict === "fail",
          recommendation: verdict === "fail"
            ? "Test agent 报告 failure。Orchestrator 应检查 artifacts，并决定是运行更高复杂度的 self-healing flow，还是发起 focused follow-up fix。"
            : verdict === "pass"
              ? "Test agent 报告 pass。Orchestrator 在报告 completion 前仍应检查 final diff。"
              : "Test agent 未输出可解析的 TEST_VERDICT marker。Orchestrator 应在报告 completion 前检查 test output。",
          flowRunId: state.runId,
          artifactHint: `~/.acpx/flows/runs/${state.runId}/`,
          handoffRoot: handoffRoot(input, state),
          flowMemoryPath: flowMemoryPath(input, state),
          handoffs: handoffIndex(outputs, ["implement", "agent_test"]),
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
