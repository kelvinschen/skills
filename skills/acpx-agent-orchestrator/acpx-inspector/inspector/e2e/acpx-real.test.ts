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
const MOCK_AGENT = `node ${JSON.stringify(path.join(ACPX_ROOT, "dist-test", "test", "mock-agent.js"))} --supports-load-session --advertise-models --advertise-config-options`;
const INSPECTOR_CLI = path.resolve(INSPECTOR_ROOT, "src", "cli.ts");

test("real acpx session can be inspected and rendered as HTML", async (t) => {
  if (!(await exists(ACPX_CLI))) {
    t.skip("acpx dist-test is not built; run `pnpm --dir ../acpx build:test` before e2e");
    return;
  }
  await withTempHome(async (home) => {
    const repo = path.join(home, "repo");
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    const created = await runNode(ACPX_CLI, [
      "--agent",
      MOCK_AGENT,
      "--cwd",
      repo,
      "--format",
      "json",
      "sessions",
      "new",
      "--name",
      "api",
    ], home);
    assert.equal(created.code, 0, created.stderr);
    const createdPayload = JSON.parse(created.stdout) as { acpxRecordId?: string };
    assert.ok(createdPayload.acpxRecordId);

    const prompt = await runNode(ACPX_CLI, [
      "--agent",
      MOCK_AGENT,
      "--cwd",
      repo,
      "--ttl",
      "0.1",
      "--format",
      "quiet",
      "prompt",
      "-s",
      "api",
      "echo hello inspector e2e",
    ], home, { timeoutMs: 8000 });
    assert.equal(prompt.code, 0, prompt.stderr);

    const snapshot = await runNode(INSPECTOR_CLI, [
      "--state-dir",
      path.join(home, ".acpx"),
      "snapshot",
      "--id",
      createdPayload.acpxRecordId,
    ], home);
    assert.equal(snapshot.code, 0, snapshot.stderr);
    const snap = JSON.parse(snapshot.stdout) as { session?: { status?: string }; eventLog?: { availableEventCount?: number } };
    assert.ok(["idle", "running"].includes(snap.session?.status ?? ""));
    assert.ok((snap.eventLog?.availableEventCount ?? 0) > 0);

    const output = path.join(home, "session.html");
    const report = await runNode(INSPECTOR_CLI, [
      "--state-dir",
      path.join(home, ".acpx"),
      "report",
      "session",
      "--id",
      createdPayload.acpxRecordId,
      "--output",
      output,
    ], home);
    assert.equal(report.code, 0, report.stderr);
    const html = await fs.readFile(output, "utf8");
    assert.match(html, /acpx inspector/);
    assert.match(html, /hello inspector e2e/);
    assert.match(html, /Next actions/);
  });
});

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-inspector-e2e-"));
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
    }, options.timeoutMs ?? 15000);
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
