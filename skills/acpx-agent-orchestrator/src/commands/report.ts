import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { runViewFromIndex } from "../projections/run-view.js";
import { renderMarkdownReport } from "../reports/markdown.js";
import { resolveRunLocator } from "../run-index/locator.js";
import { runDir } from "../run-index/paths.js";
import { syncRun } from "../runtime/sync.js";
import { printJson } from "./common.js";
import { WorkflowSpecSchema } from "../schema/workflow-spec.js";

export function registerReport(program: Command): void {
  program.command("report")
    .requiredOption("--run <id-or-dir>", "logical run id or run directory")
    .option("--output <path>", "report output path")
    .option("--json", "print JSON RunView")
    .action(async (options: { run: string; output?: string; json?: boolean }) => {
      const locator = await resolveRunLocator(options.run);
      const dir = runDir(locator.runId, locator.cwd);
      const run = await syncRun(locator.cwd, locator.runId);
      const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.join(dir, "workflow.spec.json"), "utf8")));
      const view = await runViewFromIndex(locator.cwd, spec, run);
      if (options.json) {
        printJson(view);
        return;
      }
      const markdown = renderMarkdownReport(view);
      if (options.output) {
        await fs.writeFile(options.output, markdown, "utf8");
        process.stdout.write(`report written: ${options.output}\n`);
      } else {
        process.stdout.write(markdown);
      }
    });
}
