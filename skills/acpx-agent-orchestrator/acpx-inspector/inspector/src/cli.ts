#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { historyView } from "./projections/history.js";
import { sessionsView } from "./projections/sessions.js";
import { snapshot } from "./projections/snapshot.js";
import { diagnose } from "./projections/diagnose.js";
import { resolveSession } from "./core/resolver.js";
import { readSessionEvents } from "./core/event-stream.js";
import { suggestActions } from "./projections/actions.js";
import { followFlow, followSession, parseDurationMs } from "./projections/follow.js";
import { flowReportModel, oneshotReportModel, sessionReportModel } from "./html-report/model.js";
import { writeReport } from "./html-report/write.js";
import type { SessionRef } from "./types.js";

const program = new Command();

program
  .name("acpx-inspector")
  .description("Agent Core inspector for acpx sessions: sessions, snapshot, read, diagnose, follow")
  .version("0.1.0")
  .option("--state-dir <path>", "acpx state directory, defaults to ~/.acpx");

addSessionRefOptions(
  program
    .command("sessions")
    .description("List acpx sessions")
    .option("--limit <count>", "Maximum sessions to show", parsePositiveInt, 50)
    .action(async function (this: Command, flags: { limit: number }) {
      const view = await sessionsView({ ...sessionRef(this), limit: flags.limit });
      printJson(view);
    }),
);

addSessionRefOptions(
  program.command("snapshot").description("Show compact session snapshot").action(async function (this: Command) {
    printJson(await snapshot(sessionRef(this)));
  }),
);

addSessionRefOptions(
  program
    .command("read")
    .description("Read compact session history")
    .option("--tail <count>", "Recent event count", parsePositiveInt, 80)
    .option("--budget <tokens>", "Approximate output budget", parsePositiveInt, 1200)
    .option("--raw", "[debug] Include raw projected payloads")
    .action(async function (this: Command, flags: { tail: number; budget: number; raw?: boolean }) {
      printJson(await historyView({ ...sessionRef(this), tail: flags.tail, budget: flags.budget, raw: flags.raw }));
    }),
);

addSessionRefOptions(
  program
    .command("tail")
    .description("[debug] Tail projected ACP events")
    .option("--events <count>", "Recent event count", parsePositiveInt, 50)
    .option("--format <format>", "json or jsonl", "jsonl")
    .option("--raw", "[debug] Include raw ACP payloads")
    .action(async function (this: Command, flags: { events: number; format: string; raw?: boolean }) {
      const resolved = await resolveSession(sessionRef(this));
      if (!resolved.record) {
        printJson({
          schema: "acpx-inspector.events.v1",
          generatedAt: new Date().toISOString(),
          resolution: resolved.resolution,
          warnings: resolved.warnings,
          events: [],
        });
        return;
      }
      const result = await readSessionEvents(resolved.record, {
        stateDir: sessionRef(this).stateDir,
        tail: flags.events,
        raw: flags.raw,
      });
      const payload = {
        schema: "acpx-inspector.events.v1",
        generatedAt: new Date().toISOString(),
        resolution: resolved.resolution,
        warnings: [...resolved.warnings, ...result.warnings],
        events: result.events,
      };
      if (flags.format === "json") {
        printJson(payload);
      } else {
        for (const event of result.events) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        }
      }
    }),
);

addSessionRefOptions(
  program.command("actions").description("[legacy] Suggest safe next actions").action(async function (this: Command) {
    const ref = sessionRef(this);
    const resolved = await resolveSession(ref);
    if (!resolved.record) {
      printJson({
        schema: "acpx-inspector.actions.v1",
        generatedAt: new Date().toISOString(),
        resolution: resolved.resolution,
        warnings: resolved.warnings,
        actions: [],
      });
      return;
    }
    const snap = await snapshot({ ...ref, id: resolved.record.acpxRecordId });
    printJson({
      schema: "acpx-inspector.actions.v1",
      generatedAt: new Date().toISOString(),
      resolution: resolved.resolution,
      status: snap.session?.status ?? "unknown",
      actions: snap.nextActions ?? (await suggestActions(resolved.record, "unknown", { stateDir: ref.stateDir })),
    });
  }),
);

addSessionRefOptions(
  program
    .command("command")
    .description("[legacy] Print one suggested command")
    .argument("<action-id>", "Action id")
    .action(async function (this: Command, actionId: string) {
      const ref = sessionRef(this);
      const snap = await snapshot(ref);
      const action = snap.nextActions?.find((candidate) => candidate.id === actionId);
      if (!action?.command) {
        throw new Error(`No command available for action: ${actionId}`);
      }
      process.stdout.write(`${action.command}\n`);
    }),
);

addSessionRefOptions(
  program.command("diagnose").description("Diagnose session health").action(async function (this: Command) {
    printJson(await diagnose(sessionRef(this)));
  }),
);

