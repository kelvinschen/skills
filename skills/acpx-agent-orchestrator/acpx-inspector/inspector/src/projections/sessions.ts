import { recordPreview, sessionIdentity } from "../core/conversation.js";
import { listSessionRecords } from "../core/session-record.js";
import { readQueueHealth } from "../core/queue.js";
import { resolveStateDir } from "../core/state-dir.js";
import { nowIso } from "../core/util.js";
import { suggestActions } from "./actions.js";
import { classifyStatus } from "./snapshot.js";
import type { SessionRef, SessionsView } from "../types.js";

export async function sessionsView(ref: SessionRef & { limit?: number }): Promise<SessionsView> {
  const { records, warnings } = await listSessionRecords(ref.stateDir);
  const filtered = records.filter((record) => {
    if (!ref.includeClosed && record.closed === true) {
      return false;
    }
    if (ref.agent && record.agentCommand !== ref.agent && !record.agentCommand.includes(ref.agent)) {
      return false;
    }
    if (ref.name != null && record.name !== ref.name) {
      return false;
    }
    if (ref.cwd && record.cwd !== ref.cwd && !record.cwd.startsWith(ref.cwd)) {
      return false;
    }
    return true;
  });
  const rows = [];
  const summary = { total: 0, active: 0, closed: 0, running: 0, idle: 0, dead: 0 };
  for (const record of filtered.slice(0, ref.limit ?? 50)) {
    const queue = await readQueueHealth(record.acpxRecordId, ref.stateDir);
    const status = classifyStatus(record, queue);
    summary.total += 1;
    if (record.closed) summary.closed += 1;
    else summary.active += 1;
    if (status === "running") summary.running += 1;
    if (status === "idle") summary.idle += 1;
    if (status === "dead") summary.dead += 1;
    const actions = await suggestActions(record, status, { stateDir: ref.stateDir });
    rows.push({
      ...sessionIdentity(record),
      status,
      closed: record.closed === true,
      title: record.title ?? null,
      lastPromptAt: record.lastPromptAt ?? null,
      lastUsedAt: record.lastUsedAt,
      lastSeq: record.lastSeq,
      mode: record.acpx?.current_mode_id ?? null,
      model: record.acpx?.current_model_id ?? null,
      preview: recordPreview(record),
      nextActionIds: actions.map((action) => action.id),
    });
  }
  return {
    schema: "acpx-inspector.sessions.v1",
    generatedAt: nowIso(),
    stateDir: resolveStateDir(ref.stateDir),
    filters: {
      cwd: ref.cwd,
      agent: ref.agent,
      name: ref.name,
      includeClosed: ref.includeClosed === true,
      limit: ref.limit ?? 50,
    },
    warnings,
    summary,
    sessions: rows,
  };
}
