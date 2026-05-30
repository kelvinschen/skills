import type { Role, Stage, Variable, WorkflowSpec } from "../schema/workflow-spec.js";
import { contractNameForStage, safetyFooter, type OutputContractName } from "./contracts.js";
import { outputParserHelperSource } from "./output-parser-helper.js";

export type CompiledWorkflow = {
  spec: WorkflowSpec;
  flowSource: string;
  stageOrder: string[];
};

export type CompileWorkflowOptions = {
  stageIds?: string[];
  startStageId?: string;
  nameSuffix?: string;
};

export type CompiledFanoutBatch = CompiledWorkflow & {
  fanoutStageId: string;
  batchInputKey: "__fanoutBatchItems";
  batchSize: number;
};

type NodeSpec = {
  id: string;
  source: string;
  authorStage: string;
};

type MaterializedStage = {
  stageId: string;
  entry: string;
  terminal: string;
  nodes: NodeSpec[];
  edges: string[];
};

type AgentNodeOptions = {
  nodeId: string;
  authorStage: string;
  promptId: string;
  role: Role | undefined;
  contract: OutputContractName;
  statusDetail?: string;
  localExpression?: string;
  sessionHandle?: string;
  promptExpression?: string;
};

const BLOCKED_STOP_ID = "__blocked_stop";

export function compileWorkflow(spec: WorkflowSpec, options: CompileWorkflowOptions = {}): CompiledWorkflow {
  const selected = options.stageIds ? new Set(options.stageIds) : undefined;
  const stageOrder = topologicalOrder(spec).filter((stageId) => !selected || selected.has(stageId));
  return {
    spec,
    stageOrder,
    flowSource: materializeFlow(spec, stageOrder, options)
  };
}

export function compileFanoutBatchSegment(spec: WorkflowSpec, fanoutStageId: string, batchSize: number): CompiledFanoutBatch {
  const stage = spec.stages.find((candidate) => candidate.id === fanoutStageId);
  if (!stage || stage.kind !== "fanout") {
    throw new Error(`Stage ${fanoutStageId} is not a fanout stage.`);
  }
  const boundedBatchSize = Math.max(1, Math.floor(batchSize));
  const batchStage: Extract<Stage, { kind: "fanout" }> = {
    ...stage,
    dependsOn: undefined,
    items: { source: "input.__fanoutBatchItems" },
    limits: {
      ...(stage.limits ?? {}),
      maxFanoutItems: boundedBatchSize
    }
  };
  const batchSpec: WorkflowSpec = {
    ...spec,
    root: stage.id,
    inputs: {
      ...spec.inputs,
      __fanoutBatchItems: { type: "array<json>", default: [] }
    },
    stages: [batchStage]
  };
  return {
    ...compileWorkflow(batchSpec, { nameSuffix: `__${stage.id}_batch` }),
    fanoutStageId: stage.id,
    batchInputKey: "__fanoutBatchItems",
    batchSize: boundedBatchSize
  };
}

export function renderStagePrompt(spec: WorkflowSpec, stage: Stage): string {
  const role = stageRole(spec, stage);
  return `${stage.prompt ?? ""}${safetyFooter(stage, role)}`;
}

export function renderPromptMap(spec: WorkflowSpec): Record<string, string> {
  const prompts: Record<string, string> = {};
  for (const stage of spec.stages) collectPrompts(spec, stage, prompts);
  return prompts;
}

function collectPrompts(spec: WorkflowSpec, stage: Stage, prompts: Record<string, string>): void {
  if ("prompt" in stage && typeof stage.prompt === "string") {
    prompts[stage.id] = renderStagePrompt(spec, stage);
  }
  if (stage.kind === "fixLoop") {
    prompts[`${stage.id}__validate`] = `${stage.validator.prompt}${safetyFooter(stage, spec.roles[stage.validator.role])}`;
    prompts[`${stage.id}__fix`] = `${stage.fixer.prompt}${safetyFooter(stage, spec.roles[stage.fixer.role])}`;
  }
}

function topologicalOrder(spec: WorkflowSpec): string[] {
  const byId = new Map(spec.stages.map((stage) => [stage.id, stage] as const));
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const stage = byId.get(id);
    if (!stage) return;
    for (const dep of stage.dependsOn ?? []) visit(dep);
    visited.add(id);
    order.push(id);
  };
  visit(spec.root);
  for (const stage of spec.stages) visit(stage.id);
  return order;
}

