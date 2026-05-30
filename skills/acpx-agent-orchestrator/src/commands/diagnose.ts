import type { Command } from "commander";
import { resolveRunLocator } from "../run-index/locator.js";
import { startDiagnosticRun } from "../runtime/diagnose-run.js";
import { syncRun } from "../runtime/sync.js";
import { printJson } from "./common.js";

export function registerDiagnose(program: Command): void {
  program.command("diagnose")
    .argument("<run>", "logical run id or run directory")
    .option("--wait", "wait until the diagnostic segment finishes")
    .option("--json", "print JSON")
    .action(async (runArg: string, options: { wait?: boolean; json?: boolean }) => {
      const locator = await resolveRunLocator(runArg);
      const started = await startDiagnosticRun(locator.cwd, locator.runId);
      const index = options.wait ? await waitForDiagnostic(locator.cwd, locator.runId) : started;
      const output = {
        ok: true,
        runId: locator.runId,
        status: index.status,
        segment: index.segments.at(-1),
        message: options.wait ? "Diagnostic segment finished." : "Diagnostic segment started."
      };
      if (options.json) printJson(output);
      else process.stdout.write(`${output.message}\n`);
    });
}

async function waitForDiagnostic(cwd: string, runId: string) {
  while (true) {
    const index = await syncRun(cwd, runId);
    const latest = index.segments.at(-1);
    if (latest?.purpose === "diagnostic" && latest.status !== "pending" && latest.status !== "running") return index;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
