import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { AcpRuntimeEvent } from "acpx/runtime";
import { getOutputContract, type OutputContractName } from "../contracts/output-contracts.js";
import type { ContractPlan, ExecutionPlan, ExecutionPlanStage, PromptPlan } from "../compiler/execution-plan.js";
import type { Role, Stage, WorkflowSpec, ConditionNode, Variable } from "../schema/workflow-spec.js";
import { applyTransforms } from "../transformers/builtins.js";
import { renderPrompt } from "../variables/interpolate.js";
import { appendEvent, type AttemptIndexEntry } from "../run-index/read-write.js";
import { attemptDir, attemptId, previewText, safeFileName, writeAttemptFile } from "./attempts.js";
import type { AgentTurnResult, OrchestratorAgentRuntime } from "./agent-runtime.js";
import { formatRepairPrompt, isRepairableOutputFailure, repairFailedEnvelope } from "./repair.js";
import { parseWorkflowOutput } from "./output-parser.js";
import { recordSessionBinding } from "./session-bindings.js";

const execFileAsync = promisify(execFile);

export type AgentWorkUnit = {
  type: "stage" | "fanoutItem" | "fixLoop" | "diagnostic";
  stageId: string;
  itemId?: string;
  itemIndex?: number;
  item?: unknown;
  roleName: string;
  role: Role;
  sessionKey: string;
  promptId: string;
  contract: ContractPlan;
  outputPath: string;
  cwd: string;
  timeoutMs: number;
};

export type AgentWorkResult = {
  stageId: string;
  itemId?: string;
  status: "completed" | "blocked" | "failed";
  output?: Record<string, unknown>;
  outputPath?: string;
  attempts: AttemptIndexEntry[];
  agentCalls: number;
  repairCalls: number;
  blockedReason?: string;
  error?: string;
  errorCode?: string;
  errorMessage?: string;
};

export async function runProgramStage(input: {
  cwd: string;
  runDir: string;
  workflowInput: Record<string, unknown>;
  spec: WorkflowSpec;
  plan: ExecutionPlan;
  stage: Stage;
  planStage: ExecutionPlanStage;
  outputs: Record<string, unknown>;
}): Promise<Record<string, unknown> | undefined> {
  const stage = input.stage;
  if (stage.kind === "discover" && stage.method !== "agent") {
    const items = stage.method === "glob"
      ? await discoverGlob(input.workflowInput, stage.args ?? {})
      : await discoverGitChangedFiles(input.workflowInput, { ...(stage.args ?? {}), outputKey: stage.output });
    return {
      status: "completed",
      summary: `Program ${stage.method} discovery found ${items.length} item(s).`,
      artifacts: [],
      nextFocus: "fanout",
      [stage.output]: items
    };
  }
  if (stage.kind === "reduce" && stage.mode === "program") {
    return programReduce(stage, input.outputs);
  }
  if (stage.kind === "decisionGate" && stage.mode === "program") {
    const route = evaluateDecision(stage, input.outputs, input.workflowInput);
    return {
      status: route === "blocked" ? "blocked" : "completed",
      summary: `Decision route: ${route}`,
      artifacts: [],
      nextFocus: route,
      route,
      blockedReason: route === "blocked" ? "BLOCKED_ROUTE" : undefined
    };
  }
  return undefined;
}

export async function runAgentWork(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
}): Promise<AgentWorkResult> {
  if (input.unit.type === "fixLoop") return runFixLoop(input);
  return runSingleAgentUnit(input);
}

export function renderPlannedPrompt(input: {
  prompt: PromptPlan;
  workflowInput: Record<string, unknown>;
  outputs: Record<string, unknown>;
  local?: Record<string, unknown>;
  run?: Record<string, unknown>;
}): string {
  const values: Record<string, unknown> = {};
  for (const variable of input.prompt.variables) {
    const resolved = resolveVariable(variable, input.workflowInput, input.outputs, input.local ?? {}, input.run ?? {});
    values[variable.name] = resolved;
  }
  return `${renderPrompt(input.prompt.template, values)}${input.prompt.footer}`;
}