function materializeFlow(spec: WorkflowSpec, stageOrder: string[], options: CompileWorkflowOptions = {}): string {
  const byId = new Map(spec.stages.map((stage) => [stage.id, stage] as const));
  const dependents = computeDependents(spec);
  const materialized = new Map<string, MaterializedStage>();

  for (const stageId of stageOrder) {
    const stage = byId.get(stageId);
    if (!stage) continue;
    materialized.set(stage.id, materializeStage(spec, stage));
  }

  const nodes = [...materialized.values()].flatMap((stage) => stage.nodes);
  nodes.push(blockedStopNode());

  const edges = [...materialized.values()].flatMap((stage) => stage.edges);
  for (const stageId of stageOrder) {
    const stage = byId.get(stageId);
    const materializedStage = materialized.get(stageId);
    if (!stage || !materializedStage) continue;

    if (stage.kind === "decisionGate") {
      edges.push(decisionStageEdge(stage, materializedStage.terminal, materialized));
      continue;
    }

    const next = dependents.get(stageId) ?? [];
    if (next.length === 0) continue;
    if (next.length > 1) {
      throw new Error(`Stage ${stageId} has ${next.length} dependents. Route branching through a decisionGate before compiling this workflow.`);
    }
    const nextStage = materialized.get(next[0]);
    if (!nextStage) continue;
    edges.push(statusEdge(materializedStage.terminal, nextStage.entry));
  }

  const nodeEntries = nodes.map((node) => node.source).join(",\n");
  const edgeEntries = edges.join(",\n");
  const start = materialized.get(options.startStageId ?? spec.root)?.entry ?? BLOCKED_STOP_ID;
  const promptContexts = promptContextsForSpec(spec);
  const flowName = `${spec.name}${options.nameSuffix ?? ""}`;

  return `import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acp, compute, defineFlow } from "acpx/flows";

const PROMPT_CONTEXTS = ${JSON.stringify(promptContexts, null, 2)};

${outputParserHelperSource()}

function blockedStop(outputs) {
  const blocked = Object.entries(outputs || {}).filter(([, value]) => value && typeof value === "object" && value.status === "blocked");
  return {
    status: "blocked",
    summary: blocked.length > 0 ? "Workflow stopped because a stage returned blocked." : "Workflow stopped by blocked route.",
    artifacts: [],
    nextFocus: "Review blocked workflow state",
    blockedReason: blocked[0]?.[1]?.blockedReason ?? "BLOCKED_ROUTE",
    blockedStages: blocked.map(([id, value]) => ({ id, summary: value.summary, reason: value.blockedReason }))
  };
}

function prompt(input, outputs, id, local = {}) {
  const context = PROMPT_CONTEXTS[id];
  if (!context) return input?.prompts?.[id] ?? "";
  const values = {};
  for (const variable of context.variables || []) {
    const resolved = resolveSource(variable.source, input, outputs, local);
    const transforms = variable.transform || [];
    if ((resolved === undefined || resolved === null) && !hasDefaultTransform(transforms)) {
      throw new Error("Variable " + variable.name + " resolved to a missing value from " + variable.source + ". Add an explicit default transformer if this is optional.");
    }
    values[variable.name] = applyTransforms(resolved, transforms);
  }
  const rendered = String(context.prompt || "")
    .replace(/(?<!\\\\)\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, (_, name) => stringifyPromptValue(values[name]))
    .replace(/\\\\\\$\\{/g, "\${");
  writeResolvedPrompt(input, id, rendered);
  return rendered;
}

function hasDefaultTransform(transforms) {
  return (transforms || []).some((transform) => transform?.fn === "default");
}

function writeResolvedPrompt(input, id, rendered) {
  const promptDir = input?.runtime?.promptDir;
  if (!promptDir || typeof promptDir !== "string") return;
  try {
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, safePromptFileName(id) + ".md"), rendered, "utf8");
  } catch {
    // Prompt audit writes must not change workflow semantics.
  }
}

function safePromptFileName(value) {
  return String(value || "prompt").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function stringifyPromptValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function resolveSource(source, input, outputs, local) {
  const parts = String(source || "").split(".");
  const root = parts.shift();
  let current;
  if (root === "input") current = input?.workflowInput;
  else if (root === "outputs") current = { ...(input?.runtime?.preloadedOutputs ?? {}), ...(outputs ?? {}) };
  else if (root === "item") current = local.item;
  else if (root === "loop") current = local.loop;
  else if (root === "run") current = input?.runtime;
  else return undefined;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function applyTransforms(value, transforms) {
  let current = value;
  for (const transform of transforms || []) {
    const args = transform.args || {};
    if (transform.fn === "default") current = current == null || current === "" ? args.value : current;
    else if (transform.fn === "json") current = JSON.stringify(current, null, args.pretty === false ? 0 : 2);
    else if (transform.fn === "compact") {
      const text = typeof current === "string" ? current : JSON.stringify(current, null, 2);
      const max = typeof args.maxChars === "number" ? args.maxChars : 2000;
      current = text.length > max ? text.slice(0, max).trimEnd() + "\\n... [truncated]" : text;
    }
    else if (transform.fn === "tail") {
      const text = typeof current === "string" ? current : JSON.stringify(current, null, 2);
      const max = typeof args.maxLines === "number" ? args.maxLines : 80;
      current = text.split("\\n").slice(-max).join("\\n");
    }
    else if (transform.fn === "join") current = Array.isArray(current) ? current.join(String(args.separator ?? "\\n")) : String(current ?? "");
    else if (transform.fn === "quoteBlock") current = "\\\`\\\`\\\`\\n" + String(current ?? "") + "\\n\\\`\\\`\\\`";
    else if (transform.fn === "pathList") current = pathList(current);
    else if (transform.fn === "filterSeverity") current = filterSeverity(current, args);
    else if (transform.fn === "severitySummary") current = severitySummary(current);
  }
  return current;
}

function pathList(value) {
  const items = Array.isArray(value) ? value : [];
  return items.map((item) => typeof item === "string" ? item : item?.path).filter(Boolean).join("\\n");
}

function filterSeverity(value, args) {
  const allowed = new Set(Array.isArray(args.levels) ? args.levels : []);
  return (Array.isArray(value) ? value : []).filter((item) => allowed.has(item?.severity));
}

function inputValue(input, path, fallback) {
  let current = input;
  for (const part of path) {
    if (current == null || typeof current !== "object") return fallback;
    current = current[part];
  }
  return current ?? fallback;
}

function workflowCwd(input) {
  return path.resolve(input?.workflowInput?.cwd ?? process.cwd());
}

function discoverGlob(input, args) {
  const cwd = workflowCwd(input);
  const include = normalizePatternList(args.scope ?? args.include ?? args.patterns ?? ["**/*"]);
  const exclude = normalizePatternList(args.exclude ?? []);
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = normalizePath(path.relative(cwd, absolute));
      if (!relative || matchesAny(relative, exclude)) continue;
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && matchesAny(relative, include)) {
        files.push({ id: stableItemId(relative, files.length), path: relative });
      }
    }
  };
  walk(cwd);
  return files;
}

function discoverGitChangedFiles(input, args) {
  const cwd = workflowCwd(input);
  let text = "";
  try {
    text = execFileSync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  } catch {
    return inputValue(input, ["workflowInput", args.outputKey], []);
  }
  const include = normalizePatternList(args.scope ?? args.include ?? ["**/*"]);
  const exclude = normalizePatternList(args.exclude ?? []);
  return text.split("\\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => normalizePath(line.slice(3).split(" -> ").at(-1) || ""))
    .filter((file) => file && matchesAny(file, include) && !matchesAny(file, exclude))
    .map((file, index) => ({ id: stableItemId(file, index), path: file }));
}

function normalizePatternList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return ["**/*"];
}

function normalizePath(value) {
  return String(value || "").replace(/\\\\/g, "/");
}

function matchesAny(file, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}

function globToRegExp(pattern) {
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
      source += char.replace(/[|\\\\{}()[\\]^$+?.]/g, "\\\\$&");
    }
  }
  source += "$";
  return new RegExp(source);
}

function stableItemId(file, index) {
  let hash = 0;
  for (let i = 0; i < file.length; i += 1) hash = ((hash << 5) - hash + file.charCodeAt(i)) | 0;
  return file ? "path-" + Math.abs(hash).toString(16) : "item-" + index;
}

function severitySummary(items) {
  const summary = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    const severity = item?.severity;
    if (severity && Object.prototype.hasOwnProperty.call(summary, severity)) summary[severity] += 1;
  }
  return summary;
}

function collectFindings(source) {
  if (Array.isArray(source?.findings)) return source.findings;
  const findings = [];
  for (const item of Array.isArray(source?.items) ? source.items : []) {
    if (Array.isArray(item?.findings)) findings.push(...item.findings);
    else if (item?.severity && item?.summary) findings.push(item);
  }
  return findings;
}

function dedupeFindings(source) {
  const seen = new Set();
  const result = [];
  for (const finding of collectFindings(source)) {
    const key = [finding.severity ?? "", finding.path ?? "", finding.summary ?? ""].join("\\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

function severityRank(severity) {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[severity] ?? 99;
}

function evaluate(condition, outputs, input) {
  if (condition.all) return condition.all.every((item) => evaluate(item, outputs, input));
  if (condition.any) return condition.any.some((item) => evaluate(item, outputs, input));
  if (condition.not) return !evaluate(condition.not, outputs, input);
  const value = getSource(outputs, condition.source, input);
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

function getSource(outputs, source, input) {
  const parts = String(source || "").split(".");
  let current = outputs;
  if (parts[0] === "outputs") {
    parts.shift();
    current = { ...(input?.runtime?.preloadedOutputs ?? {}), ...(outputs ?? {}) };
  }
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

export default defineFlow({
  name: ${JSON.stringify(flowName)},
  startAt: ${JSON.stringify(start)},
  nodes: {
${nodeEntries}
  },
  edges: [
${edgeEntries}
  ]
});
`;
}

