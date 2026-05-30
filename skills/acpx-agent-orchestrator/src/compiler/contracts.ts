import type { Role, Stage } from "../schema/workflow-spec.js";

export type OutputContractName = "base" | "implementation" | "validation" | "decision" | "discover" | "summarize";

export function contractNameForStage(stage: Stage, role?: Role): OutputContractName {
  if (stage.kind === "summarize") return "summarize";
  if (stage.kind === "decisionGate") return "decision";
  if (stage.kind === "discover") return "discover";
  if (role?.category === "implementation") return "implementation";
  if (role?.category === "validation" || role?.category === "review") return "validation";
  return "base";
}

export function contractText(name: OutputContractName): string {
  const common = [
    'Required common fields: status ("completed"|"blocked"), summary, artifacts, nextFocus.',
    "End the response with one fenced JSON block tagged workflow-output."
  ];
  if (name === "implementation") {
    return [...common, "Implementation fields: changedFiles, checks."].join("\n");
  }
  if (name === "validation") {
    return [...common, 'Validation fields: verdict ("pass"|"fix"|"blocked"|"unknown"), severityCounts, findings, checks.'].join("\n");
  }
  if (name === "summarize") {
    return [...common, 'Summarize fields: finalVerdict ("success"|"success_with_warnings"|"blocked"|"failed"|"unknown"), deliverables, changedFiles, checks, warnings, risks, nextActions.'].join("\n");
  }
  if (name === "decision") {
    return [...common, 'Decision fields: route (a declared route stage id or "blocked").'].join("\n");
  }
  if (name === "discover") {
    return [...common, "Discover fields: the declared output key must contain an array of discovered items."].join("\n");
  }
  return common.join("\n");
}

export function safetyFooter(stage: Stage, role?: Role): string {
  const mode = role?.mode ?? "readOnly";
  const lines = [
    "",
    "Workflow stage contract:",
    `- Stage id: ${stage.id}`,
    `- Role mode: ${mode}`,
    "- Keep work scoped to the provided cwd and workflow task.",
    "- Do not leak secrets or sensitive data in output.",
    "- Preserve unrelated user changes.",
    contractText(contractNameForStage(stage, role))
  ];
  if (mode === "readOnly" || mode === "denyAll") {
    lines.push("- Do not edit production files in this stage.");
  }
  if (mode === "edit") {
    lines.push("- Only edit files required by this stage. Avoid unrelated refactors.");
  }
  return lines.join("\n");
}
