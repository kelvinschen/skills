import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  followFlow,
  followSession,
  historyView,
  parseDurationMs,
  renderReportHtml,
  resolveSession,
  sampleFlow,
  sampleSession,
  sessionsView,
  snapshot,
} from "../src/index.js";
import { sessionReportModel } from "../src/html-report/model.js";
import { withTempHome, writeSession } from "./helpers.js";

const INSPECTOR_ROOT = path.resolve(import.meta.dirname, "..");
const INSPECTOR_CLI = path.join(INSPECTOR_ROOT, "src", "cli.ts");

test("snapshot resolves a session by id and returns compact action-ready state", async () => {
  await withTempHome(async (home) => {
    const stateDir = path.join(home, ".acpx");
    await writeSession(home, "session-one");

    const view = await snapshot({ stateDir, id: "session-one" });

    assert.equal(view.resolution.status, "resolved");
    assert.equal(view.session?.status, "idle");
    assert.equal(view.conversation?.lastUserPreview, "hello inspector");
    assert.equal(view.conversation?.lastAssistantPreview, "hi from agent");
    assert.equal(view.eventLog?.availableEventCount, 3);
    assert.ok(view.nextActions?.some((action) => action.id === "prompt"));
    assert.ok(view.nextActions?.some((action) => action.id === "report_session"));
  });
});

test("resolver reports ambiguous suffixes instead of guessing", async () => {
  await withTempHome(async (home) => {
    const stateDir = path.join(home, ".acpx");
    await writeSession(home, "abc-shared");
    await writeSession(home, "xyz-shared", { acp_session_id: "also-shared" });

    const resolved = await resolveSession({ stateDir, id: "shared" });

    assert.equal(resolved.resolution.status, "ambiguous");
    if (resolved.resolution.status === "ambiguous") {
      assert.equal(resolved.resolution.candidates.length, 2);
    }
  });
});

test("sessions view hides closed records by default", async () => {
  await withTempHome(async (home) => {
    const stateDir = path.join(home, ".acpx");
    await writeSession(home, "open-session");
    await writeSession(home, "closed-session", { closed: true, closed_at: "2026-01-01T00:03:00.000Z" });

    const visible = await sessionsView({ stateDir });
    const all = await sessionsView({ stateDir, includeClosed: true });

    assert.equal(visible.sessions.length, 1);
    assert.equal(visible.summary.closed, 0);
    assert.equal(all.sessions.length, 2);
    assert.equal(all.summary.closed, 1);
  });
});

test("history view projects ACP events without raw payloads by default", async () => {
  await withTempHome(async (home) => {
    const stateDir = path.join(home, ".acpx");
    await writeSession(home, "history-session");

    const view = await historyView({ stateDir, id: "history-session" });

    assert.equal(view.summary?.latestStopReason, "end_turn");
    assert.ok(view.entries?.some((entry) => entry.preview.includes("hi from agent")));
    assert.equal(JSON.stringify(view).includes('"jsonrpc"'), false);
  });
});

test("session HTML report escapes raw text and includes operational UI sections", async () => {
  await withTempHome(async (home) => {
    const stateDir = path.join(home, ".acpx");
    await writeSession(home, "html-session", {
      messages: [
        { User: { id: "u1", content: [{ Text: "<script>bad()</script>" }] } },
        { Agent: { content: [{ Text: "safe answer" }], tool_results: {} } },
      ],
    });

    const model = await sessionReportModel({ stateDir, id: "html-session" });
    const html = renderReportHtml(model);

    assert.match(html, /acpx inspector/);
    assert.match(html, /Timeline/);
    assert.match(html, /Signal map/);
    assert.match(html, /Session Shape/);
    assert.doesNotMatch(html, /Next actions/);
    assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
    assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  });
});

test("follow duration parser accepts supported units and rejects invalid values", () => {
  assert.equal(parseDurationMs("500ms"), 500);
  assert.equal(parseDurationMs("10s"), 10_000);
  assert.equal(parseDurationMs("2m"), 120_000);
  assert.equal(parseDurationMs("1h"), 3_600_000);
  assert.equal(parseDurationMs("15"), 15_000);
  assert.throws(() => parseDurationMs("soon"), /Invalid duration/);
});

test("session follow emits only simplified tail events without tool payloads", async () => {
  await withTempHome(async (home) => {
    const stateDir = path.join(home, ".acpx");
    await writeSession(home, "follow-session");
    await fs.writeFile(
      path.join(stateDir, "sessions", `${encodeURIComponent("follow-session")}.stream.ndjson`),
      [
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "first message should be omitted" },
            },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              title: "grep",
              status: "running",
              input: { pattern: "secret-arg" },
              output: "secret-output",
            },
          },
        }),
        JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: { stopReason: "end_turn" } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const sample = await sampleSession(
      { stateDir, id: "follow-session" },
      { stateDir, events: 2, maxLine: 180, now: () => new Date("2026-01-01T00:05:00.000Z") },
      1,
    );
    let output = "";
    await followSession(
      { stateDir, id: "follow-session" },
      {
        stateDir,
        durationMs: 1000,
        intervalMs: 1000,
        events: 2,
        maxLine: 180,
        now: () => new Date("2026-01-01T00:05:00.000Z"),
        write: (text) => (output += text),
      },
    );

    assert.equal(sample.events.length, 2);
    assert.match(output, /follow target=session id=follow-session status=idle duration=1s interval=1s events=2/);
    assert.match(output, /#2 tool grep running/);
    assert.match(output, /#3 response completed: end_turn stop=end_turn/);
    assert.doesNotMatch(output, /first message should be omitted/);
    assert.doesNotMatch(output, /secret-arg/);
    assert.doesNotMatch(output, /secret-output/);
  });
});

