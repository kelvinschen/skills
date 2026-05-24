import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { acp, compute, decision, decisionEdge, defineFlow, shell } from "acpx/flows";
import {
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
  plan: "aiden",
  planReview: "trae",
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
  memoryFile: string;
  handoffPath?: string;
  summaryPreview: string;
  nextFocus: string;
  rawChars: number;
  verdict?: string;
  severityCounts?: SeverityCounts;
};

type HandoffSummary = Omit<HandoffRef, "responseText">;

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

function flowMemoryPath(outputs: Record<string, unknown>, state: { runId: string }): string {
  return path.join(handoffRoot(outputs, state), "flow-memory.md");
}

function compactText(text: string, maxChars = 1800): string {
  const value = text.trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n... [truncated; inspect the flow run or handoff file for full detail]`;
}

function compactTailText(text: string, maxChars = 1200): string {
  const value = text.trim();
  if (value.length <= maxChars) return value;
  return `[truncated; inspect the flow memory or handoff file for full detail]\n${value.slice(-maxChars).trimStart()}`;
}

function nextFocus(text: string): string {
  const match = text.match(/(?:next focus|next steps?|handoff)\s*:?\s*([\s\S]{1,800})/i);
  return compactText(match?.[1] || text, 600);
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
  const summary = markerValue(text, "HANDOFF_SUMMARY") || compactTailText(responseText);
  return {
    node,
    responseText,
    memoryFile: flowMemoryPath(context.outputs, context.state),
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
    memoryPath: flowMemoryPath(outputs, state),
    nextFocus: focus,
    extraMarkers,
  });
}

function handoffBlock(items: Array<[string, unknown]>): string {
  const body = items.map(([label, value]) => {
    const ref = asHandoff(value);
    if (!ref) return `${label}: (missing)`;
    const severity = ref.severityCounts
      ? `\n- severity: P0=${ref.severityCounts.P0} P1=${ref.severityCounts.P1} P2=${ref.severityCounts.P2} P3=${ref.severityCounts.P3}`
      : "";
    return `${label}:
- flow memory: ${ref.memoryFile}
- handoff: ${ref.handoffPath || "(not specified; read the flow memory entry and session tail if needed)"}
- verdict: ${ref.verdict || "n/a"}${severity}
- summary preview:
${ref.summaryPreview || "(empty)"}
- next focus:
${ref.nextFocus || "(not specified)"}
- raw response chars: ${ref.rawChars}`;
  }).join("\n\n");
  return `Read the shared flow memory first, then open referenced handoff files only when more detail is needed. Do not rely on omitted raw agent responses.\n\n${body}`;
}

function validationContextBlock(items: Array<[string, unknown]>): string {
  const body = items.map(([label, value]) => {
    const ref = asHandoff(value);
    if (!ref) return `${label}: (missing)`;
    const severity = ref.severityCounts
      ? `\n- severity: P0=${ref.severityCounts.P0} P1=${ref.severityCounts.P1} P2=${ref.severityCounts.P2} P3=${ref.severityCounts.P3}`
      : "";
    return `${label}:
- flow memory: ${ref.memoryFile}
- handoff: ${ref.handoffPath || "(not specified; read the flow memory entry and session tail if needed)"}
- verdict: ${ref.verdict || "n/a"}${severity}
- summary preview:
${ref.summaryPreview || "(empty)"}
- next focus:
${ref.nextFocus || "(not specified)"}
- raw response chars: ${ref.rawChars}`;
  }).join("\n\n");
  return `Read the shared flow memory first, then open referenced handoff files only where task-focused validation needs detail. Do not expand scope to omitted raw agent responses.\n\n${body}`;
}

function handoffSummary(value: unknown): HandoffSummary | null {
  const ref = asHandoff(value);
  if (!ref) return null;
  return {
    node: ref.node,
    memoryFile: ref.memoryFile,
    handoffPath: ref.handoffPath,
    summaryPreview: ref.summaryPreview,
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
    return `You are the independent validation agent in a complex feature/refactor workflow.

Round: ${round}

Task:
${input.task}

Plan reference:
${validationContextBlock([["Plan", outputs.plan]])}

Plan review reference:
${validationContextBlock([["Plan review", outputs.plan_review]])}

Implementation summary:
${validationContextBlock([["Implementation", outputs[implementationKey]]])}

User-provided test hints:
${input.testHints || "(none)"}

${validationReviewGuidance({ finalRound })}

${validationVerdictMarkerPrompt({ finalRound })}

${handoffInstructions(
      outputs,
      state,
      node,
      finalRound ? "human orchestrator decision after final review" : "decision on whether another fix round is needed",
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
      timeoutMs: 30 * 60 * 1000,
      statusDetail: "Planning complex feature/refactor",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `You are the planning agent in a complex feature/refactor workflow.

Task:
${input.task}

Working directory:
${input.cwd}

Create a detailed but concise implementation plan. Do not edit files. Include intended behavior, affected areas, migration/refactor constraints, implementation phases, risks, rollback considerations, and verification strategy.

${handoffInstructions(outputs, state, "plan", "plan review before implementation")}`;
      },
      parse: (text, context) => parseHandoff("plan", text, context),
    }),
    plan_review: acp({
      profile: AGENT_PROFILES.planReview,
      session: { handle: "plan_review" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 20 * 60 * 1000,
      statusDetail: "Reviewing complex plan",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `You are the plan review agent in a complex feature/refactor workflow.

Task:
${input.task}

Proposed plan reference:
${handoffBlock([["Plan", outputs.plan]])}

Review the plan before implementation. Do not edit files. Identify missing constraints, high-risk areas, edge cases, test strategy gaps, and any sequencing changes needed. Return a concise amended guidance section that the implementation agent should follow.

${handoffInstructions(outputs, state, "plan_review", "implementation using the reviewed plan")}`;
      },
      parse: (text, context) => parseHandoff("plan_review", text, context),
    }),
    implement_1: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 90 * 60 * 1000,
      statusDetail: "Implementing complex feature/refactor",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `You are the implementation agent in a complex feature/refactor workflow.

Task:
${input.task}

Accepted plan reference:
${handoffBlock([["Plan", outputs.plan]])}

Plan review guidance reference:
${handoffBlock([["Plan review", outputs.plan_review]])}

Implement the task in the working directory. Do not revert unrelated user changes. Keep the change scoped to the task and plan. Run relevant checks when feasible.

${handoffInstructions(outputs, state, "implement_1", "independent validation review of the implementation")}`;
      },
      parse: (text, context) => parseHandoff("implement_1", text, context),
    }),
    validate_1: acp({
      profile: AGENT_PROFILES.validate,
      session: { handle: "validate" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 45 * 60 * 1000,
      statusDetail: "Validating complex feature/refactor round 1",
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
      statusDetail: "Deciding whether complex workflow needs fix round 1",
      choices: DECISION_CHOICES,
      question: ({ outputs }) => `Decide whether the complex feature/refactor workflow should pass or run fix round 1.

Rules:
- If validation contains a true P0, choose fix unless you explicitly identify it as a false-positive severity label.
- If validation contains VALIDATION_VERDICT: fix, failed task-relevant checks, or a P1 that should be fixed in this flow, choose fix.
- P2 and P3 findings are reference material only and must not alone trigger fix.
- Otherwise choose pass.

Parsed validation verdict: ${validationVerdict(outputs.validate_1)}
Validation reference:
${handoffBlock([["Validation", outputs.validate_1]])}

Return only JSON with route and reason.`,
    }),
    implement_fix_1: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 90 * 60 * 1000,
      statusDetail: "Applying complex fix round 1",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `You are the implementation agent applying fix round 1 in a complex feature/refactor workflow.

Task:
${input.task}

Original plan reference:
${handoffBlock([["Plan", outputs.plan]])}

Plan review guidance reference:
${handoffBlock([["Plan review", outputs.plan_review]])}

Previous implementation summary:
${handoffBlock([["Previous implementation", outputs.implement_1]])}

Validation findings:
${handoffBlock([["Validation", outputs.validate_1]])}

Decision:
${JSON.stringify(outputs.decide_1 || {}, null, 2)}

Fix only the issues identified above. Do not do unrelated refactors and do not revert unrelated user changes. Run relevant checks when feasible.

${handoffInstructions(outputs, state, "implement_fix_1", "independent validation of fix round 1")}`;
      },
      parse: (text, context) => parseHandoff("implement_fix_1", text, context),
    }),
    validate_2: acp({
      profile: AGENT_PROFILES.validate,
      session: { handle: "validate" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 45 * 60 * 1000,
      statusDetail: "Validating complex fix round 1",
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
      statusDetail: "Deciding whether complex workflow needs final fix round",
      choices: DECISION_CHOICES,
      question: ({ outputs }) => `Decide whether the complex feature/refactor workflow should pass or run the final fix round.

Rules:
- If validation contains a true P0, choose fix unless you explicitly identify it as a false-positive severity label.
- If validation contains VALIDATION_VERDICT: fix, failed task-relevant checks, or a P1 that should be fixed in this flow, choose fix.
- P2 and P3 findings are reference material only and must not alone trigger fix.
- Otherwise choose pass.
- This is the last decision point. If you choose fix, the flow will run one final fix/validation pass and then stop for orchestrator review.

Parsed validation verdict: ${validationVerdict(outputs.validate_2)}
Validation reference:
${handoffBlock([["Validation", outputs.validate_2]])}

Return only JSON with route and reason.`,
    }),
    implement_fix_2: acp({
      profile: AGENT_PROFILES.impl,
      session: { handle: "impl" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 90 * 60 * 1000,
      statusDetail: "Applying final complex fix round",
      prompt: ({ outputs, state }) => {
        const input = spec(outputs);
        return `You are the implementation agent applying the final automatic fix round in a complex feature/refactor workflow.

Task:
${input.task}

Original plan reference:
${handoffBlock([["Plan", outputs.plan]])}

Plan review guidance reference:
${handoffBlock([["Plan review", outputs.plan_review]])}

Previous implementation summaries:
Round 1:
${handoffBlock([["Round 1 implementation", outputs.implement_1]])}

Fix round 1:
${handoffBlock([["Fix round 1 implementation", outputs.implement_fix_1]])}

Latest validation findings:
${handoffBlock([["Latest validation", outputs.validate_2]])}

Earlier validation findings:
${handoffBlock([["Earlier validation", outputs.validate_1]])}

Decision:
${JSON.stringify(outputs.decide_2 || {}, null, 2)}

Fix only the issues identified above. This is the final automatic fix round. Do not do unrelated refactors and do not revert unrelated user changes. Run relevant checks when feasible.

${handoffInstructions(outputs, state, "implement_fix_2", "independent validation of the final fix round")}`;
      },
      parse: (text, context) => parseHandoff("implement_fix_2", text, context),
    }),
    validate_3: acp({
      profile: AGENT_PROFILES.validate,
      session: { handle: "validate" },
      cwd: ({ outputs }) => spec(outputs).cwd,
      timeoutMs: 45 * 60 * 1000,
      statusDetail: "Validating final complex fix round",
      prompt: validatePrompt(3, "implement_fix_2", true),
      parse: (text, context) => parseHandoff("validate_3", text, context, {
        verdict: finalValidationVerdictText(text),
        includeSeverity: true,
      }),
    }),
    summarize: compute({
      statusDetail: "Summarizing complex feature/refactor result",
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
          handoffRoot: handoffRoot(outputs, state),
          flowMemoryPath: flowMemoryPath(outputs, state),
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
