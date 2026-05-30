import crypto from "node:crypto";
import { jsonrepair } from "jsonrepair";
import { getOutputContract, normalizeDeterministicAliases, type AliasNormalization, type OutputContractName } from "../contracts/output-contracts.js";

export type OutputParseErrorCode =
  | "OK"
  | "OUTPUT_PARSE_FAILED"
  | "OUTPUT_SCHEMA_FAILED"
  | "OUTPUT_AMBIGUOUS";

export type OutputCandidateMode =
  | "workflowOutputFence"
  | "jsonFence"
  | "jsoncFence"
  | "malformedFence"
  | "untaggedFence"
  | "trailingRawJson";

export type OutputCandidateSyntax = "invalidJson" | "validJson" | "repairedJson";

export type OutputCandidateDiagnostic = {
  id: string;
  mode: OutputCandidateMode;
  syntax: OutputCandidateSyntax;
  wrapper: "none" | "workflow-output";
  unwrapped: boolean;
  rawHash: string;
  rawPreview: string;
  normalizedPreview?: string;
  repairedPreview?: string;
  parseError?: string;
  schemaErrors: Array<{ path: string; message: string }>;
  aliasNormalizations: AliasNormalization[];
  valid: boolean;
  value?: unknown;
};

export type OutputParseDiagnostics = {
  errorCode: OutputParseErrorCode;
  summary: string;
  candidateCount: number;
  bestCandidateId?: string;
  recoverability: "repairable" | "not_repairable";
  candidates: OutputCandidateDiagnostic[];
  warnings: string[];
};

export type OutputParseSuccess = {
  ok: true;
  value: Record<string, unknown>;
  outputParse: {
    mode: OutputCandidateMode;
    repaired: boolean;
    unwrapped: boolean;
    candidateCount: number;
    warnings: string[];
    outputNormalizedAliases: string[];
  };
  diagnostics: OutputParseDiagnostics;
};

export type OutputParseFailure = {
  ok: false;
  errorCode: Exclude<OutputParseErrorCode, "OK">;
  summary: string;
  diagnostics: OutputParseDiagnostics;
  bestCandidate?: OutputCandidateDiagnostic;
};

export type OutputParseResult = OutputParseSuccess | OutputParseFailure;

export type ParseWorkflowOutputOptions = {
  contractOptions?: {
    outputKey?: string;
    maxItems?: number;
  };
  maxOutputChars?: number;
  maxCandidates?: number;
};

type RawCandidate = {
  id: string;
  mode: OutputCandidateMode;
  raw: string;
  start: number;
  end: number;
  info: string;
};

const DEFAULT_CANDIDATE_LIMIT = 8;
const PREVIEW_CHARS = 2000;

export function parseWorkflowOutput(text: string, contractName: OutputContractName, options: ParseWorkflowOutputOptions = {}): OutputParseResult {
  const source = String(text ?? "");
  if (typeof options.maxOutputChars === "number" && source.length > options.maxOutputChars) {
    const diagnostics = createDiagnostics({
      errorCode: "OUTPUT_PARSE_FAILED",
      summary: `Agent output exceeded maxOutputChars (${options.maxOutputChars}).`,
      candidates: [],
      recoverability: "not_repairable"
    });
    return { ok: false, errorCode: "OUTPUT_PARSE_FAILED", summary: diagnostics.summary, diagnostics };
  }

  const contract = getOutputContract(contractName, options.contractOptions);
  const rawCandidates = collectWorkflowOutputCandidates(source, options.maxCandidates ?? DEFAULT_CANDIDATE_LIMIT);
  const evaluated = rawCandidates.map((candidate) => evaluateCandidate(candidate, contract));
  const valid = evaluated.filter((candidate) => candidate.valid && candidate.value && typeof candidate.value === "object");

  if (valid.length === 1) {
    return successResult(valid[0], evaluated);
  }

  if (valid.length > 1) {
    const canonical = new Set(valid.map((candidate) => stableStringify(candidate.value)));
    if (canonical.size === 1) return successResult(selectBestValidCandidate(valid), evaluated, ["Multiple identical valid workflow-output candidates were found; accepted the highest-priority candidate."]);
    const diagnostics = createDiagnostics({
      errorCode: "OUTPUT_AMBIGUOUS",
      summary: "Multiple different valid workflow-output candidates were found.",
      candidates: evaluated,
      recoverability: "repairable",
      bestCandidateId: valid[0].id
    });
    return { ok: false, errorCode: "OUTPUT_AMBIGUOUS", summary: diagnostics.summary, diagnostics, bestCandidate: valid[0] };
  }

  const hasJson = evaluated.some((candidate) => candidate.syntax === "validJson" || candidate.syntax === "repairedJson");
  const errorCode: Exclude<OutputParseErrorCode, "OK"> = hasJson ? "OUTPUT_SCHEMA_FAILED" : "OUTPUT_PARSE_FAILED";
  const summary = rawCandidates.length === 0
    ? "Missing workflow-output JSON candidate."
    : hasJson
      ? `Found JSON candidates, but none satisfied the ${contractName} workflow-output contract.`
      : "Found workflow-output candidates, but none could be parsed as JSON.";
  const bestCandidate = selectBestInvalidCandidate(evaluated);
  const diagnostics = createDiagnostics({
    errorCode,
    summary,
    candidates: evaluated,
    recoverability: "repairable",
    bestCandidateId: bestCandidate?.id
  });
  return { ok: false, errorCode, summary, diagnostics, bestCandidate };
}

