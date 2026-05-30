import type { RunView } from "../projections/run-view.js";

export function renderMarkdownReport(view: RunView): string {
  const lines = [
    `# ${view.workflowName}`,
    "",
    `- Status: ${view.status}`,
    view.finalVerdict ? `- Final verdict: ${view.finalVerdict}` : undefined,
    `- Planned agent calls: ${view.agentUsage.planned}`,
    view.agentUsage.actual !== undefined ? `- Actual agent calls: ${view.agentUsage.actual}` : undefined,
    "",
    "## Summary",
    "",
    view.summary || "(no summary)",
    "",
    "## Warnings",
    "",
    ...(view.warnings.length > 0 ? view.warnings.map((warning) => `- ${warning.code}: ${warning.message}`) : ["- None"]),
    "",
    "## Final Warnings",
    "",
    ...(view.finalWarnings.length > 0 ? view.finalWarnings.map((warning) => `- ${warning}`) : ["- None"]),
    "",
    "## Residual Risk",
    "",
    ...(view.risks.length > 0 ? view.risks.map((risk) => `- ${risk}`) : ["- None"]),
    "",
    "## Checks",
    "",
    ...(view.checks.length > 0 ? view.checks.map((check) => `- ${check.name ?? check.command ?? "check"}: ${check.status ?? "unknown"}${check.summary ? ` - ${check.summary}` : ""}`) : ["- None"]),
    "",
    "## Stages",
    "",
    ...view.stages.map((stage) => `- ${stage.id} (${stage.kind})${stage.status ? ` status=${stage.status}` : ""}${stage.dependsOn.length ? ` depends on ${stage.dependsOn.join(", ")}` : ""}${stage.summary ? ` - ${stage.summary}` : ""}`),
    "",
    "## Roles",
    "",
    ...view.roles.map((role) => `- ${role.name}: ${role.agent} (${role.category}, ${role.mode})`)
  ].filter((line): line is string => line !== undefined);
  return `${lines.join("\n")}\n`;
}
