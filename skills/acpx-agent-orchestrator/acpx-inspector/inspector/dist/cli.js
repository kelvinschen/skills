#!/usr/bin/env node
import { S as readSessionEvents, _ as suggestActions, a as sessionReportModel, f as diagnose, h as snapshot, i as oneshotReportModel, l as parseDurationMs, o as followFlow, p as sessionsView, r as flowReportModel, s as followSession, t as writeReport, v as historyView, y as resolveSession } from "./write-DH4QZtQ7.js";
import { Command, InvalidArgumentError } from "commander";
//#region src/cli.ts
const program = new Command();
program.name("acpx-inspector").description("Agent Core inspector for acpx sessions: sessions, snapshot, read, diagnose, follow").version("0.1.0").option("--state-dir <path>", "acpx state directory, defaults to ~/.acpx");
addSessionRefOptions(program.command("sessions").description("List acpx sessions").option("--limit <count>", "Maximum sessions to show", parsePositiveInt, 50).action(async function(flags) {
	printJson(await sessionsView({
		...sessionRef(this),
		limit: flags.limit
	}));
}));
addSessionRefOptions(program.command("snapshot").description("Show compact session snapshot").action(async function() {
	printJson(await snapshot(sessionRef(this)));
}));
addSessionRefOptions(program.command("read").description("Read compact session history").option("--tail <count>", "Recent event count", parsePositiveInt, 80).option("--budget <tokens>", "Approximate output budget", parsePositiveInt, 1200).option("--raw", "[debug] Include raw projected payloads").action(async function(flags) {
	printJson(await historyView({
		...sessionRef(this),
		tail: flags.tail,
		budget: flags.budget,
		raw: flags.raw
	}));
}));
addSessionRefOptions(program.command("tail").description("[debug] Tail projected ACP events").option("--events <count>", "Recent event count", parsePositiveInt, 50).option("--format <format>", "json or jsonl", "jsonl").option("--raw", "[debug] Include raw ACP payloads").action(async function(flags) {
	const resolved = await resolveSession(sessionRef(this));
	if (!resolved.record) {
		printJson({
			schema: "acpx-inspector.events.v1",
			generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
			resolution: resolved.resolution,
			warnings: resolved.warnings,
			events: []
		});
		return;
	}
	const result = await readSessionEvents(resolved.record, {
		stateDir: sessionRef(this).stateDir,
		tail: flags.events,
		raw: flags.raw
	});
	const payload = {
		schema: "acpx-inspector.events.v1",
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		resolution: resolved.resolution,
		warnings: [...resolved.warnings, ...result.warnings],
		events: result.events
	};
	if (flags.format === "json") printJson(payload);
	else for (const event of result.events) process.stdout.write(`${JSON.stringify(event)}\n`);
}));
addSessionRefOptions(program.command("actions").description("[legacy] Suggest safe next actions").action(async function() {
	const ref = sessionRef(this);
	const resolved = await resolveSession(ref);
	if (!resolved.record) {
		printJson({
			schema: "acpx-inspector.actions.v1",
			generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
			resolution: resolved.resolution,
			warnings: resolved.warnings,
			actions: []
		});
		return;
	}
	const snap = await snapshot({
		...ref,
		id: resolved.record.acpxRecordId
	});
	printJson({
		schema: "acpx-inspector.actions.v1",
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		resolution: resolved.resolution,
		status: snap.session?.status ?? "unknown",
		actions: snap.nextActions ?? await suggestActions(resolved.record, "unknown", { stateDir: ref.stateDir })
	});
}));
addSessionRefOptions(program.command("command").description("[legacy] Print one suggested command").argument("<action-id>", "Action id").action(async function(actionId) {
	const action = (await snapshot(sessionRef(this))).nextActions?.find((candidate) => candidate.id === actionId);
	if (!action?.command) throw new Error(`No command available for action: ${actionId}`);
	process.stdout.write(`${action.command}\n`);
}));
addSessionRefOptions(program.command("diagnose").description("Diagnose session health").action(async function() {
	printJson(await diagnose(sessionRef(this)));
}));
addSessionRefOptions(program.command("follow").description("Follow a session or flow with low-context text output").option("--run-id <id>", "Flow run id under ~/.acpx/flows/runs").option("--run-dir <path>", "Flow run directory").option("--duration <time>", "Maximum follow time: ms/s/m/h; bare numbers are seconds", parseTime("duration"), 6e5).option("--interval <time>", "Sampling interval: ms/s/m/h; minimum 1s", parseInterval, 6e4).option("--events <count>", "Recent simplified events per tick", parsePositiveInt, 2).option("--max-line <chars>", "Maximum characters per event line", parsePositiveInt, 180).action(async function(flags) {
	const ref = sessionRef(this);
	const isFlow = Boolean(flags.runId || flags.runDir);
	if (isFlow && (ref.id || ref.cwd || ref.agent || ref.name)) throw new InvalidArgumentError("Flow follow cannot be combined with --id, --cwd, --agent, or --name");
	if (isFlow) {
		await followFlow({
			stateDir: ref.stateDir,
			runId: flags.runId,
			runDir: flags.runDir,
			durationMs: flags.duration,
			intervalMs: flags.interval,
			events: flags.events,
			maxLine: flags.maxLine
		});
		return;
	}
	await followSession(ref, {
		stateDir: ref.stateDir,
		durationMs: flags.duration,
		intervalMs: flags.interval,
		events: flags.events,
		maxLine: flags.maxLine
	});
}));
const report = program.command("report").description("[human] Generate static HTML handoff reports");
report.command("oneshot").requiredOption("--events-file <path>", "NDJSON captured from acpx --format json").requiredOption("--output <path>", "Output HTML path").option("--raw", "[debug] Embed raw capture").option("--open", "Open after writing").action(async (flags) => {
	const file = await writeReport(await oneshotReportModel({
		eventsFile: flags.eventsFile,
		raw: flags.raw
	}), flags.output, flags.open);
	process.stdout.write(`${file}\n`);
});
addSessionRefOptions(report.command("session").requiredOption("--output <path>", "Output HTML path").option("--open", "Open after writing").action(async function(flags) {
	const file = await writeReport(await sessionReportModel(sessionRef(this)), flags.output, flags.open);
	process.stdout.write(`${file}\n`);
}));
report.command("flow").option("--run-id <id>", "Flow run id under ~/.acpx/flows/runs").option("--run-dir <path>", "Flow run directory").requiredOption("--output <path>", "Output HTML path").option("--raw", "[debug] Embed raw bundle").option("--open", "Open after writing").action(async (flags) => {
	const stateDir = program.opts().stateDir;
	if (!flags.runId && !flags.runDir) throw new InvalidArgumentError("Either --run-id or --run-dir is required");
	const file = await writeReport(await flowReportModel({
		stateDir,
		runId: flags.runId,
		runDir: flags.runDir,
		raw: flags.raw
	}), flags.output, flags.open);
	process.stdout.write(`${file}\n`);
});
program.parseAsync(process.argv).catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
function addSessionRefOptions(command) {
	return command.option("--cwd <path>", "Working directory scope").option("--agent <command-or-name>", "Agent command/name filter").option("--name <name>", "Named session").option("--id <id>", "Session id or unique suffix").option("--include-closed", "Include closed sessions");
}
function sessionRef(command) {
	const root = program.opts();
	const local = command.opts();
	return {
		stateDir: root.stateDir,
		cwd: local.cwd,
		agent: local.agent,
		name: local.name,
		id: local.id,
		includeClosed: local.includeClosed
	};
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function parsePositiveInt(value) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError("expected non-negative integer");
	return parsed;
}
function parseTime(label) {
	return (value) => {
		try {
			return parseDurationMs(value, label);
		} catch (error) {
			throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
		}
	};
}
function parseInterval(value) {
	const parsed = parseTime("interval")(value);
	if (parsed < 1e3) throw new InvalidArgumentError("interval must be at least 1s");
	return parsed;
}
//#endregion
export {};
