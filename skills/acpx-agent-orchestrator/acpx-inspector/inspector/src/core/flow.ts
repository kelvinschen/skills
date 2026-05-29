import fs from "node:fs/promises";
import path from "node:path";
import { flowsRunsDir } from "./state-dir.js";
import { isObject } from "./util.js";

export type FlowBundle = {
  runId: string;
  runDir: string;
  manifest?: unknown;
  run?: unknown;
  live?: unknown;
  steps?: unknown;
  traceEvents: unknown[];
  warnings: string[];
};

export async function readFlowBundle(options: {
  stateDir?: string;
  runId?: string;
  runDir?: string;
}): Promise<FlowBundle> {
  const runDir = options.runDir
    ? path.resolve(options.runDir)
    : path.join(flowsRunsDir(options.stateDir), options.runId ?? "");
  const runId = options.runId ?? path.basename(runDir);
  const warnings: string[] = [];
  const [manifest, run, live, steps, traceEvents] = await Promise.all([
    readJson(path.join(runDir, "manifest.json"), warnings),
    readJson(path.join(runDir, "projections", "run.json"), warnings),
    readJson(path.join(runDir, "projections", "live.json"), warnings),
    readJson(path.join(runDir, "projections", "steps.json"), warnings),
    readNdjson(path.join(runDir, "trace.ndjson"), warnings),
  ]);
  return { runId, runDir, manifest, run, live, steps, traceEvents, warnings };
}

async function readJson(filePath: string, warnings: string[]): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`failed to read ${filePath}: ${String(error)}`);
    }
    return undefined;
  }
}

async function readNdjson(filePath: string, warnings: string[]): Promise<unknown[]> {
  try {
    const lines = (await fs.readFile(filePath, "utf8")).split("\n").filter(Boolean);
    return lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        warnings.push(`invalid JSON line in ${filePath}`);
        return [];
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`failed to read ${filePath}: ${String(error)}`);
    }
    return [];
  }
}

export function flowStatus(bundle: FlowBundle): string {
  const run = isObject(bundle.run) ? bundle.run : isObject(bundle.live) ? bundle.live : undefined;
  const status = run && typeof run.status === "string" ? run.status : undefined;
  return status ?? "unknown";
}
