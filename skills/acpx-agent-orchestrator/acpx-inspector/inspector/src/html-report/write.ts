import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { renderReportHtml } from "./render.js";
import type { ReportModel } from "../types.js";

export async function writeReport(model: ReportModel, outputPath: string, open = false): Promise<string> {
  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, renderReportHtml(model), "utf8");
  if (open) {
    openFile(resolved);
  }
  return resolved;
}

function openFile(filePath: string): void {
  const url = pathToFileURL(filePath).href;
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}
