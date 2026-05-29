import fs from "node:fs/promises";
import path from "node:path";
import { sessionDir } from "./state-dir.js";
import { isObject, truncate } from "./util.js";
import type { ProjectedEvent, SessionRecord } from "../types.js";

export type EventReadResult = {
  events: ProjectedEvent[];
  rawEvents: unknown[];
  warnings: string[];
  availableEventCount: number;
};

export async function readSessionEvents(
  record: SessionRecord,
  options: { stateDir?: string; tail?: number; raw?: boolean } = {},
): Promise<EventReadResult> {
  const warnings: string[] = [];
  const files = await sessionEventFiles(record, options.stateDir);
  const rawEvents: unknown[] = [];
  let seq = 0;
  const events: ProjectedEvent[] = [];
  for (const file of files) {
    let payload: string;
    try {
      payload = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = payload.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        seq += 1;
        rawEvents.push(parsed);
        events.push(projectEvent(parsed, seq, options.raw === true));
      } catch (error) {
        const isTrailing = index === lines.length - 1;
        if (isTrailing) {
          warnings.push(`ignored trailing partial JSON line in ${file}`);
        } else {
          seq += 1;
          events.push({ seq, kind: "invalid", summary: `invalid JSON in ${file}` });
          warnings.push(`invalid JSON in ${file}: ${String(error)}`);
        }
      }
    }
  }
  const tail = options.tail && options.tail > 0 ? options.tail : undefined;
  return {
    events: tail ? events.slice(-tail) : events,
    rawEvents: tail ? rawEvents.slice(-tail) : rawEvents,
    warnings,
    availableEventCount: events.length,
  };
}

export async function sessionEventFiles(record: SessionRecord, stateDir?: string): Promise<string[]> {
  const dir = sessionDir(stateDir);
  const maxSegments = Math.max(1, record.eventLog?.max_segments ?? 5);
  const safe = encodeURIComponent(record.acpxRecordId);
  const files: string[] = [];
  for (let segment = maxSegments; segment >= 1; segment -= 1) {
    files.push(path.join(dir, `${safe}.stream.${segment}.ndjson`));
  }
  files.push(path.join(dir, `${safe}.stream.ndjson`));
  const existing: string[] = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) {
        existing.push(file);
      }
    } catch {
      // ignore
    }
  }
  return existing;
}

export function projectEvent(raw: unknown, seq: number, includeRaw = false): ProjectedEvent {
  if (!isObject(raw)) {
    return withRaw({ seq, kind: "invalid", summary: "non-object event" }, raw, includeRaw);
  }
  const id = typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : undefined;
  const method = typeof raw.method === "string" ? raw.method : undefined;
  if (method) {
    return withRaw(projectMethodEvent(raw, seq, id, method), raw, includeRaw);
  }
  if (isObject(raw.error)) {
    return withRaw(
      {
        seq,
        id,
        kind: "error",
        summary: truncate(String(raw.error.message ?? "ACP error")),
        status: String(raw.error.code ?? "error"),
      },
      raw,
      includeRaw,
    );
  }
  if (isObject(raw.result)) {
    const stopReason =
      typeof raw.result.stopReason === "string" ? raw.result.stopReason : undefined;
    return withRaw(
      {
        seq,
        id,
        kind: "response",
        summary: stopReason ? `completed: ${stopReason}` : "response",
        stopReason,
      },
      raw,
      includeRaw,
    );
  }
  return withRaw({ seq, id, kind: "invalid", summary: "unknown JSON-RPC event" }, raw, includeRaw);
}

function projectMethodEvent(
  raw: Record<string, unknown>,
  seq: number,
  id: string | number | undefined,
  method: string,
): ProjectedEvent {
  const params = isObject(raw.params) ? raw.params : {};
  if (method === "session/prompt") {
    const prompt = params.prompt;
    return {
      seq,
      id,
      method,
      kind: "request",
      role: "user",
      summary: "prompt submitted",
      text: typeof prompt === "string" ? truncate(prompt) : undefined,
    };
  }
  if (method === "session/update") {
    const update = isObject(params.update) ? params.update : isObject(params) ? params : {};
    const updateType = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "update";
    const content = isObject(update.content) ? update.content : undefined;
    const text = typeof content?.text === "string" ? truncate(content.text) : undefined;
    return {
      seq,
      method,
      kind: "notification",
      role: updateType.includes("tool") ? "tool" : "assistant",
      summary: eventSummary(updateType, update),
      text,
      toolName: typeof update.title === "string" ? update.title : undefined,
      status: typeof update.status === "string" ? update.status : undefined,
    };
  }
  if (method === "session/request_permission") {
    const toolCall = isObject(params.toolCall) ? params.toolCall : undefined;
    return {
      seq,
      id,
      method,
      kind: "request",
      role: "system",
      summary: `permission requested${typeof toolCall?.title === "string" ? `: ${toolCall.title}` : ""}`,
      toolName: typeof toolCall?.title === "string" ? toolCall.title : undefined,
    };
  }
  return {
    seq,
    id,
    method,
    kind: id == null ? "notification" : "request",
    summary: method,
  };
}

function eventSummary(updateType: string, update: Record<string, unknown>): string {
  if (updateType === "agent_message_chunk") {
    return "assistant text";
  }
  if (updateType === "agent_thought_chunk") {
    return "assistant thinking";
  }
  if (updateType === "tool_call" || updateType === "tool_call_update") {
    const title = typeof update.title === "string" ? update.title : "tool";
    const status = typeof update.status === "string" ? update.status : "updated";
    return `${title} ${status}`;
  }
  return updateType;
}

function withRaw<T extends ProjectedEvent>(event: T, raw: unknown, includeRaw: boolean): T {
  if (includeRaw) {
    return { ...event, raw };
  }
  return event;
}