function materializeStage(spec: WorkflowSpec, stage: Stage): MaterializedStage {
  switch (stage.kind) {
    case "agentTask":
    case "summarize":
      return agentUnit(spec, stage, {
        nodeId: stage.id,
        authorStage: stage.id,
        promptId: stage.id,
        role: stageRole(spec, stage),
        contract: contractNameForStage(stage, stageRole(spec, stage)),
        statusDetail: `Running ${stage.id}`
      });
    case "discover":
      if (stage.method === "agent") {
        return agentUnit(spec, stage, {
          nodeId: stage.id,
          authorStage: stage.id,
          promptId: stage.id,
          role: stage.role ? spec.roles[stage.role] : undefined,
          contract: contractNameForStage(stage, stage.role ? spec.roles[stage.role] : undefined),
          statusDetail: `Running ${stage.id}`
        });
      }
      return singleNodeStage(stage.id, computeNode(stage.id, stage.id, discoverCompute(stage)));
    case "reduce":
      if (stage.mode === "agent") {
        return agentUnit(spec, stage, {
          nodeId: stage.id,
          authorStage: stage.id,
          promptId: stage.id,
          role: stage.role ? spec.roles[stage.role] : undefined,
          contract: contractNameForStage(stage, stage.role ? spec.roles[stage.role] : undefined),
          statusDetail: `Running ${stage.id}`
        });
      }
      return singleNodeStage(stage.id, computeNode(stage.id, stage.id, reduceCompute(stage)));
    case "decisionGate":
      if (stage.mode === "agent") {
        return materializeDecisionGate(stage, agentUnit(spec, stage, {
          nodeId: stage.id,
          authorStage: stage.id,
          promptId: stage.id,
          role: stage.role ? spec.roles[stage.role] : undefined,
          contract: contractNameForStage(stage, stage.role ? spec.roles[stage.role] : undefined),
          statusDetail: `Running ${stage.id}`
        }));
      }
      return materializeDecisionGate(stage, singleNodeStage(stage.id, computeNode(stage.id, stage.id, decisionCompute(stage))));
    case "fanout":
      return materializeFanout(spec, stage);
    case "fixLoop":
      return materializeFixLoop(spec, stage);
  }
}