export function collectWorkflowOutputCandidates(text: string, limit = DEFAULT_CANDIDATE_LIMIT): RawCandidate[] {
  const source = String(text ?? "");
  const candidates: RawCandidate[] = [];
  const seen = new Set<string>();
  const fencePattern = /(^|\r?\n)```([^\n\r`]*)\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(source)) && candidates.length < limit) {
    const fenceStart = match.index + String(match[1] ?? "").length;
    const bodyStart = fencePattern.lastIndex;
    const close = findClosingFence(source, bodyStart);
    if (!close) break;
    const info = String(match[2] ?? "").trim();
    const body = source.slice(bodyStart, close.start).trim();
    fencePattern.lastIndex = close.end;
    const mode = candidateModeForFence(info, body);
    if (!mode) continue;
    pushCandidate(candidates, seen, {
      mode,
      raw: body,
      start: fenceStart,
      end: close.end,
      info
    });
  }

  if (candidates.length < limit) {
    const raw = trailingRawJsonObject(source);
    if (raw) {
      pushCandidate(candidates, seen, {
        mode: "trailingRawJson",
        raw,
        start: source.trimEnd().length - raw.length,
        end: source.trimEnd().length,
        info: ""
      });
    }
  }

  return candidates;
}

function findClosingFence(source: string, start: number): { start: number; end: number } | undefined {
  const closePattern = /(^|\r?\n)[ \t]*```[ \t]*(?=\r?\n|$)/g;
  closePattern.lastIndex = start;
  const match = closePattern.exec(source);
  if (!match) return undefined;
  return {
    start: match.index + String(match[1] ?? "").length,
    end: closePattern.lastIndex
  };
}

function evaluateCandidate(rawCandidate: RawCandidate, contract: ReturnType<typeof getOutputContract>): OutputCandidateDiagnostic {
  const base = {
    id: rawCandidate.id,
    mode: rawCandidate.mode,
    syntax: "invalidJson" as const,
    wrapper: "none" as const,
    unwrapped: false,
    rawHash: hashText(rawCandidate.raw),
    rawPreview: preview(rawCandidate.raw),
    schemaErrors: [],
    aliasNormalizations: [],
    valid: false
  };

  const parsed = parseJsonWithRepair(rawCandidate.raw);
  if (!parsed.ok) {
    return {
      ...base,
      parseError: parsed.error,
      repairedPreview: parsed.repairedPreview
    };
  }

  const unwrapped = unwrapWorkflowOutput(parsed.value);
  const normalized = normalizeDeterministicAliases(unwrapped.value);
  const validation = contract.schema.safeParse(normalized.value);
  const schemaErrors = validation.success
    ? []
    : validation.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? `/${issue.path.map(String).join("/")}` : "/",
        message: issue.message
      }));
  const selectedValue = validation.success ? validation.data : normalized.value;

  return {
    ...base,
    syntax: parsed.repaired ? "repairedJson" : "validJson",
    wrapper: unwrapped.unwrapped ? "workflow-output" : "none",
    unwrapped: unwrapped.unwrapped,
    normalizedPreview: preview(JSON.stringify(selectedValue, null, 2)),
    repairedPreview: parsed.repairedText ? preview(parsed.repairedText) : undefined,
    schemaErrors,
    aliasNormalizations: normalized.normalizations,
    value: selectedValue,
    valid: validation.success
  };
}

function parseJsonWithRepair(raw: string): {
  ok: true;
  value: unknown;
  repaired: boolean;
  repairedText?: string;
} | {
  ok: false;
  error: string;
  repairedPreview?: string;
} {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown, repaired: false };
  } catch (error) {
    const firstError = error instanceof Error ? error.message : String(error);
    try {
      const repairedText = jsonrepair(raw);
      return { ok: true, value: JSON.parse(repairedText) as unknown, repaired: true, repairedText };
    } catch (repairError) {
      const secondError = repairError instanceof Error ? repairError.message : String(repairError);
      return { ok: false, error: `${firstError}; jsonrepair failed: ${secondError}` };
    }
  }
}

function successResult(candidate: OutputCandidateDiagnostic, evaluated: OutputCandidateDiagnostic[], warnings: string[] = []): OutputParseSuccess {
  const aliases = candidate.aliasNormalizations.map((entry) => `${entry.from}->${entry.to}`);
  return {
    ok: true,
    value: candidate.value as Record<string, unknown>,
    outputParse: {
      mode: candidate.mode,
      repaired: candidate.syntax === "repairedJson",
      unwrapped: candidate.unwrapped,
      candidateCount: evaluated.length,
      warnings,
      outputNormalizedAliases: aliases
    },
    diagnostics: createDiagnostics({
      errorCode: "OK",
      summary: "Workflow output parsed.",
      candidates: evaluated,
      recoverability: "not_repairable",
      bestCandidateId: candidate.id,
      warnings
    })
  };
}

function createDiagnostics(input: {
  errorCode: OutputParseErrorCode;
  summary: string;
  candidates: OutputCandidateDiagnostic[];
  recoverability: "repairable" | "not_repairable";
  bestCandidateId?: string;
  warnings?: string[];
}): OutputParseDiagnostics {
  return {
    errorCode: input.errorCode,
    summary: input.summary,
    candidateCount: input.candidates.length,
    bestCandidateId: input.bestCandidateId,
    recoverability: input.recoverability,
    candidates: input.candidates.map((candidate) => ({
      ...candidate,
      value: candidate.valid ? undefined : candidate.value
    })),
    warnings: input.warnings ?? []
  };
}

function candidateModeForFence(info: string, body: string): OutputCandidateMode | undefined {
  const normalized = info.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized === "workflow-output") return "workflowOutputFence";
  if (normalized === "json") return "jsonFence";
  if (normalized === "jsonc") return "jsoncFence";
  if (normalized.includes("json") && normalized.includes("workflow-output")) return "malformedFence";
  if (!normalized && looksLikeJsonObject(body)) return "untaggedFence";
  return undefined;
}

function pushCandidate(candidates: RawCandidate[], seen: Set<string>, input: Omit<RawCandidate, "id">): void {
  if (!looksLikeJsonObject(input.raw)) return;
  const hash = hashText(input.raw);
  const key = `${hash}:${input.start}:${input.end}`;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({
    id: `candidate-${candidates.length + 1}`,
    ...input
  });
}

function unwrapWorkflowOutput(value: unknown): { value: unknown; unwrapped: boolean } {
  if (!isPlainObject(value)) return { value, unwrapped: false };
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "workflow-output" && isPlainObject(value["workflow-output"])) {
    return { value: value["workflow-output"], unwrapped: true };
  }
  return { value, unwrapped: false };
}

function trailingRawJsonObject(text: string): string | undefined {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith("}")) return undefined;
  const starts: number[] = [];
  for (let index = trimmed.lastIndexOf("{"); index >= 0 && starts.length < 80; index = trimmed.lastIndexOf("{", index - 1)) {
    starts.push(index);
  }
  for (let cursor = starts.length - 1; cursor >= 0; cursor -= 1) {
    const start = starts[cursor];
    const raw = trimmed.slice(start);
    if (balancedJsonObject(raw)) return raw;
  }
  return undefined;
}

function balancedJsonObject(raw: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0 && index !== raw.length - 1) return false;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !inString;
}

function looksLikeJsonObject(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function selectBestValidCandidate(candidates: OutputCandidateDiagnostic[]): OutputCandidateDiagnostic {
  return [...candidates].sort((left, right) => candidateRank(left.mode) - candidateRank(right.mode))[0];
}

function selectBestInvalidCandidate(candidates: OutputCandidateDiagnostic[]): OutputCandidateDiagnostic | undefined {
  return [...candidates].sort((left, right) => {
    const leftJson = left.syntax === "validJson" || left.syntax === "repairedJson" ? 0 : 1;
    const rightJson = right.syntax === "validJson" || right.syntax === "repairedJson" ? 0 : 1;
    return leftJson - rightJson || left.schemaErrors.length - right.schemaErrors.length || candidateRank(left.mode) - candidateRank(right.mode);
  })[0];
}

function candidateRank(mode: OutputCandidateMode): number {
  return {
    workflowOutputFence: 0,
    malformedFence: 1,
    jsonFence: 2,
    jsoncFence: 3,
    untaggedFence: 4,
    trailingRawJson: 5
  }[mode];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function preview(value: string, limit = PREVIEW_CHARS): string {
  return value.length > limit ? `${value.slice(0, limit)}\n... [truncated]` : value;
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