export function resolveSource(source: string, workflowInput: Record<string, unknown>, outputs: Record<string, unknown>, local: Record<string, unknown> = {}, run: Record<string, unknown> = {}): unknown {
  const parts = source.split(".");
  const root = parts.shift();
  let current: unknown;
  if (root === "input") current = workflowInput;
  else if (root === "outputs") current = outputs;
  else if (root === "item") current = local.item;
  else if (root === "loop") current = local.loop;
  else if (root === "run") current = run;
  else return undefined;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function stableItemId(item: unknown, index: number): string {
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    if (typeof record.id === "string" && record.id) return safeFileName(record.id);
    if (typeof record.path === "string" && record.path) return `path-${hashShort(record.path)}`;
  }
  if (typeof item === "string" && item) return `value-${hashShort(item)}`;
  return `item-${index + 1}`;
}

async function runSingleAgentUnit(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
}): Promise<AgentWorkResult> {
  const prompt = input.plan.prompts[input.unit.promptId];
  if (!prompt) throw new Error(`Missing prompt plan: ${input.unit.promptId}`);
  const renderedPrompt = renderPlannedPrompt({
    prompt,
    workflowInput: input.workflowInput,
    outputs: input.outputs,
    local: input.unit.itemId ? { item: input.unit.item } : undefined
  });
  return executeAttemptWithRepair({
    ...input,
    prompt: renderedPrompt,
    contractName: input.unit.contract.name,
    contractOptions: input.unit.contract.options
  });
}