function singleNodeStage(stageId: string, node: NodeSpec): MaterializedStage {
  return {
    stageId,
    entry: node.id,
    terminal: node.id,
    nodes: [node],
    edges: []
  };
}

function agentUnit(spec: WorkflowSpec, stage: Stage, options: AgentNodeOptions): MaterializedStage {
  const rawId = `${options.nodeId}__agent`;
  const routeId = `${options.nodeId}__route`;
  const repairId = `${options.nodeId}__repair`;
  const finalId = options.nodeId;
  const raw = agentNode(spec, stage, { ...options, nodeId: rawId });
  const route = computeNode(routeId, options.authorStage, `const output = outputs[${JSON.stringify(rawId)}] ?? {};
const route = isRepairableOutputFailure(output)
  ? "repair"
  : (output.status === "blocked" ? "blocked" : "completed");
return { status: "completed", summary: "Agent output route: " + route, route, artifacts: [], nextFocus: route };`);
  const repair = agentNode(spec, stage, {
    ...options,
    nodeId: repairId,
    statusDetail: `Repairing output for ${options.nodeId}`,
    promptExpression: `formatRepairPrompt(outputs[${JSON.stringify(rawId)}], ${JSON.stringify(options.contract)})`
  });
  const final = computeNode(finalId, options.authorStage, `const repaired = outputs[${JSON.stringify(repairId)}];
if (repaired) return markRepairResult(repaired);
return outputs[${JSON.stringify(rawId)}];`);
  return {
    stageId: options.authorStage,
    entry: rawId,
    terminal: finalId,
    nodes: [raw, route, repair, final],
    edges: [
      directEdge(rawId, routeId),
      switchEdge(routeId, "$.route", { completed: finalId, blocked: finalId, repair: repairId }),
      directEdge(repairId, finalId)
    ]
  };
}

