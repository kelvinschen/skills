import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { startAcpxFlow } from "../acpx/run-flow.js";
import { issue, resultFromIssues, type OrchestratorIssue } from "../errors.js";
import { resolveRunLocator } from "../run-index/locator.js";
import { runDir } from "../run-index/paths.js";
import { appendEvent, readRunIndex, writeRunIndex, type RunIndex } from "../run-index/read-write.js";
import { localizeResumePolicyForSegment, mergeResumePolicy, parseResumePolicyOptions, validateResumePolicy, type ResumePolicy } from "../runtime/resume-policy.js";
import { syncRun } from "../runtime/sync.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../schema/workflow-spec.js";
import { printIssues, printJson } from "./common.js";

export function registerResume(program: Command): void {
  program.command("resume")
    .argument("<run>", "logical run id or run directory")
    .option("--timeout-seconds <seconds>", "override acpx process timeout for this resumed segment")
    .option("--allow-partial-fanout <stage...>", "allow partial results for read-only fanout stage(s) on resume")
    .option("--max-fanout-items <stage=count...>", "tighten max fanout items for stage(s), bounded by the compiled snapshot")
    .option("--skip-fanout-item <stage=index...>", "skip zero-based fanout item index(es) on resume")
    .option("--wait", "wait until the resumed segment finishes")
    .option("--json", "print JSON")
    .action(async (runArg: string, options: { timeoutSeconds?: string; allowPartialFanout?: string[]; maxFanoutItems?: string[]; skipFanoutItem?: string[]; wait?: boolean; json?: boolean }) => {
      const locator = await resolveRunLocator(runArg);
      const index = await readRunIndex(locator.cwd, locator.runId);
      const failedIndex = index.segments.findIndex((segment) => segment.status === "failed" && segment.purpose !== "diagnostic");
      if (failedIndex < 0) {
        printResumeIssues(options.json, [{
          code: "RESUME_NO_FAILED_SEGMENT",
          severity: "error",
          path: "/segments",
          message: "No failed workflow batch is eligible for resume.",
          suggestions: ["Use diagnose for blocked runs or start a new run after editing the spec."]
        }]);
        process.exitCode = 2;
        return;
      }
      const spec = await readRunSpec(locator.cwd, locator.runId);
      const parsedPolicy = parseResumePolicyOptions(options);
      const policyIssues = [
        ...parsedPolicy.issues,
        ...validateResumePolicy(spec, parsedPolicy.policy)
      ];
      if (policyIssues.some((entry) => entry.severity !== "warning")) {
        printResumeIssues(options.json, policyIssues);
        process.exitCode = 2;
        return;
      }
      if (workflowHasEditRole(spec)) {
        printResumeIssues(options.json, [{
          code: "RESUME_EDIT_WORKFLOW_REFUSED",
          severity: "error",
          path: "/roles",
          message: "Resume refused: workflow contains edit-capable roles.",
          suggestions: ["Use diagnose for recovery advice, then start a new run if edits are needed."]
        }]);
        process.exitCode = 2;
        return;
      }
      const segment = index.segments[failedIndex];
      const resumePolicy = parsedPolicy.policy;
      if (Object.keys(resumePolicy.fanout).length > 0) {
        await updateSegmentInputRuntimePolicy(segment.input, localizeResumePolicyForSegment(resumePolicy, segment));
      }
      const timeout = options.timeoutSeconds ? Number(options.timeoutSeconds) : undefined;
      const started = await startAcpxFlow({
        cwd: locator.cwd,
        flowPath: segment.materializedFlow,
        inputPath: segment.input,
        approveAll: true,
        acpxTimeoutSeconds: Number.isFinite(timeout) && timeout && timeout > 0 ? timeout : undefined
      });
      const segments = [...index.segments];
      segments[failedIndex] = {
        ...segment,
        status: "running",
        acpxRunId: started.acpxRunId,
        acpxRunDir: started.acpxRunDir
      };
      const next: RunIndex = { ...index, status: "running", segments };
      await writeRunIndex(locator.cwd, next);
      await appendEvent(locator.cwd, locator.runId, {
        type: "segment_resumed",
        segmentId: segment.segmentId,
        resumePolicy,
        acpxRunId: started.acpxRunId,
        acpxRunDir: started.acpxRunDir,
        logPath: started.logPath
      });
      const finalIndex = options.wait ? await waitForResume(locator.cwd, locator.runId, segment.segmentId) : next;
      const output = {
        ok: true,
        runId: locator.runId,
        status: finalIndex.status,
        segment: finalIndex.segments.find((candidate) => candidate.segmentId === segment.segmentId),
        message: options.wait ? "Resume segment finished." : "Resume segment started."
      };
      if (options.json) printJson(output);
      else process.stdout.write(`${output.message}\n`);
    });
}

async function updateSegmentInputRuntimePolicy(inputPath: string, resumePolicy: ResumePolicy): Promise<void> {
  const input = JSON.parse(await fs.readFile(inputPath, "utf8")) as Record<string, unknown>;
  const runtime = input.runtime && typeof input.runtime === "object" ? input.runtime as Record<string, unknown> : {};
  input.runtime = {
    ...runtime,
    resumePolicy: mergeResumePolicy(runtime.resumePolicy, resumePolicy)
  };
  await fs.writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
}

async function readRunSpec(cwd: string, runId: string): Promise<WorkflowSpec> {
  const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.join(runDir(runId, cwd), "workflow.spec.json"), "utf8")));
  return spec;
}

function workflowHasEditRole(spec: WorkflowSpec): boolean {
  return Object.values(spec.roles).some((role) => role.mode === "edit");
}

function printResumeIssues(json: boolean | undefined, issues: OrchestratorIssue[]): void {
  const result = resultFromIssues("resume", issues.map(issue));
  if (json) printJson(result);
  else printIssues(result);
}

async function waitForResume(cwd: string, runId: string, segmentId: string) {
  while (true) {
    const index = await syncRun(cwd, runId);
    const segment = index.segments.find((candidate) => candidate.segmentId === segmentId);
    if (segment && segment.status !== "pending" && segment.status !== "running") return index;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
