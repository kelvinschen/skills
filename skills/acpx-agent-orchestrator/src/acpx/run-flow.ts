import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export type StartedAcpxFlow = {
  pid: number;
  logPath: string;
  acpxRunId?: string;
  acpxRunDir?: string;
};

export async function startAcpxFlow(options: {
  cwd: string;
  flowPath: string;
  inputPath: string;
  approveAll?: boolean;
  acpxTimeoutSeconds?: number;
}): Promise<StartedAcpxFlow> {
  let last: StartedAcpxFlow | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    last = await startAcpxFlowAttempt(options, attempt);
    if (last.acpxRunDir) return last;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last ?? { pid: 0, logPath: "" };
}

async function startAcpxFlowAttempt(options: {
  cwd: string;
  flowPath: string;
  inputPath: string;
  approveAll?: boolean;
  acpxTimeoutSeconds?: number;
}, attempt: number): Promise<StartedAcpxFlow> {
  const logPath = path.join(os.tmpdir(), `acpx-orchestrator-${path.basename(options.flowPath)}-${Date.now()}-${attempt}.log`);
  const fd = fs.openSync(logPath, "a");
  const startedAtMs = Date.now() - 1000;
  const args = [
    ...(options.acpxTimeoutSeconds ? ["--timeout", String(options.acpxTimeoutSeconds)] : []),
    ...(options.approveAll ? ["--approve-all"] : []),
    "flow",
    "run",
    options.flowPath,
    "--input-file",
    options.inputPath
  ];
  const child = spawn("acpx", args, {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", fd, fd]
  });
  child.unref();
  const found = await waitForRun(options.flowPath, startedAtMs, 15_000, logPath);
  return {
    pid: child.pid ?? 0,
    logPath,
    acpxRunId: found?.runId,
    acpxRunDir: found?.runDir
  };
}

function runsRoot(): string {
  return path.join(os.homedir(), ".acpx", "flows", "runs");
}

async function waitForRun(flowPath: string, earliestStartedAtMs: number, timeoutMs: number, logPath: string): Promise<{ runId: string; runDir: string } | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const fromLog = await findRunInLog(logPath);
    if (fromLog) return fromLog;
    const found = await findAcpxRunForFlow(flowPath, earliestStartedAtMs);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const fromLog = await findRunInLog(logPath);
  if (fromLog) return fromLog;
  return findAcpxRunForFlow(flowPath, earliestStartedAtMs);
}

async function findRunInLog(logPath: string): Promise<{ runId: string; runDir: string } | undefined> {
  let text = "";
  try {
    text = await fsp.readFile(logPath, "utf8");
  } catch {
    return undefined;
  }
  const jsonRunId = text.match(/"runId"\\s*:\\s*"([^"]+)"/)?.[1];
  const textRunId = text.match(/\\brunId\\b\\s*[:=]\\s*([^\\s,]+)/)?.[1];
  const jsonRunDir = text.match(/"runDir"\\s*:\\s*"([^"]+)"/)?.[1];
  const textRunDir = text.match(/\\brunDir\\b\\s*[:=]\\s*([^\\s,]+)/)?.[1];
  const runId = jsonRunId ?? textRunId;
  const runDir = jsonRunDir ?? textRunDir ?? (runId ? path.join(runsRoot(), runId) : undefined);
  return runId && runDir ? { runId, runDir } : undefined;
}

export async function findAcpxRunForFlow(flowPath: string, earliestStartedAtMs: number): Promise<{ runId: string; runDir: string } | undefined> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(runsRoot(), { withFileTypes: true });
  } catch {
    return undefined;
  }
  const matches: Array<{ runId: string; runDir: string; startedAt: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsRoot(), entry.name);
    try {
      const manifest = JSON.parse(await fsp.readFile(path.join(runDir, "manifest.json"), "utf8")) as {
        runId?: string;
        flowPath?: string;
        startedAt?: string;
      };
      if (manifest.flowPath !== flowPath) continue;
      const startedAt = manifest.startedAt ?? "";
      const parsed = Date.parse(startedAt);
      if (Number.isFinite(parsed) && parsed < earliestStartedAtMs) continue;
      matches.push({ runId: manifest.runId ?? entry.name, runDir, startedAt });
    } catch {
      // Ignore incomplete run directories while acpx is still starting.
    }
  }
  matches.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return matches[0];
}