function agentNode(spec: WorkflowSpec, stage: Stage, options: AgentNodeOptions): NodeSpec {
  const profile = options.role?.agent ?? "aiden";
  const contractOptions = stage.kind === "discover"
    ? { outputKey: stage.output, maxItems: stage.limits?.maxFanoutItems ?? spec.limits.maxFanoutItems ?? null }
    : {};
  return {
    id: options.nodeId,
    authorStage: options.authorStage,
    source: `    ${JSON.stringify(options.nodeId)}: acp({
      profile: ${JSON.stringify(profile)},
      session: { handle: ${JSON.stringify(options.sessionHandle ?? sessionHandle(stage, options.role))} },
      cwd: ({ input }) => input?.workflowInput?.cwd ?? process.cwd(),
      timeoutMs: ${JSON.stringify((stage.limits?.stageTimeoutMinutes ?? spec.limits.stageTimeoutMinutes ?? 60) * 60 * 1000)},
      statusDetail: ${JSON.stringify(options.statusDetail ?? `Running ${options.nodeId}`)},
      prompt: ({ input, outputs }) => ${options.promptExpression ?? `prompt(input, outputs, ${JSON.stringify(options.promptId)}${options.localExpression ? `, ${options.localExpression}` : ""})`},
      parse: (text) => extractWorkflowOutput(text, ${JSON.stringify(options.contract)}, ${JSON.stringify(stage.limits?.maxOutputChars ?? spec.limits.maxOutputChars ?? null)}, ${JSON.stringify(contractOptions)})
    })`
  };
}

function computeNode(id: string, authorStage: string, body: string): NodeSpec {
  return {
    id,
    authorStage,
    source: `    ${JSON.stringify(id)}: compute({
      statusDetail: ${JSON.stringify(`Computing ${id}`)},
      run: ({ input, outputs }) => {
${indent(body, 8)}
      }
    })`
  };
}

function blockedStopNode(): NodeSpec {
  return computeNode(BLOCKED_STOP_ID, BLOCKED_STOP_ID, "return blockedStop(outputs);");
}

function discoverCompute(stage: Extract<Stage, { kind: "discover" }>): string {
  if (stage.method === "glob") {
    return `const items = discoverGlob(input, ${JSON.stringify(stage.args ?? {})});
return { status: "completed", summary: "Program glob discovery found " + items.length + " item(s).", ${JSON.stringify(stage.output)}: items, artifacts: [], nextFocus: "fanout" };`;
  }
  return `const items = discoverGitChangedFiles(input, ${JSON.stringify({ ...(stage.args ?? {}), outputKey: stage.output })});
return { status: "completed", summary: "Program gitChangedFiles discovery found " + items.length + " item(s).", ${JSON.stringify(stage.output)}: items, artifacts: [], nextFocus: "fanout" };`;
}

function reduceCompute(stage: Extract<Stage, { kind: "reduce" }>): string {
  if (stage.operation === "severitySummary") {
    return `const source = outputs[${JSON.stringify(stage.from)}];
return { status: "completed", summary: "Severity summary reduced.", severityCounts: severitySummary(collectFindings(source)), artifacts: [], nextFocus: "decision" };`;
  }
  if (stage.operation === "dedupeFindings") {
    return `const source = outputs[${JSON.stringify(stage.from)}];
const findings = dedupeFindings(source);
return { status: "completed", summary: "Deduplicated " + findings.length + " finding(s).", findings, artifacts: [], nextFocus: "decision" };`;
  }
  if (stage.operation === "sortBySeverity") {
    return `const source = outputs[${JSON.stringify(stage.from)}];
const findings = collectFindings(source).slice().sort((a, b) => severityRank(a?.severity) - severityRank(b?.severity));
return { status: "completed", summary: "Sorted " + findings.length + " finding(s) by severity.", findings, artifacts: [], nextFocus: "decision" };`;
  }
  if (stage.operation === "mergeArrays") {
    return `const source = outputs[${JSON.stringify(stage.from)}];
const sourceItems = Array.isArray(source) ? source : (Array.isArray(source?.items) ? source.items : []);
const items = sourceItems.flatMap((item) => Array.isArray(item) ? item : [item]);
return { status: "completed", summary: "Merged " + items.length + " item(s).", items, artifacts: [], nextFocus: "decision" };`;
  }
  return `const source = outputs[${JSON.stringify(stage.from)}];
return { status: "completed", summary: "Program reduce completed.", items: Array.isArray(source?.items) ? source.items : [], artifacts: [], nextFocus: "decision" };`;
}