addSessionRefOptions(
  program
    .command("follow")
    .description("Follow a session or flow with low-context text output")
    .option("--run-id <id>", "Flow run id under ~/.acpx/flows/runs")
    .option("--run-dir <path>", "Flow run directory")
    .option("--duration <time>", "Maximum follow time: ms/s/m/h; bare numbers are seconds", parseTime("duration"), 600_000)
    .option("--interval <time>", "Sampling interval: ms/s/m/h; minimum 1s", parseInterval, 60_000)
    .option("--events <count>", "Recent simplified events per tick", parsePositiveInt, 2)
    .option("--max-line <chars>", "Maximum characters per event line", parsePositiveInt, 180)
    .action(
      async function (
        this: Command,
        flags: { runId?: string; runDir?: string; duration: number; interval: number; events: number; maxLine: number },
      ) {
        const ref = sessionRef(this);
        const isFlow = Boolean(flags.runId || flags.runDir);
        if (isFlow && (ref.id || ref.cwd || ref.agent || ref.name)) {
          throw new InvalidArgumentError("Flow follow cannot be combined with --id, --cwd, --agent, or --name");
        }
        if (isFlow) {
          await followFlow({
            stateDir: ref.stateDir,
            runId: flags.runId,
            runDir: flags.runDir,
            durationMs: flags.duration,
            intervalMs: flags.interval,
            events: flags.events,
            maxLine: flags.maxLine,
          });
          return;
        }
        await followSession(ref, {
          stateDir: ref.stateDir,
          durationMs: flags.duration,
          intervalMs: flags.interval,
          events: flags.events,
          maxLine: flags.maxLine,
        });
      },
    ),
);

const report = program.command("report").description("[human] Generate static HTML handoff reports");

report
  .command("oneshot")
  .requiredOption("--events-file <path>", "NDJSON captured from acpx --format json")
  .requiredOption("--output <path>", "Output HTML path")
  .option("--raw", "[debug] Embed raw capture")
  .option("--open", "Open after writing")
  .action(async (flags: { eventsFile: string; output: string; raw?: boolean; open?: boolean }) => {
    const file = await writeReport(
      await oneshotReportModel({ eventsFile: flags.eventsFile, raw: flags.raw }),
      flags.output,
      flags.open,
    );
    process.stdout.write(`${file}\n`);
  });

addSessionRefOptions(
  report
    .command("session")
    .requiredOption("--output <path>", "Output HTML path")
    .option("--open", "Open after writing")
    .action(async function (this: Command, flags: { output: string; open?: boolean }) {
      const file = await writeReport(await sessionReportModel(sessionRef(this)), flags.output, flags.open);
      process.stdout.write(`${file}\n`);
    }),
);

report
  .command("flow")
  .option("--run-id <id>", "Flow run id under ~/.acpx/flows/runs")
  .option("--run-dir <path>", "Flow run directory")
  .requiredOption("--output <path>", "Output HTML path")
  .option("--raw", "[debug] Embed raw bundle")
  .option("--open", "Open after writing")
  .action(
    async (flags: {
      runId?: string;
      runDir?: string;
      output: string;
      raw?: boolean;
      open?: boolean;
    }) => {
      const stateDir = program.opts<{ stateDir?: string }>().stateDir;
      if (!flags.runId && !flags.runDir) {
        throw new InvalidArgumentError("Either --run-id or --run-dir is required");
      }
      const file = await writeReport(
        await flowReportModel({
          stateDir,
          runId: flags.runId,
          runDir: flags.runDir,
          raw: flags.raw,
        }),
        flags.output,
        flags.open,
      );
      process.stdout.write(`${file}\n`);
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

function addSessionRefOptions(command: Command): Command {
  return command
    .option("--cwd <path>", "Working directory scope")
    .option("--agent <command-or-name>", "Agent command/name filter")
    .option("--name <name>", "Named session")
    .option("--id <id>", "Session id or unique suffix")
    .option("--include-closed", "Include closed sessions");
}

function sessionRef(command: Command): SessionRef {
  const root = program.opts<{ stateDir?: string }>();
  const local = command.opts<{
    cwd?: string;
    agent?: string;
    name?: string;
    id?: string;
    includeClosed?: boolean;
  }>();
  return {
    stateDir: root.stateDir,
    cwd: local.cwd,
    agent: local.agent,
    name: local.name,
    id: local.id,
    includeClosed: local.includeClosed,
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("expected non-negative integer");
  }
  return parsed;
}

function parseTime(label: string): (value: string) => number {
  return (value: string) => {
    try {
      return parseDurationMs(value, label);
    } catch (error) {
      throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
    }
  };
}

function parseInterval(value: string): number {
  const parsed = parseTime("interval")(value);
  if (parsed < 1000) {
    throw new InvalidArgumentError("interval must be at least 1s");
  }
  return parsed;
}
