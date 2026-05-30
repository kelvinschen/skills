import fs from "node:fs/promises";
import path from "node:path";
import { startAcpxFlow } from "../acpx/run-flow.js";
import { outputParserHelperSource } from "../compiler/output-parser-helper.js";
import { runDir } from "../run-index/paths.js";
import { appendEvent, readRunIndex, writeRunIndex, type RunIndex } from "../run-index/read-write.js";
import { WorkflowSpecSchema, type Role } from "../schema/workflow-spec.js";

export async function startDiagnosticRun(cwd: string, logicalRunId: string): Promise<RunIndex> {
  const index = await readRunIndex(cwd, logicalRunId);
  const dir = runDir(logicalRunId, cwd);
  const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.join(dir, "workflow.spec.json"), "utf8")));
  const role = recoveryRole(spec.roles);
  const segmentId = `diagnostic-${index.segments.filter((segment) => segment.purpose === "diagnostic").length + 1}`;
  const segmentDir = path.join(dir, "segments", segmentId);
  await fs.mkdir(segmentDir, { recursive: true });

  const runSnapshot = JSON.parse(await fs.readFile(path.join(dir, "run.json"), "utf8")) as RunIndex;
  const outputs = await readExistingOutputs(dir);
  const prompt = diagnosticPrompt({ workflowName: spec.name, runSnapshot, outputs });
  const flowPath = path.join(segmentDir, "materialized.flow.ts");
  const inputPath = path.join(segmentDir, "input.json");
  await fs.writeFile(flowPath, diagnosticFlowSource(spec.name, role), "utf8");
  await fs.writeFile(inputPath, `${JSON.stringify({
    workflowInput: await readOriginalWorkflowInput(dir),
    prompt,
    runtime: { logicalRunId, segmentId }
  }, null, 2)}\n`, "utf8");

  const started = await startAcpxFlow({
    cwd,
    flowPath,
    inputPath,
    approveAll: true
  });
  const next: RunIndex = {
    ...index,
    segments: [
      ...index.segments,
      {
        segmentId,
        purpose: "diagnostic",
        status: "running",
        materializedFlow: flowPath,
        input: inputPath,
        acpxRunId: started.acpxRunId,
        acpxRunDir: started.acpxRunDir
      }
    ]
  };
  await writeRunIndex(cwd, next);
  await appendEvent(cwd, logicalRunId, {
    type: "diagnostic_started",
    segmentId,
    acpxRunId: started.acpxRunId,
    acpxRunDir: started.acpxRunDir,
    logPath: started.logPath
  });
  return next;
}

function recoveryRole(roles: Record<string, Role>): Role {
  return roles.recovery_reviewer
    ?? Object.values(roles).find((role) => role.category === "validation" || role.category === "review")
    ?? { category: "review", agent: "aiden", mode: "readOnly" };
}

async function readOriginalWorkflowInput(dir: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "input.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readExistingOutputs(dir: string): Promise<Record<string, unknown>> {
  const outputDir = path.join(dir, "outputs");
  const outputs: Record<string, unknown> = {};
  try {
    const entries = await fs.readdir(outputDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      outputs[path.basename(entry, ".json")] = JSON.parse(await fs.readFile(path.join(outputDir, entry), "utf8"));
    }
  } catch {
    // No outputs yet.
  }
  return outputs;
}

function diagnosticPrompt(input: { workflowName: string; runSnapshot: RunIndex; outputs: Record<string, unknown> }): string {
  return `You are the recovery reviewer for a blocked acpx-orchestrator workflow.

Workflow: ${input.workflowName}

Run snapshot:
\`\`\`json
${JSON.stringify(input.runSnapshot, null, 2)}
\`\`\`

Author stage outputs:
\`\`\`json
${JSON.stringify(input.outputs, null, 2)}
\`\`\`

Diagnose why the run is blocked and recommend the smallest safe recovery plan. Do not edit files. Do not rerun prior edit work.

End the response with one fenced JSON block tagged workflow-output:
\`\`\`workflow-output
{
  "status": "completed",
  "summary": "diagnosis summary",
  "artifacts": [],
  "nextFocus": "recommended recovery focus",
  "data": {
    "blockedCause": "short cause",
    "recoveryAdvice": ["step 1"],
    "requiresNewRun": true
  }
}
\`\`\``;
}

function diagnosticFlowSource(workflowName: string, role: Role): string {
  return `import { acp, defineFlow } from "acpx/flows";
import crypto from "node:crypto";
import path from "node:path";

${outputParserHelperSource()}

export default defineFlow({
  name: ${JSON.stringify(`${workflowName}-diagnostic`)},
  startAt: "recovery_diagnostic",
  nodes: {
    recovery_diagnostic: acp({
      profile: ${JSON.stringify(role.agent)},
      session: { handle: "recovery_reviewer" },
      cwd: ({ input }) => input?.workflowInput?.cwd ?? process.cwd(),
      timeoutMs: 30 * 60 * 1000,
      statusDetail: "Running recovery diagnostic",
      prompt: ({ input }) => input.prompt,
      parse: (text) => extractWorkflowOutput(text, "diagnostic", null)
    })
  },
  edges: []
});
`;
}
