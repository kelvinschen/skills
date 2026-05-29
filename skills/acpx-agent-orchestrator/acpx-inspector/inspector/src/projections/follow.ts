import { readSessionEvents } from "../core/event-stream.js";
import { readFlowBundle, flowStatus, type FlowBundle } from "../core/flow.js";
import { readQueueHealth } from "../core/queue.js";
import { resolveSession } from "../core/resolver.js";
import { isObject, truncate } from "../core/util.js";
import { classifyStatus } from "./snapshot.js";
import type { ProjectedEvent, SessionRef, SessionStatus } from "../types.js";

export type FollowTarget = "session" | "flow";

export type FollowEventLine = {
  seq?: number;
  role: string;
  label: string;
  status?: string;
  text?: string;
};

export type FollowTick = {
  target: FollowTarget;
  id: string;
  tick: number;
  at: string;
  status: string;
  totalEvents: number;
  lastWriteAt?: string | null;
  currentNode?: string | null;
  warnings: string[];
  events: FollowEventLine[];
};

export type FollowResult = {
  reason: "terminal" | "timeout";
  status: string;
  ticks: number;
};

export type FollowLoopOptions = {
  durationMs: number;
  intervalMs: number;
  events: number;
  maxLine: number;
  write?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export type FollowSessionOptions = FollowLoopOptions & {
  stateDir?: string;
};

export type FollowFlowOptions = FollowLoopOptions & {
  stateDir?: string;
  runId?: string;
  runDir?: string;
};

export function parseDurationMs(value: string, label = "duration"): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const scale = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const result = amount * scale;
  if (!Number.isFinite(result) || result < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return Math.floor(result);
}

export async function followSession(ref: SessionRef, options: FollowSessionOptions): Promise<FollowResult> {
  const writer = options.write ?? ((text: string) => process.stdout.write(text));
  const sleeper = options.sleep ?? sleep;
  const startedAt = Date.now();
  let tick = 0;
  let announced = false;
  let latestStatus = "unknown";

  while (true) {
    const sample = await sampleSession(ref, options, tick + 1);
    latestStatus = sample.status;
    if (!announced) {
      writer(formatFollowStartText(sample, options));
      announced = true;
    }
    tick += 1;
    writer(formatFollowTickText(sample));
    if (isTerminalSessionStatus(sample.status)) {
      writer(formatFollowDoneText("terminal", sample.status));
      return { reason: "terminal", status: sample.status, ticks: tick };
    }
    if (Date.now() - startedAt >= options.durationMs) {
      writer(formatFollowDoneText("timeout", sample.status));
      return { reason: "timeout", status: sample.status, ticks: tick };
    }
    await sleeper(Math.min(options.intervalMs, Math.max(0, options.durationMs - (Date.now() - startedAt))));
  }
}

export async function followFlow(options: FollowFlowOptions): Promise<FollowResult> {
  const writer = options.write ?? ((text: string) => process.stdout.write(text));
  const sleeper = options.sleep ?? sleep;
  const startedAt = Date.now();
  let tick = 0;
  let announced = false;

  while (true) {
    const sample = await sampleFlow(options, tick + 1);
    if (!announced) {
      writer(formatFollowStartText(sample, options));
      announced = true;
    }
    tick += 1;
    writer(formatFollowTickText(sample));
    if (isTerminalFlowStatus(sample.status)) {
      writer(formatFollowDoneText("terminal", sample.status));
      return { reason: "terminal", status: sample.status, ticks: tick };
    }
    if (Date.now() - startedAt >= options.durationMs) {
      writer(formatFollowDoneText("timeout", sample.status));
      return { reason: "timeout", status: sample.status, ticks: tick };
    }
    await sleeper(Math.min(options.intervalMs, Math.max(0, options.durationMs - (Date.now() - startedAt))));
  }
}

export async function sampleSession(
  ref: SessionRef,
  options: Pick<FollowSessionOptions, "stateDir" | "events" | "maxLine" | "now">,
  tick: number,
): Promise<FollowTick> {
  const resolved = await resolveSession(ref);
  if (!resolved.record) {
    throw new Error(`Unable to resolve session: ${resolved.resolution.status}`);
  }
  const queue = await readQueueHealth(resolved.record.acpxRecordId, options.stateDir);
  const status = classifyStatus(resolved.record, queue);
  const result = await readSessionEvents(resolved.record, {
    stateDir: options.stateDir,
    tail: options.events,
    raw: false,
  });
  return {
    target: "session",
    id: resolved.record.acpxRecordId,
    tick,
    at: (options.now?.() ?? new Date()).toISOString(),
    status,
    totalEvents: result.availableEventCount,
    lastWriteAt: resolved.record.eventLog?.last_write_at ?? null,
    warnings: [...resolved.warnings, ...result.warnings],
    events: result.events.map((event) => simplifySessionEvent(event, options.maxLine)),
  };
}

export async function sampleFlow(
  options: Pick<FollowFlowOptions, "stateDir" | "runId" | "runDir" | "events" | "maxLine" | "now">,
  tick: number,
): Promise<FollowTick> {
  const bundle = await readFlowBundle(options);
  const status = flowStatus(bundle);
  if (status === "unknown" && bundle.traceEvents.length === 0) {
    throw new Error(`Unable to read flow run: ${bundle.runId}`);
  }
  return {
    target: "flow",
    id: bundle.runId,
    tick,
    at: (options.now?.() ?? new Date()).toISOString(),
    status,
    totalEvents: bundle.traceEvents.length,
    currentNode: currentFlowNode(bundle),
    warnings: bundle.warnings,
    events: bundle.traceEvents.slice(-options.events).map((event, index) =>
      simplifyFlowEvent(event, bundle.traceEvents.length - Math.min(options.events, bundle.traceEvents.length) + index + 1, options.maxLine),
    ),
  };
}

export function formatFollowTickText(tick: FollowTick): string {
  const detail =
    tick.target === "flow"
      ? `currentNode=${tick.currentNode ?? "none"}`
      : `lastWrite=${tick.lastWriteAt ?? "none"}`;
  const lines = [`[${tick.at}] tick=${tick.tick} ${tick.target} status=${tick.status} events=${tick.totalEvents} ${detail}`];
  for (const event of tick.events) {
    const seq = event.seq == null ? "-" : `#${event.seq}`;
    const status = event.status ? ` ${event.status}` : "";
    const text = event.text ? ` ${event.text}` : "";
    lines.push(`${seq} ${event.role} ${event.label}${status}${text}`);
  }
  if (tick.warnings.length > 0) {
    lines.push(`warnings=${tick.warnings.length}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatFollowStartText(tick: FollowTick, options: FollowLoopOptions): string {
  return `follow target=${tick.target} id=${tick.id} status=${tick.status} duration=${formatDuration(options.durationMs)} interval=${formatDuration(options.intervalMs)} events=${options.events}\n`;
}

function formatFollowDoneText(reason: FollowResult["reason"], status: string): string {
  return `follow done reason=${reason} status=${status}\n`;
}

function simplifySessionEvent(event: ProjectedEvent, maxLine: number): FollowEventLine {
  if (event.role === "tool" || event.toolName) {
    return {
      seq: event.seq,
      role: "tool",
      label: truncate(event.toolName ?? event.summary ?? "tool", maxLine),
      status: event.status,
    };
  }
  return {
    seq: event.seq,
    role: event.role ?? event.kind,
    label: truncate(event.summary, maxLine),
    status: event.stopReason ? `stop=${event.stopReason}` : event.status,
    text: event.text ? truncate(event.text, maxLine) : undefined,
  };
}

function simplifyFlowEvent(event: unknown, seq: number, maxLine: number): FollowEventLine {
  if (!isObject(event)) {
    return { seq, role: "flow", label: "invalid trace event" };
  }
  const type = stringField(event, "type") ?? "trace";
  const nodeId = stringField(event, "nodeId");
  const payload = isObject(event.payload) ? event.payload : {};
  const status = stringField(payload, "status") ?? stringField(payload, "outcome");
  const detail = stringField(payload, "statusDetail") ?? stringField(payload, "error");
  const label = [type, nodeId].filter(Boolean).join(" ");
  return {
    seq: numberField(event, "seq") ?? seq,
    role: "flow",
    label: truncate(label || "trace", maxLine),
    status,
    text: detail ? truncate(detail, maxLine) : undefined,
  };
}

function currentFlowNode(bundle: FlowBundle): string | null {
  const live = isObject(bundle.live) ? bundle.live : undefined;
  const run = isObject(bundle.run) ? bundle.run : undefined;
  return stringField(live, "currentNode") ?? stringField(run, "currentNode") ?? null;
}

function isTerminalSessionStatus(status: string): status is SessionStatus {
  return status === "closed" || status === "dead" || status === "idle";
}

function isTerminalFlowStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timed_out";
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