function decisionCompute(stage: Extract<Stage, { kind: "decisionGate" }>): string {
  return `const rules = ${JSON.stringify(stage.rules)};
let route = ${JSON.stringify(stage.default)};
for (const rule of rules) {
  if (evaluate(rule.when, outputs, input)) { route = rule.to; break; }
}
return { status: route === "blocked" ? "blocked" : "completed", summary: "Decision route: " + route, route, artifacts: [], nextFocus: route };`;
}

function materializeFanout(spec: WorkflowSpec, stage: Extract<Stage, { kind: "fanout" }>): MaterializedStage {
  const maxItems = stage.limits?.maxFanoutItems ?? spec.limits.maxFanoutItems ?? 1;
  const allowPartial = stage.fanoutPolicy?.allowPartial ?? false;
  const nodes: NodeSpec[] = [];
  const edges: string[] = [];
  const itemNodeIds: string[] = [];
  let entry = "";
  let previousItem: string | undefined;

  for (let index = 0; index < maxItems; index += 1) {
    const gateId = `${stage.id}__gate_${index + 1}`;
    const itemId = `${stage.id}__item_${index + 1}`;
    const nextGateOrAggregate = index + 1 < maxItems ? `${stage.id}__gate_${index + 2}` : stage.id;
    if (!entry) entry = gateId;
    itemNodeIds.push(itemId);
    nodes.push(computeNode(gateId, stage.id, `const items = resolveSource(${JSON.stringify(stage.items.source)}, input, outputs, {}) || [];
const policy = input?.runtime?.resumePolicy?.fanout?.[${JSON.stringify(stage.id)}] ?? {};
const compiledMaxItems = ${maxItems};
const policyMaxItems = Number.isInteger(policy.maxItems) ? Math.max(0, Math.min(policy.maxItems, compiledMaxItems)) : compiledMaxItems;
const skipped = new Set(Array.isArray(policy.skipItemIndexes) ? policy.skipItemIndexes : []);
const hasIndex = Array.isArray(items) && items.length > ${index} && ${index} < policyMaxItems;
const route = !hasIndex ? "done" : (skipped.has(${index}) ? "skip" : "run");
return { status: "completed", summary: route === "run" ? "fanout item available" : (route === "skip" ? "fanout item skipped by resume policy" : "fanout complete"), route, index: ${index}, artifacts: [], nextFocus: route === "run" ? ${JSON.stringify(itemId)} : ${JSON.stringify(stage.id)} };`));
    const item = fanoutItemUnit(spec, itemId, stage, index);
    nodes.push(...item.nodes);
    edges.push(...item.edges);
    edges.push(switchEdge(gateId, "$.route", { run: item.entry, skip: nextGateOrAggregate, done: stage.id }));
    if (previousItem) edges.push(statusEdge(previousItem, gateId, { blockedTarget: allowPartial ? gateId : BLOCKED_STOP_ID }));
    previousItem = item.terminal;
  }

  if (previousItem) edges.push(statusEdge(previousItem, stage.id, { blockedTarget: allowPartial ? stage.id : BLOCKED_STOP_ID }));
nodes.push(computeNode(stage.id, stage.id, `const itemOutputs = ${JSON.stringify(itemNodeIds)}.map((id) => outputs[id]).filter(Boolean);
const blockedItems = itemOutputs.filter((item) => item?.status === "blocked");
const policy = input?.runtime?.resumePolicy?.fanout?.[${JSON.stringify(stage.id)}] ?? {};
const allowPartial = typeof policy.allowPartial === "boolean" ? policy.allowPartial : ${JSON.stringify(allowPartial)};
const minCompletedRatio = typeof policy.minCompletedRatio === "number" ? policy.minCompletedRatio : ${JSON.stringify(stage.fanoutPolicy?.minCompletedRatio ?? null)};
const maxBlockedItems = Number.isInteger(policy.maxBlockedItems) ? policy.maxBlockedItems : ${JSON.stringify(stage.fanoutPolicy?.maxBlockedItems ?? null)};
const completed = itemOutputs.filter((item) => item?.status === "completed").length;
const ratio = itemOutputs.length === 0 ? 1 : completed / itemOutputs.length;
const partialAllowed = allowPartial && (minCompletedRatio == null || ratio >= minCompletedRatio) && (maxBlockedItems == null || blockedItems.length <= maxBlockedItems);
return {
  status: blockedItems.length > 0 && !partialAllowed ? "blocked" : "completed",
  summary: "Fanout completed with " + itemOutputs.length + " item outputs.",
  items: itemOutputs,
  blockedItems,
  artifacts: [],
  nextFocus: "reduce"
};`));

  return {
    stageId: stage.id,
    entry: entry || stage.id,
    terminal: stage.id,
    nodes,
    edges
  };
}

