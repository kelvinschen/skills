import fs from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import { runDir } from "./paths.js";

export type AttemptStatus =
  | "pending"
  | "running"
  | "raw_received"
  | "parsing"
  | "repairing"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "timed_out";

export type StageStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "skipped";

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "diagnosed_blocked"
  | "failed"
  | "cancelled";

export type AttemptIndexEntry = {
  id: string;
  stageId: string;
  itemId?: string;
  kind: "attempt" | "repair" | "diagnostic";
  status: AttemptStatus;
  path: string;
  startedAt?: string;
  endedAt?: string;
  blockedReason?: string;
  parseErrorCode?: string;
  rawPreview?: string;
  promptPreview?: string;
};

export type StageIndexEntry = {
  stageId: string;
  status: StageStatus;
  attempts: string[];
  outputPath?: string;
  blockedReason?: string;
  startedAt?: string;
  completedAt?: string;
  skippedReason?: string;
  fanout?: {
    totalItems: number;
    completedItems: number;
    blockedItems: number;
    allowPartial: boolean;
    items: Array<{
      id: string;
      index: number;
      status: StageStatus;
      outputPath?: string;
      blockedReason?: string;
    }>;
  };
};

export type RunIndex = {
  schemaVersion: "acpx-orchestrator.run/v2";
  logicalRunId: string;
  workflowName: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  source?: {
    kind: "draft" | "saved" | "spec";
    path?: string;
    sha256?: string;
  };
  stages: Record<string, StageIndexEntry>;
  attempts: Record<string, AttemptIndexEntry>;
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
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as RunIndex;
  return {
    ...parsed,
    schemaVersion: parsed.schemaVersion ?? "acpx-orchestrator.run/v2",
    stages: parsed.stages ?? {},
    attempts: parsed.attempts ?? {}
  };
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