async function runFixLoop(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
}): Promise<AgentWorkResult> {
  const stage = input.plan.stages.find((candidate) => candidate.id === input.unit.stageId);
  if (!stage?.fixLoop) throw new Error(`Missing fixLoop plan for ${input.unit.stageId}`);
  const attempts: AttemptIndexEntry[] = [];
  let agentCalls = 0;
  let repairCalls = 0;
  let latestFindings: unknown[] = [];
  let lastOutput: Record<string, unknown> | undefined;

  for (let round = 1; round <= stage.fixLoop.maxRounds; round += 1) {
    const validatorPrompt = input.plan.prompts[stage.fixLoop.validator.promptId];
    if (!validatorPrompt) throw new Error(`Missing validator prompt for ${input.unit.stageId}`);
    const validatorRole = input.plan.roles[stage.fixLoop.validator.roleName];
    const validator = await executeAttemptWithRepair({
      ...input,
      unit: {
        ...input.unit,
        roleName: stage.fixLoop.validator.roleName,
        role: validatorRole,
        sessionKey: `role:${stage.fixLoop.validator.roleName}`,
        promptId: stage.fixLoop.validator.promptId,
        contract: stage.fixLoop.validator.contract
      },
      prompt: renderPlannedPrompt({
        prompt: validatorPrompt,
        workflowInput: input.workflowInput,
        outputs: input.outputs,
        local: { loop: { round, latestFindings } }
      }),
      contractName: "validation",
      contractOptions: undefined,
      attemptOrdinal: round * 2 - 1
    });
    attempts.push(...validator.attempts);
    agentCalls += validator.agentCalls;
    repairCalls += validator.repairCalls;
    lastOutput = validator.output;
    if (validator.status !== "completed") return { ...validator, attempts, agentCalls, repairCalls };

    const verdict = String(lastOutput?.verdict ?? "unknown");
    latestFindings = Array.isArray(lastOutput?.findings) ? lastOutput.findings : [];
    if (verdict === "pass") {
      await fs.writeFile(input.unit.outputPath, `${JSON.stringify(lastOutput, null, 2)}\n`, "utf8");
      return { stageId: input.unit.stageId, status: "completed", output: lastOutput, outputPath: input.unit.outputPath, attempts, agentCalls, repairCalls };
    }
    if (verdict === "blocked" || verdict === "unknown") {
      const blocked = { ...lastOutput, status: "blocked", blockedReason: `FIX_LOOP_${verdict.toUpperCase()}` };
      await fs.writeFile(input.unit.outputPath, `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
      return { stageId: input.unit.stageId, status: "blocked", output: blocked, outputPath: input.unit.outputPath, attempts, agentCalls, repairCalls, blockedReason: String(blocked.blockedReason) };
    }
    if (round >= stage.fixLoop.maxRounds) {
      const blocked = { ...lastOutput, status: "blocked", blockedReason: "FIX_LOOP_EXHAUSTED" };
      await fs.writeFile(input.unit.outputPath, `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
      return { stageId: input.unit.stageId, status: "blocked", output: blocked, outputPath: input.unit.outputPath, attempts, agentCalls, repairCalls, blockedReason: "FIX_LOOP_EXHAUSTED" };
    }

    const fixerPrompt = input.plan.prompts[stage.fixLoop.fixer.promptId];
    if (!fixerPrompt) throw new Error(`Missing fixer prompt for ${input.unit.stageId}`);
    const fixerRole = input.plan.roles[stage.fixLoop.fixer.roleName];
    const fixer = await executeAttemptWithRepair({
      ...input,
      unit: {
        ...input.unit,
        roleName: stage.fixLoop.fixer.roleName,
        role: fixerRole,
        sessionKey: `role:${stage.fixLoop.fixer.roleName}`,
        promptId: stage.fixLoop.fixer.promptId,
        contract: stage.fixLoop.fixer.contract
      },
      prompt: renderPlannedPrompt({
        prompt: fixerPrompt,
        workflowInput: input.workflowInput,
        outputs: input.outputs,
        local: { loop: { round, latestFindings } }
      }),
      contractName: "implementation",
      contractOptions: undefined,
      attemptOrdinal: round * 2
    });
    attempts.push(...fixer.attempts);
    agentCalls += fixer.agentCalls;
    repairCalls += fixer.repairCalls;
    if (fixer.status !== "completed") return { ...fixer, attempts, agentCalls, repairCalls };
  }

  const blocked = {
    status: "blocked",
    summary: "Fix loop exhausted without a passing validation result.",
    artifacts: [],
    nextFocus: "diagnose",
    blockedReason: "FIX_LOOP_EXHAUSTED"
  };
  await fs.writeFile(input.unit.outputPath, `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
  return { stageId: input.unit.stageId, status: "blocked", output: blocked, outputPath: input.unit.outputPath, attempts, agentCalls, repairCalls, blockedReason: "FIX_LOOP_EXHAUSTED" };
}

async function executeAttemptWithRepair(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
  prompt: string;
  contractName: OutputContractName;
  contractOptions?: ContractPlan["options"];
  attemptOrdinal?: number;
}): Promise<AgentWorkResult> {
  const ordinal = input.attemptOrdinal ?? 1;
  const dir = attemptDir(input.runDir, { stageId: input.unit.stageId, itemId: input.unit.itemId, kind: "attempt", ordinal });
  const id = attemptId({ stageId: input.unit.stageId, itemId: input.unit.itemId, kind: "attempt", ordinal });
  const promptPath = await writeAttemptFile(dir, "prompt.md", input.prompt);
  await writePromptAudit(input.runDir, input.unit.itemId ? `${input.unit.stageId}__${input.unit.itemId}` : input.unit.stageId, input.prompt);
  const startedAt = new Date().toISOString();
  const attemptEntryBase = {
    id,
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    kind: "attempt" as const,
    status: "running" as const,
    path: path.relative(input.runDir, dir),
    startedAt,
    promptPreview: previewText(input.prompt),
    sessionKey: input.unit.sessionKey,
    requestId: id,
    agent: input.unit.role.agent,
    roleMode: input.unit.role.mode,
    runtimeDisposeInvoked: false
  };
  await appendEvent(input.cwd, input.runId, { type: "attempt_created", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id });
  await appendEvent(input.cwd, input.runId, { type: "attempt_started", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id });
  await appendEvent(input.cwd, input.runId, { type: "turn_started", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, sessionKey: input.unit.sessionKey, agent: input.unit.role.agent, roleMode: input.unit.role.mode });
  let turn: AgentTurnResult;
  try {
    turn = await input.runtime.runTurn({
      sessionKey: input.unit.sessionKey,
      roleName: input.unit.roleName,
      role: input.unit.role,
      cwd: input.unit.cwd,
      prompt: input.prompt,
      requestId: id,
      timeoutMs: input.unit.timeoutMs
    }, async (event) => appendTurnEvent(input.cwd, input.runId, input.unit.stageId, input.unit.itemId, id, event));
    await appendEvent(input.cwd, input.runId, { type: "turn_finished", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, status: turn.status, stopReason: turn.stopReason, errorCode: turn.errorDetailCode ?? turn.errorCode });
  } catch (error) {
    await appendEvent(input.cwd, input.runId, { type: "turn_finished", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, status: "failed", error: errorMessage(error) });
    throw error;
  }
  await recordSessionBinding(input.runDir, {
    sessionKey: input.unit.sessionKey,
    roleName: input.unit.roleName,
    agent: input.unit.role.agent,
    cwd: input.unit.cwd,
    handle: turn.handle
  });
  await writeAttemptFile(dir, "raw.txt", turn.rawText);

  if (turn.status !== "completed") {
    const diagnostics = runtimeDiagnostics(input, id, turn);
    const output = {
      status: "blocked",
      summary: turn.error ?? `Agent turn ${turn.status}.`,
      artifacts: [],
      nextFocus: "diagnose",
      blockedReason: turn.status === "cancelled" ? "AGENT_TURN_CANCELLED" : "AGENT_TURN_FAILED",
      runtimeDiagnostics: diagnostics
    };
    await writeAttemptFile(dir, "output.json", output);
    await writeUnitOutput(input, output, id);
    return {
      stageId: input.unit.stageId,
      itemId: input.unit.itemId,
      status: "blocked",
      output,
      outputPath: input.unit.outputPath,
      attempts: [{
        ...attemptEntryBase,
        status: "blocked",
        endedAt: new Date().toISOString(),
        blockedReason: String(output.blockedReason),
        rawPreview: previewText(turn.rawText),
        stopReason: turn.stopReason,
        runtimeErrorCode: turn.errorDetailCode ?? turn.errorCode ?? String(output.blockedReason)
      }],
      agentCalls: 1,
      repairCalls: 0,
      blockedReason: String(output.blockedReason)
    };
  }

  const parsed = parseWorkflowOutput(turn.rawText, input.contractName, {
    contractOptions: input.contractOptions,
    maxOutputChars: input.plan.limits.maxOutputChars
  });
  await writeAttemptFile(dir, "parse.json", parsed.diagnostics);
  if (parsed.ok) {
    const output = withOutputParseMetadata(parsed.value, parsed.outputParse);
    await writeAttemptFile(dir, "output.json", output);
    await writeUnitOutput(input, output, id);
    return {
      stageId: input.unit.stageId,
      itemId: input.unit.itemId,
      status: output.status === "blocked" ? "blocked" : "completed",
      output,
      outputPath: input.unit.outputPath,
      attempts: [{ ...attemptEntryBase, status: output.status === "blocked" ? "blocked" : "completed", endedAt: new Date().toISOString(), blockedReason: typeof output.blockedReason === "string" ? output.blockedReason : undefined, parseErrorCode: parsed.diagnostics.errorCode, rawPreview: previewText(turn.rawText) }],
      agentCalls: 1,
      repairCalls: 0,
      blockedReason: typeof output.blockedReason === "string" ? output.blockedReason : undefined
    };
  }

  const blocked = {
    status: "blocked",
    summary: parsed.summary,
    artifacts: [],
    nextFocus: "Repair workflow output",
    blockedReason: parsed.errorCode,
    parseDiagnostics: parsed.diagnostics
  };
  await writeAttemptFile(dir, "output.json", blocked);
  if (!isRepairableOutputFailure(parsed.errorCode)) {
    await writeUnitOutput(input, blocked, id);
    return {
      stageId: input.unit.stageId,
      itemId: input.unit.itemId,
      status: "blocked",
      output: blocked,
      outputPath: input.unit.outputPath,
      attempts: [{ ...attemptEntryBase, status: "blocked", endedAt: new Date().toISOString(), blockedReason: parsed.errorCode, parseErrorCode: parsed.errorCode, rawPreview: previewText(turn.rawText) }],
      agentCalls: 1,
      repairCalls: 0,
      blockedReason: parsed.errorCode
    };
  }

  const repairPrompt = formatRepairPrompt({
    contractName: input.contractName,
    contractOptions: input.contractOptions,
    failure: parsed
  });
  const repair = await executeRepairAttempt({
    ...input,
    originalAttempt: { ...attemptEntryBase, status: "repairing", endedAt: new Date().toISOString(), blockedReason: parsed.errorCode, parseErrorCode: parsed.errorCode, rawPreview: previewText(turn.rawText) },
    originalReason: parsed.errorCode,
    prompt: repairPrompt,
    ordinal
  });
  return {
    ...repair,
    attempts: [{ ...attemptEntryBase, status: repair.status === "completed" ? "completed" : "blocked", endedAt: new Date().toISOString(), blockedReason: repair.status === "blocked" ? parsed.errorCode : undefined, parseErrorCode: parsed.errorCode, rawPreview: previewText(turn.rawText) }, ...repair.attempts],
    agentCalls: repair.agentCalls + 1,
    repairCalls: repair.repairCalls
  };
}

async function executeRepairAttempt(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
  prompt: string;
  contractName: OutputContractName;
  contractOptions?: ContractPlan["options"];
  originalAttempt: AttemptIndexEntry;
  originalReason: string;
  ordinal: number;
}): Promise<AgentWorkResult> {
  const dir = attemptDir(input.runDir, { stageId: input.unit.stageId, itemId: input.unit.itemId, kind: "repair", ordinal: input.ordinal });
  const id = attemptId({ stageId: input.unit.stageId, itemId: input.unit.itemId, kind: "repair", ordinal: input.ordinal });
  await writeAttemptFile(dir, "prompt.md", input.prompt);
  const entryBase = {
    id,
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    kind: "repair" as const,
    status: "running" as const,
    path: path.relative(input.runDir, dir),
    startedAt: new Date().toISOString(),
    promptPreview: previewText(input.prompt),
    sessionKey: input.unit.sessionKey,
    requestId: id,
    agent: input.unit.role.agent,
    roleMode: input.unit.role.mode,
    runtimeDisposeInvoked: false
  };
  await appendEvent(input.cwd, input.runId, { type: "attempt_created", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, repair: true });
  await appendEvent(input.cwd, input.runId, { type: "repair_started", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, originalReason: input.originalReason });
  await appendEvent(input.cwd, input.runId, { type: "turn_started", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, sessionKey: input.unit.sessionKey, agent: input.unit.role.agent, roleMode: input.unit.role.mode, repair: true });
  let turn: AgentTurnResult;
  try {
    turn = await input.runtime.runTurn({
      sessionKey: input.unit.sessionKey,
      roleName: input.unit.roleName,
      role: input.unit.role,
      cwd: input.unit.cwd,
      prompt: input.prompt,
      requestId: id,
      timeoutMs: input.unit.timeoutMs,
      repair: true
    }, async (event) => appendTurnEvent(input.cwd, input.runId, input.unit.stageId, input.unit.itemId, id, event));
    await appendEvent(input.cwd, input.runId, { type: "turn_finished", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, status: turn.status, stopReason: turn.stopReason, errorCode: turn.errorDetailCode ?? turn.errorCode, repair: true });
  } catch (error) {
    await appendEvent(input.cwd, input.runId, { type: "turn_finished", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, status: "failed", error: errorMessage(error), repair: true });
    throw error;
  }
  await writeAttemptFile(dir, "raw.txt", turn.rawText);
  const parsed = turn.status === "completed"
    ? parseWorkflowOutput(turn.rawText, input.contractName, {
        contractOptions: input.contractOptions,
        maxOutputChars: input.plan.limits.maxOutputChars
      })
    : undefined;
  await writeAttemptFile(dir, "parse.json", parsed?.diagnostics ?? { errorCode: "AGENT_TURN_FAILED", summary: turn.error ?? turn.status });
  if (parsed?.ok) {
    const output = withOutputParseMetadata(parsed.value, {
      ...parsed.outputParse,
      repairedFromStageAttempt: input.originalAttempt.id
    });
    await writeAttemptFile(dir, "output.json", output);
    await writeUnitOutput(input, output, id);
    return {
      stageId: input.unit.stageId,
      itemId: input.unit.itemId,
      status: output.status === "blocked" ? "blocked" : "completed",
      output,
      outputPath: input.unit.outputPath,
      attempts: [{ ...entryBase, status: output.status === "blocked" ? "blocked" : "completed", endedAt: new Date().toISOString(), parseErrorCode: parsed.diagnostics.errorCode, rawPreview: previewText(turn.rawText) }],
      agentCalls: 1,
      repairCalls: 1,
      blockedReason: typeof output.blockedReason === "string" ? output.blockedReason : undefined
    };
  }
  const output = repairFailedEnvelope({
    summary: parsed?.summary ?? (turn.error ?? "Repair turn failed."),
    originalReason: input.originalReason,
    repairDiagnostics: parsed?.diagnostics ?? { errorCode: "AGENT_TURN_FAILED", summary: turn.error ?? turn.status }
  });
  await writeAttemptFile(dir, "output.json", output);
  await writeUnitOutput(input, output, id);
  return {
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    status: "blocked",
    output,
    outputPath: input.unit.outputPath,
    attempts: [{ ...entryBase, status: "blocked", endedAt: new Date().toISOString(), blockedReason: "OUTPUT_REPAIR_FAILED", parseErrorCode: parsed?.diagnostics.errorCode ?? "AGENT_TURN_FAILED", rawPreview: previewText(turn.rawText) }],
    agentCalls: 1,
    repairCalls: 1,
    blockedReason: "OUTPUT_REPAIR_FAILED"
  };
}

function resolveVariable(variable: Variable, workflowInput: Record<string, unknown>, outputs: Record<string, unknown>, local: Record<string, unknown>, run: Record<string, unknown>): unknown {
  const value = resolveSource(variable.source, workflowInput, outputs, local, run);
  const transforms = variable.transform ?? [];
  if ((value === undefined || value === null) && !transforms.some((transform) => transform.fn === "default")) {
    throw new Error(`Variable ${variable.name} resolved to a missing value from ${variable.source}. Add an explicit default transformer if this is optional.`);
  }
  return applyTransforms(value, transforms);
}

function withOutputParseMetadata(output: Record<string, unknown>, outputParse: Record<string, unknown>): Record<string, unknown> {
  const metadata = output.metadata && typeof output.metadata === "object" ? output.metadata as Record<string, unknown> : {};
  return {
    ...output,
    metadata: {
      ...metadata,
      outputParse
    }
  };
}

async function writeUnitOutput(input: {
  cwd: string;
  runDir: string;
  runId: string;
  unit: AgentWorkUnit;
}, output: Record<string, unknown>, attemptId?: string): Promise<void> {
  await fs.mkdir(path.dirname(input.unit.outputPath), { recursive: true });
  await fs.writeFile(input.unit.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await appendEvent(input.cwd, input.runId, {
    type: "output_written",
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    attemptId,
    outputPath: path.relative(input.runDir, input.unit.outputPath),
    status: output.status
  });
}

function runtimeDiagnostics(input: {
  unit: AgentWorkUnit;
}, requestId: string, turn: AgentTurnResult): Record<string, unknown> {
  return {
    stopReason: turn.stopReason,
    requestId,
    sessionKey: input.unit.sessionKey,
    agent: input.unit.role.agent,
    roleMode: input.unit.role.mode,
    runtimeDisposeInvoked: false,
    errorCode: turn.errorDetailCode ?? turn.errorCode,
    rawTextPreview: previewText(turn.rawText)
  };
}

async function appendTurnEvent(cwd: string, runId: string, stageId: string, itemId: string | undefined, attemptId: string, event: AcpRuntimeEvent): Promise<void> {
  await appendEvent(cwd, runId, {
    type: "agent_event",
    stageId,
    itemId,
    attemptId,
    event
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writePromptAudit(runDir: string, id: string, prompt: string): Promise<void> {
  const filePath = path.join(runDir, "prompts", `${safeFileName(id)}.md`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, prompt, "utf8");
}

async function discoverGlob(workflowInput: Record<string, unknown>, args: Record<string, unknown>): Promise<Array<{ id: string; path: string }>> {
  const cwd = workflowCwd(workflowInput);
  const include = normalizePatternList(args.scope ?? args.include ?? args.patterns ?? args.pattern ?? ["**/*"]);
  const ignore = normalizePatternList(args.exclude ?? []);
  const files = await fg(include, {
    cwd,
    ignore,
    dot: true,
    onlyFiles: true,
    unique: true
  });
  return files.map((file, index) => ({ id: stableItemId({ path: file }, index), path: file }));
}

async function discoverGitChangedFiles(workflowInput: Record<string, unknown>, args: Record<string, unknown>): Promise<Array<{ id: string; path: string }>> {
  const cwd = workflowCwd(workflowInput);
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
    const include = normalizePatternList(args.scope ?? args.include ?? ["**/*"]);
    const exclude = normalizePatternList(args.exclude ?? []);
    return stdout.split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => normalizePath(line.slice(3).split(" -> ").at(-1) ?? ""))
      .filter((file) => file && matchesAny(file, include) && !matchesAny(file, exclude))
      .map((file, index) => ({ id: stableItemId({ path: file }, index), path: file }));
  } catch {
    const fallback = workflowInput[String(args.outputKey ?? "files")];
    return Array.isArray(fallback) ? fallback as Array<{ id: string; path: string }> : [];
  }
}

function programReduce(stage: Extract<Stage, { kind: "reduce" }>, outputs: Record<string, unknown>): Record<string, unknown> {
  const source = outputs[stage.from];
  const items = Array.isArray((source as Record<string, unknown> | undefined)?.items) ? (source as Record<string, unknown>).items as unknown[] : [];
  const operation = stage.operation ?? "mergeArrays";
  let data: unknown = items;
  if (operation === "severitySummary") data = severitySummary(items.flatMap((item) => Array.isArray((item as Record<string, unknown> | undefined)?.findings) ? (item as Record<string, unknown>).findings as unknown[] : []));
  if (operation === "dedupeFindings") data = dedupeFindings(items);
  if (operation === "sortBySeverity") data = dedupeFindings(items).sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  return {
    status: "completed",
    summary: `Program reduce ${operation} completed.`,
    artifacts: [],
    nextFocus: "summarize",
    items: data,
    data: { operation, sourceStage: stage.from }
  };
}

function evaluateDecision(stage: Extract<Stage, { kind: "decisionGate" }>, outputs: Record<string, unknown>, workflowInput: Record<string, unknown>): string {
  for (const rule of stage.rules) {
    if (evaluateCondition(rule.when, outputs, workflowInput)) return rule.to;
  }
  return stage.default;
}

function evaluateCondition(condition: ConditionNode, outputs: Record<string, unknown>, workflowInput: Record<string, unknown>): boolean {
  if ("all" in condition) return Array.isArray(condition.all) && condition.all.every((item) => evaluateCondition(item, outputs, workflowInput));
  if ("any" in condition) return Array.isArray(condition.any) && condition.any.some((item) => evaluateCondition(item, outputs, workflowInput));
  if ("not" in condition) return condition.not ? !evaluateCondition(condition.not, outputs, workflowInput) : false;
  const value = condition.source ? resolveSource(condition.source, workflowInput, outputs) : undefined;
  switch (condition.op) {
    case "eq": return value === condition.value;
    case "neq": return value !== condition.value;
    case "gt": return Number(value) > Number(condition.value);
    case "gte": return Number(value) >= Number(condition.value);
    case "lt": return Number(value) < Number(condition.value);
    case "lte": return Number(value) <= Number(condition.value);
    case "in": return Array.isArray(condition.value) && condition.value.includes(value);
    case "exists": return value !== undefined && value !== null;
    case "empty": return value == null || value === "" || (Array.isArray(value) && value.length === 0);
    default: return false;
  }
}

function workflowCwd(workflowInput: Record<string, unknown>): string {
  return path.resolve(typeof workflowInput.cwd === "string" ? workflowInput.cwd : process.cwd());
}

function normalizePatternList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return ["**/*"];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => fg.isDynamicPattern(pattern) ? minimatchLike(file, pattern) : file === normalizePath(pattern));
}

function minimatchLike(file: string, pattern: string): boolean {
  let source = "^";
  const text = normalizePath(pattern);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    const afterNext = text[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  source += "$";
  return new RegExp(source).test(file);
}

function severitySummary(items: unknown[]): Record<string, number> {
  const summary: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const item of items) {
    const severity = item && typeof item === "object" ? String((item as Record<string, unknown>).severity ?? "") : "";
    if (severity in summary) summary[severity] += 1;
  }
  return summary;
}

function dedupeFindings(items: unknown[]): Array<Record<string, unknown>> {
  const findings = items.flatMap((item) => {
    if (item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).findings)) return (item as Record<string, unknown>).findings as unknown[];
    if (item && typeof item === "object" && "severity" in item && "summary" in item) return [item];
    return [];
  });
  const seen = new Set<string>();
  const result: Array<Record<string, unknown>> = [];
  for (const finding of findings) {
    if (!finding || typeof finding !== "object") continue;
    const record = finding as Record<string, unknown>;
    const key = [record.severity ?? "", record.path ?? "", record.summary ?? ""].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
  }
  return result;
}

function severityRank(value: unknown): number {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[String(value)] ?? 99;
}

function hashShort(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}
