import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-inspector-test-"));
  try {
    return await fn(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

export async function writeSession(home: string, id: string, overrides: Record<string, unknown> = {}) {
  const dir = path.join(home, ".acpx", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const record = {
    schema: "acpx.session.v1",
    acpx_record_id: id,
    acp_session_id: `${id}-acp`,
    agent_session_id: `${id}-agent`,
    agent_command: "mock-agent",
    cwd: path.join(home, "repo"),
    name: "api",
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: "2026-01-01T00:02:00.000Z",
    last_prompt_at: "2026-01-01T00:01:00.000Z",
    last_seq: 2,
    event_log: {
      active_path: path.join(dir, `${encodeURIComponent(id)}.stream.ndjson`),
      segment_count: 1,
      max_segment_bytes: 67108864,
      max_segments: 5,
      last_write_at: "2026-01-01T00:02:00.000Z",
      last_write_error: null,
    },
    title: "Test session",
    messages: [
      { User: { id: "u1", content: [{ Text: "hello inspector" }] } },
      { Agent: { content: [{ Text: "hi from agent" }], tool_results: {} } },
    ],
    updated_at: "2026-01-01T00:02:00.000Z",
    cumulative_token_usage: { input_tokens: 12, output_tokens: 6 },
    request_token_usage: {},
    acpx: {
      current_mode_id: "auto",
      current_model_id: "default-model",
      available_models: ["default-model", "smart-model"],
    },
    ...overrides,
  };
  await fs.writeFile(
    path.join(dir, `${encodeURIComponent(id)}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, `${encodeURIComponent(id)}.stream.ndjson`),
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: "req-1",
        method: "session/prompt",
        params: { prompt: "hello inspector" },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hi from agent" },
          },
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: { stopReason: "end_turn" } }),
    ].join("\n") + "\n",
    "utf8",
  );
  return record;
}
