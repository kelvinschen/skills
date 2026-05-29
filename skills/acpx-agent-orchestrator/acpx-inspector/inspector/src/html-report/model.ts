import fs from "node:fs/promises";
import path from "node:path";
import { readSessionEvents } from "../core/event-stream.js";
import { readFlowBundle, flowStatus } from "../core/flow.js";
import { resolveSession } from "../core/resolver.js";
import { truncate, nowIso, isObject } from "../core/util.js";
import { historyView } from "../projections/history.js";
import { snapshotForRecord } from "../projections/snapshot.js";
import type { ProjectedEvent, ReportModel, SessionRef } from "../types.js";

export async function sessionReportModel(ref: SessionRef): Promise<ReportModel> {
  const resolved = await resolveSession(ref);
  if (!resolved.record) {
    return {
      schema: "acpx-inspector.report.session.v1",
      kind: "session",
      generatedAt: nowIso(),
      title: "Session not found",
      subtitle: JSON.stringify(resolved.resolution.input),
      status: resolved.resolution.status,
      summary: [{ label: "Resolution", value: resolved.resolution.status, tone: "danger" }],
      sections: [
        {
          id: "resolution",
          title: "Resolution",
          items: [{ title: resolved.resolution.status, code: JSON.stringify(resolved.resolution, null, 2) }],
        },
      ],
      actions: [],
    };
  }
  const snap = await snapshotForRecord(resolved.record, {
    stateDir: ref.stateDir,
    resolution: resolved.resolution,
    warnings: resolved.warnings,
  });
  const history = await historyView({ ...ref, id: resolved.record.acpxRecordId, tail: 120 });
  return {
    schema: "acpx-inspector.report.session.v1",
    kind: "session",
    generatedAt: nowIso(),
    title: resolved.record.title || resolved.record.name || "acpx session",
    subtitle: `${resolved.record.agentCommand} · ${resolved.record.cwd}`,
    status: snap.session?.status ?? "unknown",
    summary: [
      { label: "Status", value: snap.session?.status ?? "unknown", tone: toneForStatus(snap.session?.status) },
      { label: "Agent", value: resolved.record.agentCommand },
      { label: "Events", value: String(snap.eventLog?.availableEventCount ?? 0) },
      { label: "Last prompt", value: snap.session?.lastPromptAt ?? "n/a" },
    ],
    sections: [
      {
        id: "conversation",
        title: "Conversation",
        eyebrow: "Summary",
        items: [
          {
            title: "Latest user",
            body: snap.conversation?.lastUserPreview ?? "n/a",
          },
          {
            title: "Latest assistant",
            body: snap.conversation?.lastAssistantPreview ?? "n/a",
          },
        ],
      },
      {
        id: "timeline",
        title: "Timeline",
        eyebrow: "Session",
        items:
          history.entries?.map((entry) => ({
            title: `${entry.role} · ${entry.kind}`,
            meta: `seq ${entry.seq}`,
            body: entry.preview,
          })) ?? [],
      },
      {
        id: "health",
        title: "Health",
        items: [
          { title: snap.health?.classification ?? "unknown", body: snap.health?.reason },
          { title: "Queue evidence", code: JSON.stringify(snap.health?.queue ?? {}, null, 2) },
        ],
      },
      {
        id: "identity",
        title: "Identity",
        items: [{ title: resolved.record.acpxRecordId, code: JSON.stringify(snap.session, null, 2) }],
      },
    ],
    actions: snap.nextActions ?? [],
  };
}

export async function oneshotReportModel(input: {
  eventsFile: string;
  raw?: boolean;
}): Promise<ReportModel> {
  const payload = await fs.readFile(input.eventsFile, "utf8");
  const rawEvents = payload
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
  const events = rawEvents.map((event, index) => projectEventForReport(event, index + 1));
  const stopReason = [...events].reverse().find((event) => event.stopReason)?.stopReason ?? "unknown";
  const errors = events.filter((event) => event.kind === "error");
  const text = events
    .filter((event) => event.text)
    .map((event) => event.text)
    .join(" ");
  return {
    schema: "acpx-inspector.report.oneshot.v1",
    kind: "oneshot",
    generatedAt: nowIso(),
    title: "One-shot ACP run",
    subtitle: path.basename(input.eventsFile),
    status: errors.length > 0 ? "failed" : stopReason,
    summary: [
      { label: "Stop reason", value: stopReason, tone: errors.length > 0 ? "danger" : "success" },
      { label: "Events", value: String(events.length) },
      { label: "Errors", value: String(errors.length), tone: errors.length > 0 ? "danger" : undefined },
      { label: "Final text", value: truncate(text || "n/a", 80) },
    ],
    sections: [
      {
        id: "timeline",
        title: "Event Timeline",
        items: events.map((event) => ({
          title: event.summary,
          meta: `seq ${event.seq}${event.method ? ` · ${event.method}` : ""}`,
          body: event.text,
          tone: event.kind === "error" ? "danger" : undefined,
        })),
      },
      {
        id: "capture",
        title: "Capture",
        items: [{ title: input.eventsFile, code: input.raw ? JSON.stringify(rawEvents, null, 2) : undefined }],
      },
    ],
    actions: [],
    raw: input.raw ? rawEvents : undefined,
  };
}

