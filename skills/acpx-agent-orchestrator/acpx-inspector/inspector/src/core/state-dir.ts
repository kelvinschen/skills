import os from "node:os";
import path from "node:path";

export function resolveStateDir(input?: string): string {
  return path.resolve(input ? expandHome(input) : path.join(os.homedir(), ".acpx"));
}

export function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function sessionDir(stateDir?: string): string {
  return path.join(resolveStateDir(stateDir), "sessions");
}

export function flowsRunsDir(stateDir?: string): string {
  return path.join(resolveStateDir(stateDir), "flows", "runs");
}
