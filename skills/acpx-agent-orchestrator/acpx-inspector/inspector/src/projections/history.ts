import { readSessionEvents } from "../core/event-stream.js";
import { resolveSession } from "../core/resolver.js";
import { nowIso, truncate } from "../core/util.js";
import type { HistoryView, SessionRef } from "../types.js";

export async function historyView(
  ref: SessionRef & { tail?: number; raw?: boolean; budget?: number },
): Promise<HistoryView> {
  const resolved = await resolveSession(ref);
  if (!resolved.record) {
    return {
      schema: "acpx-inspector.history.v1",
      generatedAt: nowIso(),
      resolution: resolved.resolution,
      warnings: resolved.warnings,
    };
  }
  const events = await readSessionEvents(resolved.record, {
    stateDir: ref.stateDir,
    tail: ref.tail ?? 80,
    raw: ref.raw,
  });
  const entries = events.events
    .filter((event) => event.text || event.kind === "error" || event.stopReason || event.toolName)
    .slice(-(ref.budget && ref.budget < 800 ? 12 : 30))
    .map((event) => ({
      seq: event.seq,
      role: event.role ?? "system",
      kind: event.kind,
      preview: truncate(event.text ?? event.summary),
      evidence: {
        method: event.method,
        id: event.id,
        stopReason: event.stopReason,
        status: event.status,
      },
    }));
  const errors = events.events.filter((event) => event.kind === "error").length;
  const latestStopReason = [...events.events].reverse().find((event) => event.stopReason)?.stopReason ?? null;
  return {
    schema: "acpx-inspector.history.v1",
    generatedAt: nowIso(),
    resolution: resolved.resolution,
    warnings: [...resolved.warnings, ...events.warnings],
    summary: {
      latestOutcome: errors > 0 ? "failed" : latestStopReason ? "completed" : "unknown",
      latestStopReason,
      openToolCalls: events.events.filter((event) => event.role === "tool" && event.status !== "completed").length,
      errors,
      permissionRequests: events.events.filter((event) => event.method === "session/request_permission").length,
    },
    entries,
    omitted: {
      rawEvents: Math.max(0, events.availableEventCount - entries.length),
      largePayloadBytes: 0,
    },
  };
}
