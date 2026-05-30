export function outputParserHelperSource(): string {
  return OUTPUT_PARSER_HELPER_SOURCE;
}

const OUTPUT_PARSER_HELPER_SOURCE = String.raw`
const REPAIRABLE_OUTPUT_REASONS = ["OUTPUT_PARSE_FAILED", "OUTPUT_SCHEMA_FAILED", "OUTPUT_AMBIGUOUS"];
const CANDIDATE_LIMIT = 8;

function extractWorkflowOutput(text, contract, maxOutputChars, contractOptions = {}) {
  const source = String(text || "");
  if (typeof maxOutputChars === "number" && source.length > maxOutputChars) {
    const diagnostics = createParseDiagnostics({
      errorCode: "OUTPUT_PARSE_FAILED",
      summary: "Agent output exceeded maxOutputChars (" + maxOutputChars + ").",
      candidates: [],
      rawText: source,
      recoverability: "not_repairable"
    });
    return parseBlocked(diagnostics.summary, source, "OUTPUT_PARSE_FAILED", diagnostics);
  }
  const parsed = parseWorkflowOutput(source, contract, contractOptions);
  if (!parsed.ok) return parseBlocked(parsed.summary, source, parsed.errorCode, parsed.diagnostics);
  return {
    ...parsed.value,
    metadata: {
      ...(isPlainObject(parsed.value.metadata) ? parsed.value.metadata : {}),
      outputParse: parsed.outputParse
    }
  };
}

function parseWorkflowOutput(text, contract, contractOptions = {}) {
  const candidates = collectWorkflowOutputCandidates(text);
  const evaluated = candidates.map((candidate) => evaluateWorkflowOutputCandidate(candidate, contract, contractOptions));
  const valid = evaluated.filter((candidate) => candidate.valid);

  if (valid.length === 1) {
    return successParseResult(valid[0], evaluated, []);
  }

  if (valid.length > 1) {
    const canonical = new Map();
    for (const candidate of valid) {
      const key = stableStringify(candidate.value);
      if (!canonical.has(key)) canonical.set(key, []);
      canonical.get(key).push(candidate);
    }
    if (canonical.size === 1) {
      const selected = selectBestValidCandidate(valid);
      return successParseResult(selected, evaluated, ["Multiple identical valid workflow-output candidates were found; accepted the highest-priority candidate."]);
    }
    const diagnostics = createParseDiagnostics({
      errorCode: "OUTPUT_AMBIGUOUS",
      summary: "Multiple different valid workflow-output candidates were found.",
      candidates: evaluated,
      rawText: text,
      recoverability: "repairable"
    });
    return { ok: false, errorCode: "OUTPUT_AMBIGUOUS", summary: diagnostics.summary, diagnostics };
  }

  const hasJson = evaluated.some((candidate) => candidate.syntax === "validJson" || candidate.syntax === "repairedJson");
  const errorCode = hasJson ? "OUTPUT_SCHEMA_FAILED" : "OUTPUT_PARSE_FAILED";
  const summary = candidates.length === 0
    ? "Missing workflow-output JSON candidate."
    : (hasJson
      ? "Found JSON candidates, but none satisfied the " + contract + " workflow-output contract."
      : "Found workflow-output candidates, but none could be parsed as JSON.");
  const diagnostics = createParseDiagnostics({
    errorCode,
    summary,
    candidates: evaluated,
    rawText: text,
    recoverability: "repairable"
  });
  return { ok: false, errorCode, summary, diagnostics };
}

function successParseResult(candidate, evaluated, warnings) {
  return {
    ok: true,
    value: candidate.value,
    outputParse: {
      mode: candidate.mode,
      repaired: candidate.syntax === "repairedJson",
      unwrapped: candidate.unwrapped,
      candidateCount: evaluated.length,
      warnings
    },
    diagnostics: createParseDiagnostics({
      errorCode: "OK",
      summary: "Workflow output parsed.",
      candidates: evaluated,
      rawText: "",
      recoverability: "not_repairable",
      warnings
    })
  };
}

function collectWorkflowOutputCandidates(text) {
  const source = String(text || "");
  const candidates = [];
  const seen = new Set();
  const tick = String.fromCharCode(96);
  const fencePattern = new RegExp("(^|\\r?\\n)" + tick + "{3}([^\\n\\r" + tick + "]*)\\r?\\n", "g");
  let match;
  while ((match = fencePattern.exec(source)) && candidates.length < CANDIDATE_LIMIT) {
    const fenceStart = match.index + String(match[1] || "").length;
    const bodyStart = fencePattern.lastIndex;
    const close = findClosingFence(source, bodyStart);
    if (!close) break;
    const info = String(match[2] || "").trim();
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

  if (candidates.length < CANDIDATE_LIMIT) {
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

function findClosingFence(source, start) {
  const tick = String.fromCharCode(96);
  const closePattern = new RegExp("(^|\\r?\\n)[ \\t]*" + tick + "{3}[ \\t]*(?=\\r?\\n|$)", "g");
  closePattern.lastIndex = start;
  const match = closePattern.exec(source);
  if (!match) return undefined;
  return {
    start: match.index + String(match[1] || "").length,
    end: closePattern.lastIndex
  };
}

function candidateModeForFence(info, body) {
  const normalized = info.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized === "workflow-output") return "workflowOutputFence";
  if (normalized === "json") return "jsonFence";
  if (normalized === "jsonc") return "jsoncFence";
  if (normalized.includes("json") && normalized.includes("workflow-output")) return "malformedFence";
  if (!normalized && looksLikeJsonObject(body)) return "untaggedFence";
  return undefined;
}

function pushCandidate(candidates, seen, candidate) {
  if (!looksLikeJsonObject(candidate.raw)) return;
  const hash = hashText(candidate.raw);
  const key = hash + ":" + candidate.start + ":" + candidate.end;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({
    id: "candidate-" + (candidates.length + 1),
    mode: candidate.mode,
    raw: candidate.raw,
    rawSnippetHash: hash,
    rawSnippetPreview: preview(candidate.raw, 600),
    start: candidate.start,
    end: candidate.end,
    info: candidate.info
  });
}

function trailingRawJsonObject(text) {
  const trimmed = String(text || "").trimEnd();
  if (!trimmed.endsWith("}")) return undefined;
  const starts = [];
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

function balancedJsonObject(raw) {
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
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && index !== raw.length - 1) return false;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !inString;
}

function evaluateWorkflowOutputCandidate(candidate, contract, contractOptions) {
  const base = {
    id: candidate.id,
    mode: candidate.mode,
    syntax: "invalidJson",
    rawSnippetHash: candidate.rawSnippetHash,
    rawSnippetPreview: candidate.rawSnippetPreview,
    unwrapped: false,
    wrapper: "none",
    schemaErrors: [],
    start: candidate.start,
    value: undefined,
    valid: false
  };
  let parsed;
  try {
    parsed = JSON.parse(candidate.raw);
  } catch (error) {
    return { ...base, parseError: String(error) };
  }

  const normalized = normalizeWorkflowOutputWrapper(parsed);
  const validation = validateWorkflowOutput(normalized.value, contract, contractOptions);
  return {
    ...base,
    syntax: "validJson",
    wrapper: normalized.unwrapped ? "workflow-output" : "none",
    unwrapped: normalized.unwrapped,
    schemaErrors: validation.ok ? [] : validation.errors,
    value: normalized.value,
    valid: validation.ok
  };
}

function normalizeWorkflowOutputWrapper(value) {
  if (!isPlainObject(value)) return { value, unwrapped: false };
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "workflow-output" && isPlainObject(value["workflow-output"])) {
    return { value: value["workflow-output"], unwrapped: true };
  }
  return { value, unwrapped: false };
}

function validateWorkflowOutput(value, contract, options = {}) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: [schemaError("", "workflow-output must be a JSON object.")] };
  if (value.status !== "completed" && value.status !== "blocked") errors.push(schemaError("/status", "workflow-output.status must be completed or blocked."));
  if (typeof value.summary !== "string") errors.push(schemaError("/summary", "workflow-output.summary must be a string."));
  if (!Array.isArray(value.artifacts)) errors.push(schemaError("/artifacts", "workflow-output.artifacts must be an array."));
  else errors.push(...validateArtifacts(value.artifacts, "/artifacts"));
  if (typeof value.nextFocus !== "string") errors.push(schemaError("/nextFocus", "workflow-output.nextFocus must be a string."));

  if (contract === "validation") {
    if (!["pass", "fix", "blocked", "unknown"].includes(value.verdict)) errors.push(schemaError("/verdict", "validation output requires verdict."));
    errors.push(...validateSeverityCounts(value.severityCounts, "/severityCounts"));
    if (!Array.isArray(value.findings)) errors.push(schemaError("/findings", "validation output requires findings array."));
    else errors.push(...validateFindings(value.findings, "/findings"));
    if (!Array.isArray(value.checks)) errors.push(schemaError("/checks", "validation output requires checks array."));
    else errors.push(...validateChecks(value.checks, "/checks"));
  }
  if (contract === "implementation") {
    if (!Array.isArray(value.changedFiles) || !value.changedFiles.every((item) => typeof item === "string" && isSafeRelativePath(item))) {
      errors.push(schemaError("/changedFiles", "implementation output requires changedFiles safe relative path array."));
    }
    if (!Array.isArray(value.checks)) errors.push(schemaError("/checks", "implementation output requires checks array."));
    else errors.push(...validateChecks(value.checks, "/checks"));
  }
  if (contract === "decision") {
    if (typeof value.route !== "string") errors.push(schemaError("/route", "decision output requires route string."));
  }
  if (contract === "discover") {
    const outputKey = options.outputKey || "items";
    const items = value[outputKey];
    if (!Array.isArray(items)) errors.push(schemaError(pointerJoin("", outputKey), "discover output requires " + outputKey + " array."));
    else {
      if (typeof options.maxItems === "number" && items.length > options.maxItems) errors.push(schemaError(pointerJoin("", outputKey), "discover output exceeded max item limit (" + options.maxItems + ")."));
      errors.push(...validateDiscoveredItems(items, pointerJoin("", outputKey)));
    }
  }
  if (contract === "summarize") {
    if (!["success", "success_with_warnings", "blocked", "failed", "unknown"].includes(value.finalVerdict)) errors.push(schemaError("/finalVerdict", "summarize output requires finalVerdict."));
    for (const field of ["deliverables", "changedFiles", "warnings", "risks", "nextActions"]) {
      if (!Array.isArray(value[field]) || !value[field].every((item) => typeof item === "string")) {
        errors.push(schemaError(pointerJoin("", field), "summarize output requires " + field + " string array."));
      }
    }
    if (!Array.isArray(value.checks)) errors.push(schemaError("/checks", "summarize output requires checks array."));
    else errors.push(...validateChecks(value.checks, "/checks"));
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

function validateArtifacts(artifacts, basePath) {
  const errors = [];
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    const itemPath = pointerJoin(basePath, index);
    if (!isPlainObject(artifact)) {
      errors.push(schemaError(itemPath, "artifact entries must be objects."));
      continue;
    }
    for (const field of ["kind", "path", "url", "label"]) {
      if (artifact[field] !== undefined && typeof artifact[field] !== "string") errors.push(schemaError(pointerJoin(itemPath, field), "artifact." + field + " must be a string when present."));
    }
    if (artifact.path !== undefined && !isSafeRelativePath(artifact.path)) errors.push(schemaError(pointerJoin(itemPath, "path"), "artifact.path must stay inside cwd."));
  }
  return errors;
}

function validateSeverityCounts(value, basePath) {
  const errors = [];
  if (!isPlainObject(value)) return [schemaError(basePath, "validation output requires severityCounts.")];
  for (const field of ["P0", "P1", "P2", "P3"]) {
    if (!Number.isInteger(value[field]) || value[field] < 0) errors.push(schemaError(pointerJoin(basePath, field), "severityCounts." + field + " must be a non-negative integer."));
  }
  return errors;
}

function validateFindings(findings, basePath) {
  const errors = [];
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    const itemPath = pointerJoin(basePath, index);
    if (!isPlainObject(finding)) {
      errors.push(schemaError(itemPath, "finding entries must be objects."));
      continue;
    }
    if (!["P0", "P1", "P2", "P3"].includes(finding.severity)) errors.push(schemaError(pointerJoin(itemPath, "severity"), "finding.severity must be P0, P1, P2, or P3."));
    if (typeof finding.summary !== "string") errors.push(schemaError(pointerJoin(itemPath, "summary"), "finding.summary must be a string."));
    if (finding.path !== undefined && typeof finding.path !== "string") errors.push(schemaError(pointerJoin(itemPath, "path"), "finding.path must be a string when present."));
    if (finding.path !== undefined && !isSafeRelativePath(finding.path)) errors.push(schemaError(pointerJoin(itemPath, "path"), "finding.path must stay inside cwd."));
    if (finding.details !== undefined && typeof finding.details !== "string") errors.push(schemaError(pointerJoin(itemPath, "details"), "finding.details must be a string when present."));
  }
  return errors;
}

function validateDiscoveredItems(items, basePath) {
  const errors = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const itemPath = pointerJoin(basePath, index);
    if (typeof item === "string" && !isSafeRelativePath(item)) errors.push(schemaError(itemPath, "discovered string path item must stay inside cwd."));
    if (isPlainObject(item) && item.path !== undefined && (typeof item.path !== "string" || !isSafeRelativePath(item.path))) errors.push(schemaError(pointerJoin(itemPath, "path"), "discovered item.path must stay inside cwd."));
  }
  return errors;
}

function validateChecks(checks, basePath) {
  const errors = [];
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    const itemPath = pointerJoin(basePath, index);
    if (!isPlainObject(check)) {
      errors.push(schemaError(itemPath, "check entries must be objects."));
      continue;
    }
    if (check.command !== undefined && typeof check.command !== "string") errors.push(schemaError(pointerJoin(itemPath, "command"), "check.command must be a string when present."));
    if (check.name !== undefined && typeof check.name !== "string") errors.push(schemaError(pointerJoin(itemPath, "name"), "check.name must be a string when present."));
    if (!["pass", "fail", "skipped", "unknown"].includes(check.status)) errors.push(schemaError(pointerJoin(itemPath, "status"), "check.status must be pass, fail, skipped, or unknown."));
    if (check.summary !== undefined && typeof check.summary !== "string") errors.push(schemaError(pointerJoin(itemPath, "summary"), "check.summary must be a string when present."));
  }
  return errors;
}

function parseBlocked(summary, text, errorCode, diagnostics) {
  return {
    status: "blocked",
    summary,
    artifacts: [],
    nextFocus: "format repair or manual correction",
    blockedReason: errorCode,
    rawTextSnippet: String(text || "").slice(0, 4000),
    parseDiagnostics: diagnostics,
    metadata: { repairAttempts: 0, agentCallsUsed: 1 }
  };
}

function formatRepairPrompt(output, contract) {
  const diagnostics = output?.parseDiagnostics;
  return [
    "Your previous response could not be parsed as the required workflow-output JSON.",
    "Do not redo the task. Emit exactly one fenced JSON block tagged workflow-output that satisfies the " + contract + " contract.",
    "",
    "Blocked reason: " + (output?.blockedReason ?? "unknown"),
    "Parse summary: " + (output?.summary ?? "unknown"),
    "",
    "Parse diagnostics:",
    formatParseDiagnosticsForPrompt(diagnostics),
    "",
    "Previous raw text snippet:",
    output?.rawTextSnippet ?? ""
  ].join("\\n");
}

function formatParseDiagnosticsForPrompt(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") return "- unavailable";
  const lines = [
    "- errorCode: " + (diagnostics.errorCode ?? "unknown"),
    "- candidateCount: " + (diagnostics.candidateCount ?? 0),
    "- bestCandidateId: " + (diagnostics.bestCandidateId ?? "none"),
    "- recoverability: " + (diagnostics.recoverability ?? "unknown")
  ];
  const candidates = Array.isArray(diagnostics.candidates) ? diagnostics.candidates.slice(0, 4) : [];
  for (const candidate of candidates) {
    lines.push("- candidate " + candidate.id + ": mode=" + candidate.mode + ", syntax=" + candidate.syntax + ", wrapper=" + candidate.wrapper + ", unwrapped=" + Boolean(candidate.unwrapped));
    if (candidate.parseError) lines.push("  parseError: " + preview(candidate.parseError, 300));
    const errors = Array.isArray(candidate.schemaErrors) ? candidate.schemaErrors.slice(0, 8) : [];
    for (const error of errors) {
      lines.push("  schemaError " + (error.path || "") + ": " + error.message);
    }
  }
  return lines.join("\\n");
}

function isRepairableOutputFailure(output) {
  return REPAIRABLE_OUTPUT_REASONS.includes(output?.blockedReason)
    && (output?.metadata?.repairAttempts ?? 0) === 0
    && output?.parseDiagnostics?.recoverability === "repairable";
}

function markRepairResult(repaired) {
  if (!repaired || typeof repaired !== "object") return repaired;
  const metadata = { ...(isPlainObject(repaired.metadata) ? repaired.metadata : {}), repairAttempts: 1 };
  if (REPAIRABLE_OUTPUT_REASONS.includes(repaired.blockedReason)) {
    const diagnostics = isPlainObject(repaired.parseDiagnostics)
      ? { ...repaired.parseDiagnostics, errorCode: "OUTPUT_REPAIR_FAILED", summary: "Output repair failed: " + (repaired.parseDiagnostics.summary ?? repaired.summary ?? "unknown") }
      : repaired.parseDiagnostics;
    return {
      ...repaired,
      blockedReason: "OUTPUT_REPAIR_FAILED",
      summary: "Output repair failed: " + (repaired.summary ?? "repair did not produce a valid workflow-output block"),
      parseDiagnostics: diagnostics,
      metadata
    };
  }
  return { ...repaired, metadata };
}

function createParseDiagnostics(options) {
  const candidates = options.candidates.map((candidate) => diagnosticCandidate(candidate));
  const best = selectBestDiagnosticCandidate(options.candidates);
  return {
    errorCode: options.errorCode,
    summary: options.summary,
    candidateCount: candidates.length,
    candidates,
    bestCandidateId: best?.id,
    recoverability: options.recoverability,
    rawSnippetHash: hashText(options.rawText || ""),
    warnings: options.warnings || []
  };
}

function diagnosticCandidate(candidate) {
  return {
    id: candidate.id,
    mode: candidate.mode,
    syntax: candidate.syntax,
    rawSnippetHash: candidate.rawSnippetHash,
    rawSnippetPreview: candidate.rawSnippetPreview,
    unwrapped: Boolean(candidate.unwrapped),
    wrapper: candidate.wrapper || "none",
    parseError: candidate.parseError,
    schemaErrors: Array.isArray(candidate.schemaErrors) ? candidate.schemaErrors : []
  };
}

function selectBestDiagnosticCandidate(candidates) {
  if (!candidates.length) return undefined;
  return [...candidates].sort((left, right) => {
    const leftSyntax = left.syntax === "validJson" || left.syntax === "repairedJson" ? 0 : 1;
    const rightSyntax = right.syntax === "validJson" || right.syntax === "repairedJson" ? 0 : 1;
    if (leftSyntax !== rightSyntax) return leftSyntax - rightSyntax;
    const leftErrors = Array.isArray(left.schemaErrors) ? left.schemaErrors.length : 999;
    const rightErrors = Array.isArray(right.schemaErrors) ? right.schemaErrors.length : 999;
    if (leftErrors !== rightErrors) return leftErrors - rightErrors;
    const leftMode = left.mode === "workflowOutputFence" ? 0 : 1;
    const rightMode = right.mode === "workflowOutputFence" ? 0 : 1;
    if (leftMode !== rightMode) return leftMode - rightMode;
    return (left.start ?? 0) - (right.start ?? 0);
  })[0];
}

function selectBestValidCandidate(candidates) {
  return [...candidates].sort((left, right) => {
    const leftMode = left.mode === "workflowOutputFence" ? 0 : 1;
    const rightMode = right.mode === "workflowOutputFence" ? 0 : 1;
    if (leftMode !== rightMode) return leftMode - rightMode;
    return (left.start ?? 0) - (right.start ?? 0);
  })[0];
}

function schemaError(path, message) {
  return { path, message };
}

function pointerJoin(base, key) {
  return String(base || "") + "/" + String(key).replace(/~/g, "~0").replace(/\//g, "~1");
}

function isSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (path.isAbsolute(value)) return false;
  const normalized = path.normalize(value).replace(/\\\\/g, "/");
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../");
}

function looksLikeJsonObject(value) {
  const text = String(value || "").trim();
  return text.startsWith("{") && text.endsWith("}");
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function preview(value, maxChars) {
  const text = String(value || "");
  return text.length > maxChars ? text.slice(0, maxChars).trimEnd() + "\\n... [truncated]" : text;
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  if (isPlainObject(value)) {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
`;