function materializeDecisionGate(stage: Extract<Stage, { kind: "decisionGate" }>, base: MaterializedStage): MaterializedStage {
  const normalizeId = `${stage.id}__normalize_route`;
  const allowedRoutes = [...new Set([...stage.rules.map((rule) => rule.to), stage.default])];
  return {
    stageId: stage.id,
    entry: base.entry,
    terminal: normalizeId,
    nodes: [
      ...base.nodes,
      computeNode(normalizeId, stage.id, `const decision = outputs[${JSON.stringify(stage.id)}] ?? {};
const allowed = new Set(${JSON.stringify(allowedRoutes)});
const route = allowed.has(decision.route) ? decision.route : "blocked";
return { status: route === "blocked" ? "blocked" : "completed", summary: decision.summary ?? ("Decision route: " + route), route, artifacts: decision.artifacts ?? [], nextFocus: route, data: { originalRoute: decision.route } };`)
    ],
    edges: [
      ...base.edges,
      statusEdge(base.terminal, normalizeId)
    ]
  };
}

function fanoutItemUnit(spec: WorkflowSpec, nodeId: string, stage: Extract<Stage, { kind: "fanout" }>, index: number): MaterializedStage {
  return agentUnit(spec, stage, {
    nodeId,
    authorStage: stage.id,
    promptId: stage.id,
    role: spec.roles[stage.role],
    contract: contractNameForStage(stage, spec.roles[stage.role]),
    statusDetail: `Running ${nodeId}`,
    localExpression: `{ item: (resolveSource(${JSON.stringify(stage.items.source)}, input, outputs, {}) || [])[${index}] }`
  });
}

function materializeFixLoop(spec: WorkflowSpec, stage: Extract<Stage, { kind: "fixLoop" }>): MaterializedStage {
  const nodes: NodeSpec[] = [];
  const edges: string[] = [];
  let entry = "";
  let nextValidation: string | undefined;
  const validationIds: string[] = [];

  for (let round = 1; round <= stage.maxRounds; round += 1) {
    const validateId = `${stage.id}__validate_${round}`;
    const routeId = `${stage.id}__route_${round}`;
    const fixId = `${stage.id}__fix_${round}`;
    validationIds.push(validateId);

    const validate = agentUnit(spec, stage, {
      nodeId: validateId,
      authorStage: stage.id,
      promptId: `${stage.id}__validate`,
      role: spec.roles[stage.validator.role],
      contract: "validation",
      statusDetail: `Validating ${stage.id} round ${round}`
    });
    if (!entry) entry = validate.entry;
    nodes.push(...validate.nodes);
    edges.push(...validate.edges);
    nodes.push(computeNode(routeId, stage.id, `const validation = outputs[${JSON.stringify(validateId)}] ?? {};
const counts = validation.severityCounts ?? {};
const fixOn = new Set(${JSON.stringify(stage.routingPolicy.fixOn)});
const hasBlockingSeverity = ["P0", "P1", "P2", "P3"].some((severity) => fixOn.has(severity) && Number(counts[severity] ?? 0) > 0);
const hasFailedRequiredCheck = fixOn.has("failedRequiredCheck") && Array.isArray(validation.checks) && validation.checks.some((check) => check.status === "fail");
const route = validation.status === "blocked" || validation.verdict === "blocked" || validation.verdict === "unknown"
  ? "blocked"
  : (validation.verdict === "fix" || hasBlockingSeverity || hasFailedRequiredCheck ? "fix" : "pass");
return { status: route === "blocked" ? "blocked" : "completed", summary: "Fix loop route: " + route, route, artifacts: [], latestFindings: validation.findings ?? [], nextFocus: route };`));

    edges.push(statusEdge(validateId, routeId));
    const routeCases: Record<string, string> = {
      pass: stage.id,
      blocked: BLOCKED_STOP_ID
    };
    if (round === stage.maxRounds) {
      routeCases.fix = BLOCKED_STOP_ID;
    } else {
      const fix = agentUnit(spec, stage, {
        nodeId: fixId,
        authorStage: stage.id,
        promptId: `${stage.id}__fix`,
        role: spec.roles[stage.fixer.role],
        contract: "implementation",
        statusDetail: `Fixing ${stage.id} round ${round}`,
        localExpression: `{ loop: { latestFindings: outputs[${JSON.stringify(routeId)}]?.latestFindings ?? [] } }`
      });
      nodes.push(...fix.nodes);
      edges.push(...fix.edges);
      nextValidation = `${stage.id}__validate_${round + 1}`;
      edges.push(statusEdge(fix.terminal, `${nextValidation}__agent`));
      routeCases.fix = fix.entry;
    }
    edges.push(switchEdge(routeId, "$.route", routeCases));
  }

  nodes.push(computeNode(stage.id, stage.id, `const validations = ${JSON.stringify(validationIds)}.map((id) => outputs[id]).filter(Boolean);
const latest = validations.at(-1) ?? {};
return {
  status: latest.status === "blocked" || latest.verdict === "blocked" || latest.verdict === "unknown" ? "blocked" : "completed",
  summary: latest.summary ?? "fixLoop completed",
  validations,
  artifacts: [],
  nextFocus: "summarize"
};`));
  void nextValidation;
  return {
    stageId: stage.id,
    entry: entry || stage.id,
    terminal: stage.id,
    nodes,
    edges
  };
}

