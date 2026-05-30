import fs from "node:fs/promises";
import path from "node:path";

export type AcpxFlowRunProjection = {
  runId: string;
  flowName: string;
  flowPath: string;
  status: "pending" | "running" | "completed" | "failed" | "timed_out" | string;
  outputs?: Record<string, unknown>;
  steps?: Array<{
    nodeId: string;
    nodeType: string;
    outcome: string;
    output?: unknown;
  }>;
  results?: Record<string, {
    nodeId: string;
    nodeType: string;
    outcome: string;
    output?: unknown;
    error?: string;
  }>;
  error?: string;
};

export async function readFlowResult(runDir: string): Promise<AcpxFlowRunProjection | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(runDir, "projections", "run.json"), "utf8")) as AcpxFlowRunProjection;
  } catch {
    return undefined;
  }
}
