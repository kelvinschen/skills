import { execFileSync } from "node:child_process";
import * as path from "node:path";

export type SeverityCounts = {
  P0: number;
  P1: number;
  P2: number;
  P3: number;
};

export type HandoffInput = {
  cwd: string;
  handoffDir: string;
};

export type FlowState = {
  runId: string;
};

export type HandoffRef = {
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

export type HandoffSummary = Omit<HandoffRef, "responseText">;

export function profileAgent(profile: string, field: string): string {
  if (!profile.trim()) {
    throw new Error(`Flow profile \`${field}\` must be a non-empty string.`);
  }
  return profile.trim();
}

export function repoRoot(cwd: string): string {
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

export function normalizeHandoffDir(value: unknown, cwd: string): string {
  if (typeof value === "string" && value.trim()) {
    const raw = value.trim();
    return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  }
  return path.join(repoRoot(cwd), "tmp", "flow_handoffs");
}

export function handoffRoot(input: HandoffInput, state: FlowState): string {
  return path.join(input.handoffDir, state.runId);
}

export function expectedHandoffPath(input: HandoffInput, state: FlowState, node: string): string {
  return path.join(handoffRoot(input, state), `${node.replace(/[^a-z0-9_-]/gi, "_")}.md`);
}

export function flowMemoryPath(input: HandoffInput, state: FlowState): string {
  return path.join(handoffRoot(input, state), "flow-memory.md");
}

export function compactText(text: string, maxChars = 1800): string {
  const value = text.trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n... [已截断；查看 flow run 或 handoff file 获取完整细节]`;
}

export function compactTailText(text: string, maxChars = 1200): string {
  const value = text.trim();
  if (value.length <= maxChars) return value;
  return `[已截断；查看 flow memory 或 handoff file 获取完整细节]\n${value.slice(-maxChars).trimStart()}`;
}

export function markerValue(text: string, marker: string): string {
  const match = text.match(new RegExp(`^\\s*${marker}:\\s*(.+?)\\s*$`, "im"));
  return match?.[1]?.trim() || "";
}

export function parseSeverityCounts(text: string): SeverityCounts {
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

export function asHandoff(value: unknown): HandoffRef | null {
  if (value && typeof value === "object" && "responseText" in value) {
    return value as HandoffRef;
  }
  return null;
}

function nextFocus(text: string): string {
  const match = text.match(/(?:next focus|next steps?|handoff)\s*:?\s*([\s\S]{1,800})/i);
  return compactText(match?.[1] || text, 600);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function inferHandoffPath(text: string, input: HandoffInput, state: FlowState): string | undefined {
  const root = handoffRoot(input, state);
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

export function parseHandoff(node: string, text: string, input: HandoffInput, state: FlowState, options: {
  verdict?: string;
  includeSeverity?: boolean;
} = {}): HandoffRef {
  const responseText = text.trim();
  const summary = markerValue(text, "HANDOFF_SUMMARY") || compactTailText(responseText);
  return {
    node,
    responseText,
    memoryFile: flowMemoryPath(input, state),
    handoffPath: inferHandoffPath(text, input, state),
    summaryPreview: compactText(summary),
    nextFocus: nextFocus(summary),
    rawChars: responseText.length,
    verdict: options.verdict,
    severityCounts: options.includeSeverity ? parseSeverityCounts(text) : undefined,
  };
}

export function handoffSummary(value: unknown): HandoffSummary | null {
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

export function handoffIndex(outputs: Record<string, unknown>, keys: string[]): Record<string, HandoffSummary> {
  const index: Record<string, HandoffSummary> = {};
  for (const key of keys) {
    const ref = handoffSummary(outputs[key]);
    if (ref) index[key] = ref;
  }
  return index;
}

export function handoffBlock(items: Array<[string, unknown]>, intro: string): string {
  const body = items.map(([label, value]) => {
    const ref = asHandoff(value);
    if (!ref) return `${label}: (缺失)`;
    const severity = ref.severityCounts
      ? `\n- severity: P0=${ref.severityCounts.P0} P1=${ref.severityCounts.P1} P2=${ref.severityCounts.P2} P3=${ref.severityCounts.P3}`
      : "";
    return `${label}:
- flow memory: ${ref.memoryFile}
- handoff: ${ref.handoffPath || "(未指定；需要时读取 flow memory entry 和 session tail)"}
- verdict: ${ref.verdict || "n/a"}${severity}
- summary preview:
${ref.summaryPreview || "(空)"}
- next focus:
${ref.nextFocus || "(未指定)"}
- raw response chars: ${ref.rawChars}`;
  }).join("\n\n");
  return `${intro}\n\n${body}`;
}

export function routeOf(value: unknown): string {
  if (value && typeof value === "object" && "route" in value) {
    return String((value as { route?: unknown }).route || "");
  }
  return "";
}
