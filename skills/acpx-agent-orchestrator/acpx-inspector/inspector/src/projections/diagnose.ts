import { readSessionEvents } from "../core/event-stream.js";
import { resolveSession } from "../core/resolver.js";
import { nowIso } from "../core/util.js";
import { snapshotForRecord, classifyStatus } from "./snapshot.js";
import type { SessionRef } from "../types.js";

export async function diagnose(ref: SessionRef) {
  const resolved = await resolveSession(ref);
  if (!resolved.record) {
    return {
      schema: "acpx-inspector.diagnosis.v1",
      generatedAt: nowIso(),
      resolution: resolved.resolution,
      warnings: resolved.warnings,
      diagnosis: {
        status: resolved.resolution.status === "ambiguous" ? "ambiguous" : "no_session",
        findings: [],
      },
    };
  }
  const snap = await snapshotForRecord(resolved.record, {
    stateDir: ref.stateDir,
    resolution: resolved.resolution,
    warnings: resolved.warnings,
  });
  const events = await readSessionEvents(resolved.record, { stateDir: ref.stateDir, tail: 50 });
  const errors = events.events.filter((event) => event.kind === "error");
  return {
    schema: "acpx-inspector.diagnosis.v1",
    generatedAt: nowIso(),
    resolution: resolved.resolution,
    warnings: [...resolved.warnings, ...events.warnings],
    diagnosis: {
      status: snap.session?.status ?? "unknown",
      findings: [
        snap.health?.reason,
        errors.length > 0 ? `${errors.length} ACP error event(s) in recent tail` : undefined,
        resolved.record.lastAgentExitSignal ? `last signal: ${resolved.record.lastAgentExitSignal}` : undefined,
        resolved.record.lastAgentExitCode ? `last exit code: ${resolved.record.lastAgentExitCode}` : undefined,
      ].filter(Boolean),
      evidence: {
        health: snap.health,
        lastErrors: errors.slice(-5),
        eventCount: events.availableEventCount,
      },
    },
    nextActions: snap.nextActions,
  };
}
