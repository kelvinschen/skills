import fs from "node:fs/promises";
import path from "node:path";
import { sessionDir } from "./state-dir.js";
import { booleanValue, isObject, numberValue, stringValue } from "./util.js";
import type { JsonObject, SessionMessage, SessionRecord } from "../types.js";

export async function listSessionRecords(stateDir?: string): Promise<{
  records: SessionRecord[];
  warnings: string[];
}> {
  const dir = sessionDir(stateDir);
  const warnings: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], warnings: [] };
    }
    return { records: [], warnings: [`failed to read session dir ${dir}: ${String(error)}`] };
  }

  const records: SessionRecord[] = [];
  for (const name of names.toSorted()) {
    if (!name.endsWith(".json") || name === "index.json") {
      continue;
    }
    const filePath = path.join(dir, name);
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      const record = parseSessionRecord(parsed, filePath);
      if (record) {
        records.push(record);
      }
    } catch (error) {
      warnings.push(`failed to parse ${filePath}: ${String(error)}`);
    }
  }

  records.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return { records, warnings };
}

export async function readSessionRecordFile(filePath: string): Promise<SessionRecord | undefined> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  return parseSessionRecord(parsed, filePath) ?? undefined;
}

export function parseSessionRecord(raw: unknown, filePath = ""): SessionRecord | undefined {
  if (!isObject(raw) || raw.schema !== "acpx.session.v1") {
    return undefined;
  }

  const acpxRecordId = stringValue(raw.acpx_record_id);
  const acpSessionId = stringValue(raw.acp_session_id);
  const agentCommand = stringValue(raw.agent_command);
  const cwd = stringValue(raw.cwd);
  const createdAt = stringValue(raw.created_at);
  const lastUsedAt = stringValue(raw.last_used_at);
  const lastSeq = numberValue(raw.last_seq);
  const updatedAt = stringValue(raw.updated_at);
  if (
    !acpxRecordId ||
    !acpSessionId ||
    !agentCommand ||
    !cwd ||
    !createdAt ||
    !lastUsedAt ||
    lastSeq == null ||
    !updatedAt
  ) {
    return undefined;
  }

  const acpx = isObject(raw.acpx) ? raw.acpx : undefined;
  const eventLog = isObject(raw.event_log)
    ? {
        active_path: stringValue(raw.event_log.active_path),
        segment_count: numberValue(raw.event_log.segment_count),
        max_segment_bytes: numberValue(raw.event_log.max_segment_bytes),
        max_segments: numberValue(raw.event_log.max_segments),
        last_write_at: stringValue(raw.event_log.last_write_at),
        last_write_error:
          raw.event_log.last_write_error == null
            ? null
            : stringValue(raw.event_log.last_write_error),
      }
    : undefined;

  return {
    schema: "acpx.session.v1",
    acpxRecordId,
    acpSessionId,
    agentSessionId: stringValue(raw.agent_session_id),
    agentCommand,
    cwd,
    name: stringValue(raw.name),
    createdAt,
    lastUsedAt,
    lastSeq,
    lastRequestId: stringValue(raw.last_request_id),
    eventLog,
    closed: booleanValue(raw.closed),
    closedAt: stringValue(raw.closed_at),
    pid: numberValue(raw.pid),
    agentStartedAt: stringValue(raw.agent_started_at),
    lastPromptAt: stringValue(raw.last_prompt_at),
    lastAgentExitCode: raw.last_agent_exit_code === null ? null : numberValue(raw.last_agent_exit_code),
    lastAgentExitSignal:
      raw.last_agent_exit_signal === null ? null : stringValue(raw.last_agent_exit_signal),
    lastAgentExitAt: stringValue(raw.last_agent_exit_at),
    lastAgentDisconnectReason: stringValue(raw.last_agent_disconnect_reason),
    title: raw.title == null ? null : stringValue(raw.title),
    messages: Array.isArray(raw.messages) ? (raw.messages as SessionMessage[]) : [],
    updatedAt,
    cumulativeTokenUsage: isObject(raw.cumulative_token_usage)
      ? numericRecord(raw.cumulative_token_usage)
      : {},
    requestTokenUsage: isObject(raw.request_token_usage)
      ? Object.fromEntries(
          Object.entries(raw.request_token_usage).map(([key, value]) => [
            key,
            isObject(value) ? numericRecord(value) : {},
          ]),
        )
      : {},
    acpx: acpx
      ? {
          current_mode_id: stringValue(acpx.current_mode_id),
          desired_mode_id: stringValue(acpx.desired_mode_id),
          current_model_id: stringValue(acpx.current_model_id),
          available_models: stringArray(acpx.available_models),
          available_commands: stringArray(acpx.available_commands),
          desired_config_options: isObject(acpx.desired_config_options)
            ? Object.fromEntries(
                Object.entries(acpx.desired_config_options).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              )
            : undefined,
          config_options: Array.isArray(acpx.config_options) ? acpx.config_options : undefined,
          session_options: acpx.session_options,
        }
      : undefined,
    raw: raw as JsonObject,
    filePath,
  };
}

function numericRecord(record: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}