function decisionStageEdge(stage: Extract<Stage, { kind: "decisionGate" }>, from: string, materialized: Map<string, MaterializedStage>): string {
  const targets = new Set<string>([...stage.rules.map((rule) => rule.to), stage.default, "blocked"]);
  const cases: Record<string, string> = {};
  for (const target of targets) {
    cases[target] = target === "blocked" ? BLOCKED_STOP_ID : (materialized.get(target)?.entry ?? BLOCKED_STOP_ID);
  }
  return switchEdge(from, "$.route", cases);
}

function statusEdge(from: string, completedTarget: string, options: { blockedTarget?: string } = {}): string {
  return switchEdge(from, "$.status", {
    completed: completedTarget,
    blocked: options.blockedTarget ?? BLOCKED_STOP_ID
  });
}

function directEdge(from: string, to: string): string {
  return `    { from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)} }`;
}

function switchEdge(from: string, on: string, cases: Record<string, string>): string {
  return `    { from: ${JSON.stringify(from)}, switch: { on: ${JSON.stringify(on)}, cases: ${JSON.stringify(cases)} } }`;
}

function computeDependents(spec: WorkflowSpec): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const stage of spec.stages) {
    for (const dep of stage.dependsOn ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(stage.id);
      dependents.set(dep, list);
    }
  }
  return dependents;
}

function stageRole(spec: WorkflowSpec, stage: Stage): Role | undefined {
  if ("role" in stage && typeof stage.role === "string") return spec.roles[stage.role];
  return undefined;
}

function sessionHandle(stage: Stage, role?: Role): string {
  if (stage.kind === "summarize") return "summarize";
  if (role?.category === "implementation") return "impl";
  if (role?.category === "validation") return "validate";
  if (role?.category === "planning") return "plan";
  if (role?.category === "review") return "review";
  return stage.id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function promptContextsForSpec(spec: WorkflowSpec): Record<string, { prompt: string; variables: Variable[] }> {
  const contexts: Record<string, { prompt: string; variables: Variable[] }> = {};
  for (const stage of spec.stages) {
    if ("prompt" in stage && typeof stage.prompt === "string") {
      contexts[stage.id] = {
        prompt: renderStagePrompt(spec, stage),
        variables: stage.variables ?? []
      };
    }
    if (stage.kind === "fixLoop") {
      contexts[`${stage.id}__validate`] = {
        prompt: `${stage.validator.prompt}${safetyFooter(stage, spec.roles[stage.validator.role])}`,
        variables: stage.validator.variables ?? []
      };
      contexts[`${stage.id}__fix`] = {
        prompt: `${stage.fixer.prompt}${safetyFooter(stage, spec.roles[stage.fixer.role])}`,
        variables: stage.fixer.variables ?? []
      };
    }
  }
  return contexts;
}