test("flow follow samples status and exits immediately for terminal runs", async () => {
  await withTempHome(async (home) => {
    const runDir = path.join(home, ".acpx", "flows", "runs", "run-one");
    await writeFlowRun(runDir, {
      status: "completed",
      currentNode: "finalize",
      traceEvents: [
        { seq: 1, type: "node_started", nodeId: "draft", payload: { statusDetail: "Running draft" } },
        { seq: 2, type: "node_outcome", nodeId: "finalize", payload: { outcome: "ok" } },
        { seq: 3, type: "run_completed", payload: { status: "completed" } },
      ],
    });

    const sample = await sampleFlow(
      { runDir, events: 2, maxLine: 180, now: () => new Date("2026-01-01T00:06:00.000Z") },
      1,
    );
    let output = "";
    const result = await followFlow({
      runDir,
      durationMs: 1000,
      intervalMs: 1000,
      events: 2,
      maxLine: 180,
      now: () => new Date("2026-01-01T00:06:00.000Z"),
      write: (text) => (output += text),
    });

    assert.equal(sample.status, "completed");
    assert.equal(sample.currentNode, "finalize");
    assert.equal(result.reason, "terminal");
    assert.match(output, /follow target=flow id=run-one status=completed duration=1s interval=1s events=2/);
    assert.match(output, /currentNode=finalize/);
    assert.match(output, /#3 flow run_completed completed/);
  });
});

test("follow CLI rejects mixed session and flow selectors", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["--state-dir", path.join(home, ".acpx"), "follow", "--id", "abc", "--run-id", "run-one"], home);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Flow follow cannot be combined/);
  });
});

test("follow CLI exits for an idle session", async () => {
  await withTempHome(async (home) => {
    const stateDir = path.join(home, ".acpx");
    await writeSession(home, "cli-follow-session");

    const result = await runCli(
      [
        "--state-dir",
        stateDir,
        "follow",
        "--id",
        "cli-follow-session",
        "--duration",
        "1s",
        "--interval",
        "1s",
        "--events",
        "2",
      ],
      home,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /follow target=session id=cli-follow-session status=idle duration=1s interval=1s events=2/);
    assert.match(result.stdout, /follow done reason=terminal status=idle/);
  });
});

test("CLI help distinguishes Agent Core from human and debug extras", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["--help"], home);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Agent Core inspector/);
    assert.match(result.stdout, /sessions .*List acpx sessions/);
    assert.match(result.stdout, /snapshot .*Show compact session snapshot/);
    assert.match(result.stdout, /read .*Read compact session history/);
    assert.match(result.stdout, /diagnose .*Diagnose session health/);
    assert.match(result.stdout, /follow .*Follow a session or flow with low-context text/);
    assert.match(result.stdout, /tail .*\[debug\]/);
    assert.match(result.stdout, /actions .*\[legacy\]/);
    assert.match(result.stdout, /command .*\[legacy\]/);
    assert.match(result.stdout, /report .*\[human\]/);
  });
});

test("README documents the compact Agent Core workflow", async () => {
  const readme = await fs.readFile(path.join(INSPECTOR_ROOT, "README.md"), "utf8");

  assert.match(readme, /Agent Core inspector/);
  assert.match(readme, /acpx-inspector sessions/);
  assert.match(readme, /acpx-inspector snapshot --id <session-id>/);
  assert.match(readme, /acpx-inspector read --id <session-id>/);
  assert.match(readme, /acpx-inspector diagnose --id <session-id>/);
  assert.match(readme, /acpx-inspector follow --id <session-id>/);
  assert.match(readme, /Human And Debug Extras/);
  assert.match(readme, /tail.*debug event view/);
  assert.match(readme, /actions.*legacy convenience/);
  assert.match(readme, /command.*legacy helper/);
  assert.match(readme, /report.*human handoff HTML reports/);
});

async function writeFlowRun(
  runDir: string,
  input: { status: string; currentNode?: string; traceEvents: unknown[] },
): Promise<void> {
  await fs.mkdir(path.join(runDir, "projections"), { recursive: true });
  const run = {
    runId: path.basename(runDir),
    status: input.status,
    currentNode: input.currentNode,
    steps: [],
    sessionBindings: {},
  };
  await fs.writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify({ runId: path.basename(runDir) })}\n`, "utf8");
  await fs.writeFile(path.join(runDir, "projections", "run.json"), `${JSON.stringify(run)}\n`, "utf8");
  await fs.writeFile(path.join(runDir, "projections", "live.json"), `${JSON.stringify(run)}\n`, "utf8");
  await fs.writeFile(path.join(runDir, "projections", "steps.json"), "[]\n", "utf8");
  await fs.writeFile(
    path.join(runDir, "trace.ndjson"),
    input.traceEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
}

async function runCli(args: string[], home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", INSPECTOR_CLI, ...args], {
      cwd: INSPECTOR_ROOT,
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out: ${args.join(" ")}`));
    }, 10_000);
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
