import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const INSPECTOR_ROOT = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(INSPECTOR_ROOT, "..");
const ACPX_ROOT = path.resolve(ROOT, "acpx");
const ACPX_CLI = path.join(ACPX_ROOT, "dist-test", "src", "cli.js");
const INSPECTOR_CLI = path.resolve(INSPECTOR_ROOT, "src", "cli.ts");
const AGENTS = ["trae", "aiden", "claude", "pi"];

for (const agent of AGENTS) {
  test(`real agent smoke: ${agent}`, async (t) => {
    if (process.env.RUN_REAL_AGENT_E2E !== "1") {
      t.skip("set RUN_REAL_AGENT_E2E=1 to run real installed agent smoke tests");
      return;
    }
    if (!(await exists(ACPX_CLI))) {
      t.skip("acpx dist-test is not built; run `pnpm --dir ../acpx build:test` first");
      return;
    }
    if (!(await agentSeemsAvailable(agent))) {
      t.skip(`${agent} is not available in this environment`);
      return;
    }

    await withTempHome(async (home) => {
      const repo = path.join(home, "repo");
      await fs.mkdir(path.join(repo, ".git"), { recursive: true });
      if (agent === "aiden") {
        await fs.mkdir(path.join(home, ".acpx"), { recursive: true });
        await fs.writeFile(
          path.join(home, ".acpx", "config.json"),
          `${JSON.stringify({ agents: { aiden: { command: "aiden" } } }, null, 2)}\n`,
          "utf8",
        );
      }
      const created = await runNode(ACPX_CLI, [
        "--cwd",
        repo,
        "--format",
        "json",
        agent,
        "sessions",
        "new",
        "--name",
        "smoke",
      ], home, { timeoutMs: 30_000 });
      assert.equal(created.code, 0, created.stderr);
      const payload = JSON.parse(created.stdout) as { acpxRecordId?: string };
      assert.ok(payload.acpxRecordId);

      const snap = await runNode(INSPECTOR_CLI, [
        "--state-dir",
        path.join(home, ".acpx"),
        "snapshot",
        "--id",
        payload.acpxRecordId,
      ], home);
      assert.equal(snap.code, 0, snap.stderr);
      const parsed = JSON.parse(snap.stdout) as { resolution?: { status?: string }; session?: { status?: string } };
      assert.equal(parsed.resolution?.status, "resolved");
      assert.ok(["idle", "running", "dead", "closed"].includes(parsed.session?.status ?? ""));
    });
  });
}

async function agentSeemsAvailable(agent: string): Promise<boolean> {
  if (agent === "aiden") {
    return await commandExists("aiden");
  }
  if (agent === "trae") {
    return await commandExists("traecli");
  }
  if (agent === "claude" || agent === "pi") {
    return true;
  }
  return false;
}

async function commandExists(command: string): Promise<boolean> {
  const child = spawn("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return code === 0;
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-inspector-agent-e2e-"));
  try {
    return await fn(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runNode(
  entry: string,
  args: string[],
  home: string,
  options: { timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd: INSPECTOR_ROOT,
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out: ${entry} ${args.join(" ")}`));
    }, options.timeoutMs ?? 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}
