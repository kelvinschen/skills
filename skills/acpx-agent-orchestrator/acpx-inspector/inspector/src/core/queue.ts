import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "./state-dir.js";
import { isObject, isProcessAlive, numberValue, stringValue } from "./util.js";
import type { QueueHealth } from "../types.js";

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function queueLockPath(sessionId: string, stateDir?: string): string {
  const resolved = resolveStateDir(stateDir);
  const home = path.dirname(resolved);
  return path.join(resolved, "queues", `${shortHash(sessionId, 24)}.lock`);
}

export async function readQueueHealth(sessionId: string, stateDir?: string): Promise<QueueHealth> {
  const lockPath = queueLockPath(sessionId, stateDir);
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as unknown;
    if (!isObject(parsed)) {
      return { hasLease: true, healthy: false, pidAlive: false, lockPath };
    }
    const pid = numberValue(parsed.pid);
    const pidAlive = isProcessAlive(pid);
    const heartbeatAt = stringValue(parsed.heartbeatAt);
    const stale = heartbeatAt ? Date.now() - Date.parse(heartbeatAt) > 15_000 : true;
    return {
      hasLease: true,
      healthy: pidAlive && !stale,
      pidAlive,
      pid,
      socketPath: stringValue(parsed.socketPath),
      queueDepth: numberValue(parsed.queueDepth),
      heartbeatAt,
      stale,
      lockPath,
    };
  } catch {
    return { hasLease: false, healthy: false, pidAlive: false, lockPath };
  }
}