export async function flowReportModel(input: {
  stateDir?: string;
  runId?: string;
  runDir?: string;
  raw?: boolean;
}): Promise<ReportModel> {
  const bundle = await readFlowBundle(input);
  const status = flowStatus(bundle);
  const steps = extractSteps(bundle.steps);
  return {
    schema: "acpx-inspector.report.flow.v1",
    kind: "flow",
    generatedAt: nowIso(),
    title: `Flow run ${bundle.runId}`,
    subtitle: bundle.runDir,
    status,
    summary: [
      { label: "Status", value: status, tone: toneForStatus(status) },
      { label: "Steps", value: String(steps.length) },
      { label: "Trace events", value: String(bundle.traceEvents.length) },
      { label: "Warnings", value: String(bundle.warnings.length), tone: bundle.warnings.length ? "warning" : undefined },
    ],
    sections: [
      {
        id: "steps",
        title: "Steps",
        eyebrow: "Flow",
        items: steps.map((step, index) => ({
          title: step.title ?? `Step ${index + 1}`,
          meta: step.meta,
          body: step.body,
          tone: toneForStatus(step.status),
        })),
      },
      {
        id: "trace",
        title: "Trace",
        items: bundle.traceEvents.slice(-80).map((event, index) => ({
          title: `Trace ${index + 1}`,
          body: truncate(JSON.stringify(event), 260),
        })),
      },
      {
        id: "raw",
        title: "Run Data",
        items: [
          {
            title: "Manifest and projections",
            code: input.raw ? JSON.stringify(bundle, null, 2) : JSON.stringify({ run: bundle.run, live: bundle.live }, null, 2),
          },
        ],
      },
    ],
    actions: [],
    raw: input.raw ? bundle : undefined,
  };
}

function projectEventForReport(raw: unknown, seq: number): ProjectedEvent {
  // Importing the session stream projection would require a SessionRecord, so keep
  // this small for one-shot captured NDJSON.
  if (!isObject(raw)) {
    return { seq, kind: "invalid", summary: "invalid event" };
  }
  const method = typeof raw.method === "string" ? raw.method : undefined;
  if (method === "session/update") {
    const params = isObject(raw.params) ? raw.params : {};
    const update = isObject(params.update) ? params.update : params;
    const content = isObject(update.content) ? update.content : {};
    return {
      seq,
      method,
      kind: "notification",
      summary: typeof update.sessionUpdate === "string" ? update.sessionUpdate : "session/update",
      text: typeof content.text === "string" ? truncate(content.text) : undefined,
    };
  }
  if (isObject(raw.result)) {
    return {
      seq,
      kind: "response",
      summary: "response",
      stopReason: typeof raw.result.stopReason === "string" ? raw.result.stopReason : undefined,
    };
  }
  if (isObject(raw.error)) {
    return { seq, kind: "error", summary: String(raw.error.message ?? "error") };
  }
  return { seq, method, kind: method ? "request" : "invalid", summary: method ?? "event" };
}

function extractSteps(raw: unknown): Array<{ title?: string; meta?: string; body?: string; status?: string }> {
  const candidates = Array.isArray(raw)
    ? raw
    : isObject(raw) && Array.isArray(raw.steps)
      ? raw.steps
      : isObject(raw) && Array.isArray(raw.items)
        ? raw.items
        : [];
  return candidates.map((entry) => {
    const record = isObject(entry) ? entry : {};
    const title =
      typeof record.nodeId === "string"
        ? record.nodeId
        : typeof record.id === "string"
          ? record.id
          : typeof record.name === "string"
            ? record.name
            : undefined;
    const status = typeof record.status === "string" ? record.status : undefined;
    return {
      title,
      status,
      meta: [record.nodeType, record.attemptId, status].filter((value) => typeof value === "string").join(" · "),
      body: truncate(JSON.stringify(record), 260),
    };
  });
}

function toneForStatus(status: string | undefined): string | undefined {
  if (!status) return undefined;
  if (["running", "idle", "end_turn", "completed", "ready"].includes(status)) return "success";
  if (["dead", "failed", "error", "timed_out"].includes(status)) return "danger";
  if (["closed", "cancelled", "unknown"].includes(status)) return "warning";
  return undefined;
}
