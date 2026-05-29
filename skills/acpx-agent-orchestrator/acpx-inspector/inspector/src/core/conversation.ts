import { truncate } from "./util.js";
import type { SessionMessage, SessionRecord } from "../types.js";

export function sessionIdentity(record: SessionRecord) {
  return {
    acpxRecordId: record.acpxRecordId,
    acpSessionId: record.acpSessionId,
    ...(record.agentSessionId ? { agentSessionId: record.agentSessionId } : {}),
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    ...(record.name ? { name: record.name } : {}),
  };
}

export function lastUserPreview(record: SessionRecord): string | null {
  return lastPreview(record.messages, "user");
}

export function lastAssistantPreview(record: SessionRecord): string | null {
  return lastPreview(record.messages, "assistant");
}

export function recordPreview(record: SessionRecord): string | null {
  const assistant = lastAssistantPreview(record);
  if (assistant) {
    return `Last assistant: ${assistant}`;
  }
  const user = lastUserPreview(record);
  return user ? `Last user: ${user}` : null;
}

export function turnCountApprox(record: SessionRecord): number {
  return record.messages.filter((message) => message !== "Resume" && "User" in message).length;
}

function lastPreview(messages: SessionMessage[], role: "user" | "assistant"): string | null {
  for (const message of [...messages].reverse()) {
    if (message === "Resume") {
      continue;
    }
    if (role === "user" && "User" in message) {
      const text = message.User.content.map(contentToText).filter(Boolean).join(" ");
      if (text.trim()) {
        return truncate(text);
      }
    }
    if (role === "assistant" && "Agent" in message) {
      const text = message.Agent.content.map(contentToText).filter(Boolean).join(" ");
      if (text.trim()) {
        return truncate(text);
      }
    }
  }
  return null;
}

function contentToText(raw: Record<string, unknown>): string {
  if (typeof raw.Text === "string") {
    return raw.Text;
  }
  if (raw.Mention && typeof raw.Mention === "object" && "content" in raw.Mention) {
    const content = (raw.Mention as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  }
  if (raw.Thinking && typeof raw.Thinking === "object" && "text" in raw.Thinking) {
    const text = (raw.Thinking as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  if (typeof raw.RedactedThinking === "string") {
    return "[redacted_thinking]";
  }
  if (raw.ToolUse && typeof raw.ToolUse === "object" && "name" in raw.ToolUse) {
    const name = (raw.ToolUse as { name?: unknown }).name;
    return typeof name === "string" ? `[tool:${name}]` : "[tool]";
  }
  if (raw.Image) {
    return "[image]";
  }
  if (raw.Audio) {
    return "[audio]";
  }
  return "";
}
