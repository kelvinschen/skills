import { lastAssistantPreview, lastUserPreview, recordPreview, sessionIdentity, turnCountApprox } from "../core/conversation.js";
import { readSessionEvents } from "../core/event-stream.js";
import { readQueueHealth } from "../core/queue.js";
import { resolveSession } from "../core/resolver.js";
import { resolveStateDir } from "../core/state-dir.js";
import { nowIso } from "../core/util.js";
import { suggestActions } from "./actions.js";
import type { SessionRecord, SessionRef, SessionStatus, Snapshot } from "../types.js";

export async function snapshot(ref: SessionRef): Promise<Snapshot> {
  const resolved = await resolveSession(ref);
  if (!resolved.record) {
    return {
      schema: "acpx-inspector.snapshot.v1",
      generatedAt: nowIso(),
      resolution: resolved.resolution,
      warnings: resolved.warnings,
    };
  }
  return snapshotForRecord(resolved.record, {
    stateDir: ref.stateDir,
    resolution: resolved.resolution,
    warnings: resolved.warnings,
  });
}

export async function snapshotForRecord(
  record: SessionRecord,
  options: { stateDir?: string; resolution: Snapshot["resolution"]; warnings?: string[] },
): Promise<Snapshot> {
  const queue = await readQueueHealth(record.acpxRecordId, options.stateDir);
  const status = classifyStatus(record, queue);
  const events = await readSessionEvents(record, { stateDir: options.stateDir, tail: 0 });
  const warnings = [...(options.warnings ?? []), ...events.warnings];
  const nextActions = await suggestActions(record, status, { stateDir: options.stateDir });
  const activePath = record.eventLog?.active_path ?? null;
  return {
    schema: "acpx-inspector.snapshot.v1",
    generatedAt: nowIso(),
    resolution: options.resolution,
    warnings,
    session: {
      ...sessionIdentity(record),
      status,
      closed: record.closed === true,
      mode: record.acpx?.current_mode_id ?? null,
      model: record.acpx?.current_model_id ?? null,
      availableModels: record.acpx?.available_models ?? null,
      createdAt: record.createdAt,
      lastPromptAt: record.lastPromptAt ?? null,
      lastUsedAt: record.lastUsedAt,
      lastSeq: record.lastSeq,
      lastRequestId: record.lastRequestId ?? null,
    },
    conversation: {
      messageCount: record.messages.length,
      turnCountApprox: turnCountApprox(record),
      lastUserPreview: lastUserPreview(record),
      lastAssistantPreview: lastAssistantPreview(record),
      tokenUsage: record.cumulativeTokenUsage,
    },
    eventLog: {
      activePath,
      segmentCount: record.eventLog?.segment_count ?? 0,
      maxSegments: record.eventLog?.max_segments ?? 0,
      lastWriteAt: record.eventLog?.last_write_at ?? null,
      availableEventCount: events.availableEventCount,
    },
    health: {
      classification: status,
      queue,
      reason: statusReason(status, record),
    },
    nextActions,
  };
}

export function classifyStatus(record: SessionRecord, queue: { hasLease: boolean; healthy: boolean; pidAlive: boolean }): SessionStatus {
  if (record.closed === true) {
    return "closed";
  }
  if (queue.healthy) {
    return "running";
  }
  if (queue.hasLease && !queue.healthy) {
    return "dead";
  }
  if (record.lastAgentExitSignal || (record.lastAgentExitCode ?? 0) !== 0) {
    return "dead";
  }
  return "idle";
}

function statusReason(status: SessionStatus, record: SessionRecord): string {
  switch (status) {
    case "closed":
      return "session is soft-closed and skipped by auto-resume";
    case "running":
      return "queue owner appears healthy";
    case "dead":
      return "queue owner or last agent exit indicates abnormal state";
    case "idle":
      return "saved session is open and resumable";
    default:
      return `session ${record.acpxRecordId} status is ${status}`;
  }
}
