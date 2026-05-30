import fs from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import { runDir } from "./paths.js";
import type { RunViewStatus } from "../projections/run-view.js";

export type RunIndex = {
  logicalRunId: string;
  workflowName: string;
  status: RunViewStatus;
  createdAt: string;
  updatedAt: string;
  source?: {
    kind: "draft" | "saved" | "spec";
    path?: string;
    sha256?: string;
  };
  segments: Array<{
    segmentId: string;
    purpose?: "workflow" | "fanout-batch" | "diagnostic";
    status: RunViewStatus;
    materializedFlow: string;
    input: string;
    acpxRunId?: string;
    acpxRunDir?: string;
    fanoutStageId?: string;
    batchIndex?: number;
    itemStart?: number;
    itemCount?: number;
  }>;
  agentUsage: {
    planned: number;
    actual: number;
    repairCalls: number;
    recoveryCalls: number;
  };
  finalVerdict?: "success" | "success_with_warnings" | "blocked" | "failed" | "unknown";
  blockedReason?: string;
};

export async function writeRunIndex(cwd: string, index: RunIndex): Promise<void> {
  const dir = runDir(index.logicalRunId, cwd);
  await fs.mkdir(dir, { recursive: true });
  const release = await lock(dir, { retries: 3, realpath: false });
  try {
    const filePath = path.join(dir, "run.json");
    const tmpPath = `${filePath}.tmp`;
    const updated = { ...index, updatedAt: new Date().toISOString() };
    await fs.writeFile(tmpPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, filePath);
  } finally {
    await release();
  }
}

export async function readRunIndex(cwd: string, logicalRunId: string): Promise<RunIndex> {
  const filePath = path.join(runDir(logicalRunId, cwd), "run.json");
  return JSON.parse(await fs.readFile(filePath, "utf8")) as RunIndex;
}

export async function appendEvent(cwd: string, logicalRunId: string, event: Record<string, unknown>): Promise<void> {
  const dir = runDir(logicalRunId, cwd);
  await fs.mkdir(dir, { recursive: true });
  const release = await lock(dir, { retries: 3, realpath: false });
  try {
    await fs.appendFile(path.join(dir, "events.ndjson"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
  } finally {
    await release();
  }
}
