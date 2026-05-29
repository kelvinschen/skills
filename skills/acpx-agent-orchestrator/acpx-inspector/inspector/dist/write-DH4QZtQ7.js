import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
//#region src/core/state-dir.ts
function resolveStateDir(input) {
	return path.resolve(input ? expandHome(input) : path.join(os.homedir(), ".acpx"));
}
function expandHome(value) {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}
function sessionDir(stateDir) {
	return path.join(resolveStateDir(stateDir), "sessions");
}
function flowsRunsDir(stateDir) {
	return path.join(resolveStateDir(stateDir), "flows", "runs");
}
//#endregion
//#region src/core/util.ts
function isObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function stringValue(value) {
	return typeof value === "string" ? value : void 0;
}
function numberValue(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function booleanValue(value) {
	return typeof value === "boolean" ? value : void 0;
}
function truncate(value, max = 220) {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
function isProcessAlive(pid) {
	if (!pid || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function shellQuote(value) {
	if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
//#endregion
//#region src/core/event-stream.ts
async function readSessionEvents(record, options = {}) {
	const warnings = [];
	const files = await sessionEventFiles(record, options.stateDir);
	const rawEvents = [];
	let seq = 0;
	const events = [];
	for (const file of files) {
		let payload;
		try {
			payload = await fs.readFile(file, "utf8");
		} catch {
			continue;
		}
		const lines = payload.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index]?.trim();
			if (!line) continue;
			try {
				const parsed = JSON.parse(line);
				seq += 1;
				rawEvents.push(parsed);
				events.push(projectEvent(parsed, seq, options.raw === true));
			} catch (error) {
				if (index === lines.length - 1) warnings.push(`ignored trailing partial JSON line in ${file}`);
				else {
					seq += 1;
					events.push({
						seq,
						kind: "invalid",
						summary: `invalid JSON in ${file}`
					});
					warnings.push(`invalid JSON in ${file}: ${String(error)}`);
				}
			}
		}
	}
	const tail = options.tail && options.tail > 0 ? options.tail : void 0;
	return {
		events: tail ? events.slice(-tail) : events,
		rawEvents: tail ? rawEvents.slice(-tail) : rawEvents,
		warnings,
		availableEventCount: events.length
	};
}
async function sessionEventFiles(record, stateDir) {
	const dir = sessionDir(stateDir);
	const maxSegments = Math.max(1, record.eventLog?.max_segments ?? 5);
	const safe = encodeURIComponent(record.acpxRecordId);
	const files = [];
	for (let segment = maxSegments; segment >= 1; segment -= 1) files.push(path.join(dir, `${safe}.stream.${segment}.ndjson`));
	files.push(path.join(dir, `${safe}.stream.ndjson`));
	const existing = [];
	for (const file of files) try {
		if ((await fs.stat(file)).isFile()) existing.push(file);
	} catch {}
	return existing;
}
function projectEvent(raw, seq, includeRaw = false) {
	if (!isObject(raw)) return withRaw({
		seq,
		kind: "invalid",
		summary: "non-object event"
	}, raw, includeRaw);
	const id = typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : void 0;
	const method = typeof raw.method === "string" ? raw.method : void 0;
	if (method) return withRaw(projectMethodEvent(raw, seq, id, method), raw, includeRaw);
	if (isObject(raw.error)) return withRaw({
		seq,
		id,
		kind: "error",
		summary: truncate(String(raw.error.message ?? "ACP error")),
		status: String(raw.error.code ?? "error")
	}, raw, includeRaw);
	if (isObject(raw.result)) {
		const stopReason = typeof raw.result.stopReason === "string" ? raw.result.stopReason : void 0;
		return withRaw({
			seq,
			id,
			kind: "response",
			summary: stopReason ? `completed: ${stopReason}` : "response",
			stopReason
		}, raw, includeRaw);
	}
	return withRaw({
		seq,
		id,
		kind: "invalid",
		summary: "unknown JSON-RPC event"
	}, raw, includeRaw);
}
function projectMethodEvent(raw, seq, id, method) {
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
			text: typeof prompt === "string" ? truncate(prompt) : void 0
		};
	}
	if (method === "session/update") {
		const update = isObject(params.update) ? params.update : isObject(params) ? params : {};
		const updateType = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "update";
		const content = isObject(update.content) ? update.content : void 0;
		const text = typeof content?.text === "string" ? truncate(content.text) : void 0;
		return {
			seq,
			method,
			kind: "notification",
			role: updateType.includes("tool") ? "tool" : "assistant",
			summary: eventSummary(updateType, update),
			text,
			toolName: typeof update.title === "string" ? update.title : void 0,
			status: typeof update.status === "string" ? update.status : void 0
		};
	}
	if (method === "session/request_permission") {
		const toolCall = isObject(params.toolCall) ? params.toolCall : void 0;
		return {
			seq,
			id,
			method,
			kind: "request",
			role: "system",
			summary: `permission requested${typeof toolCall?.title === "string" ? `: ${toolCall.title}` : ""}`,
			toolName: typeof toolCall?.title === "string" ? toolCall.title : void 0
		};
	}
	return {
		seq,
		id,
		method,
		kind: id == null ? "notification" : "request",
		summary: method
	};
}
function eventSummary(updateType, update) {
	if (updateType === "agent_message_chunk") return "assistant text";
	if (updateType === "agent_thought_chunk") return "assistant thinking";
	if (updateType === "tool_call" || updateType === "tool_call_update") return `${typeof update.title === "string" ? update.title : "tool"} ${typeof update.status === "string" ? update.status : "updated"}`;
	return updateType;
}
function withRaw(event, raw, includeRaw) {
	if (includeRaw) return {
		...event,
		raw
	};
	return event;
}
//#endregion
//#region src/core/session-record.ts
async function listSessionRecords(stateDir) {
	const dir = sessionDir(stateDir);
	const warnings = [];
	let names;
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		if (error.code === "ENOENT") return {
			records: [],
			warnings: []
		};
		return {
			records: [],
			warnings: [`failed to read session dir ${dir}: ${String(error)}`]
		};
	}
	const records = [];
	for (const name of names.toSorted()) {
		if (!name.endsWith(".json") || name === "index.json") continue;
		const filePath = path.join(dir, name);
		try {
			const record = parseSessionRecord(JSON.parse(await fs.readFile(filePath, "utf8")), filePath);
			if (record) records.push(record);
		} catch (error) {
			warnings.push(`failed to parse ${filePath}: ${String(error)}`);
		}
	}
	records.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
	return {
		records,
		warnings
	};
}
function parseSessionRecord(raw, filePath = "") {
	if (!isObject(raw) || raw.schema !== "acpx.session.v1") return;
	const acpxRecordId = stringValue(raw.acpx_record_id);
	const acpSessionId = stringValue(raw.acp_session_id);
	const agentCommand = stringValue(raw.agent_command);
	const cwd = stringValue(raw.cwd);
	const createdAt = stringValue(raw.created_at);
	const lastUsedAt = stringValue(raw.last_used_at);
	const lastSeq = numberValue(raw.last_seq);
	const updatedAt = stringValue(raw.updated_at);
	if (!acpxRecordId || !acpSessionId || !agentCommand || !cwd || !createdAt || !lastUsedAt || lastSeq == null || !updatedAt) return;
	const acpx = isObject(raw.acpx) ? raw.acpx : void 0;
	const eventLog = isObject(raw.event_log) ? {
		active_path: stringValue(raw.event_log.active_path),
		segment_count: numberValue(raw.event_log.segment_count),
		max_segment_bytes: numberValue(raw.event_log.max_segment_bytes),
		max_segments: numberValue(raw.event_log.max_segments),
		last_write_at: stringValue(raw.event_log.last_write_at),
		last_write_error: raw.event_log.last_write_error == null ? null : stringValue(raw.event_log.last_write_error)
	} : void 0;
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
		lastAgentExitSignal: raw.last_agent_exit_signal === null ? null : stringValue(raw.last_agent_exit_signal),
		lastAgentExitAt: stringValue(raw.last_agent_exit_at),
		lastAgentDisconnectReason: stringValue(raw.last_agent_disconnect_reason),
		title: raw.title == null ? null : stringValue(raw.title),
		messages: Array.isArray(raw.messages) ? raw.messages : [],
		updatedAt,
		cumulativeTokenUsage: isObject(raw.cumulative_token_usage) ? numericRecord(raw.cumulative_token_usage) : {},
		requestTokenUsage: isObject(raw.request_token_usage) ? Object.fromEntries(Object.entries(raw.request_token_usage).map(([key, value]) => [key, isObject(value) ? numericRecord(value) : {}])) : {},
		acpx: acpx ? {
			current_mode_id: stringValue(acpx.current_mode_id),
			desired_mode_id: stringValue(acpx.desired_mode_id),
			current_model_id: stringValue(acpx.current_model_id),
			available_models: stringArray(acpx.available_models),
			available_commands: stringArray(acpx.available_commands),
			desired_config_options: isObject(acpx.desired_config_options) ? Object.fromEntries(Object.entries(acpx.desired_config_options).filter((entry) => typeof entry[1] === "string")) : void 0,
			config_options: Array.isArray(acpx.config_options) ? acpx.config_options : void 0,
			session_options: acpx.session_options
		} : void 0,
		raw,
		filePath
	};
}
function numericRecord(record) {
	return Object.fromEntries(Object.entries(record).filter((entry) => typeof entry[1] === "number"));
}
function stringArray(value) {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : void 0;
}
//#endregion
//#region src/core/conversation.ts
function sessionIdentity(record) {
	return {
		acpxRecordId: record.acpxRecordId,
		acpSessionId: record.acpSessionId,
		...record.agentSessionId ? { agentSessionId: record.agentSessionId } : {},
		agentCommand: record.agentCommand,
		cwd: record.cwd,
		...record.name ? { name: record.name } : {}
	};
}
function lastUserPreview(record) {
	return lastPreview(record.messages, "user");
}
function lastAssistantPreview(record) {
	return lastPreview(record.messages, "assistant");
}
function recordPreview(record) {
	const assistant = lastAssistantPreview(record);
	if (assistant) return `Last assistant: ${assistant}`;
	const user = lastUserPreview(record);
	return user ? `Last user: ${user}` : null;
}
function turnCountApprox(record) {
	return record.messages.filter((message) => message !== "Resume" && "User" in message).length;
}
function lastPreview(messages, role) {
	for (const message of [...messages].reverse()) {
		if (message === "Resume") continue;
		if (role === "user" && "User" in message) {
			const text = message.User.content.map(contentToText).filter(Boolean).join(" ");
			if (text.trim()) return truncate(text);
		}
		if (role === "assistant" && "Agent" in message) {
			const text = message.Agent.content.map(contentToText).filter(Boolean).join(" ");
			if (text.trim()) return truncate(text);
		}
	}
	return null;
}
function contentToText(raw) {
	if (typeof raw.Text === "string") return raw.Text;
	if (raw.Mention && typeof raw.Mention === "object" && "content" in raw.Mention) {
		const content = raw.Mention.content;
		return typeof content === "string" ? content : "";
	}
	if (raw.Thinking && typeof raw.Thinking === "object" && "text" in raw.Thinking) {
		const text = raw.Thinking.text;
		return typeof text === "string" ? text : "";
	}
	if (typeof raw.RedactedThinking === "string") return "[redacted_thinking]";
	if (raw.ToolUse && typeof raw.ToolUse === "object" && "name" in raw.ToolUse) {
		const name = raw.ToolUse.name;
		return typeof name === "string" ? `[tool:${name}]` : "[tool]";
	}
	if (raw.Image) return "[image]";
	if (raw.Audio) return "[audio]";
	return "";
}
//#endregion
//#region src/core/resolver.ts
async function resolveSession(ref) {
	const { records, warnings } = await listSessionRecords(ref.stateDir);
	const input = cleanInput(ref);
	if (ref.id) {
		const exact = records.filter((record) => idValues(record).includes(ref.id ?? ""));
		if (exact.length === 1) return {
			resolution: {
				status: "resolved",
				strategy: "id_exact",
				input,
				matched: sessionIdentity(exact[0])
			},
			record: exact[0],
			warnings
		};
		if (exact.length > 1) return ambiguous(input, exact, warnings);
		const suffix = records.filter((record) => idValues(record).some((value) => value.endsWith(ref.id ?? "")));
		if (suffix.length === 1) return {
			resolution: {
				status: "resolved",
				strategy: "id_suffix",
				input,
				matched: sessionIdentity(suffix[0])
			},
			record: suffix[0],
			warnings
		};
		if (suffix.length > 1) return ambiguous(input, suffix, warnings);
		return {
			resolution: {
				status: "not_found",
				input
			},
			warnings
		};
	}
	const byScope = resolveByScope(records, ref);
	if (byScope.length === 1) return {
		resolution: {
			status: "resolved",
			strategy: "scope",
			input,
			matched: sessionIdentity(byScope[0])
		},
		record: byScope[0],
		warnings
	};
	if (byScope.length > 1) return ambiguous(input, byScope, warnings);
	return {
		resolution: {
			status: "not_found",
			input
		},
		warnings
	};
}
function resolveByScope(records, ref) {
	const cwd = ref.cwd ? path.resolve(ref.cwd) : void 0;
	return records.filter((record) => {
		if (!ref.includeClosed && record.closed === true) return false;
		if (ref.agent && record.agentCommand !== ref.agent && !record.agentCommand.includes(ref.agent)) return false;
		if (ref.name != null && record.name !== ref.name) return false;
		if (!cwd) return true;
		return record.cwd === cwd || isParent(record.cwd, cwd);
	}).sort((a, b) => b.cwd.length - a.cwd.length || b.lastUsedAt.localeCompare(a.lastUsedAt));
}
function isParent(parent, child) {
	const relative = path.relative(parent, child);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function idValues(record) {
	return [
		record.acpxRecordId,
		record.acpSessionId,
		record.agentSessionId
	].filter((entry) => Boolean(entry));
}
function ambiguous(input, records, warnings) {
	return {
		resolution: {
			status: "ambiguous",
			input,
			candidates: records.map(sessionIdentity)
		},
		warnings
	};
}
function cleanInput(ref) {
	return Object.fromEntries(Object.entries(ref).filter(([, value]) => value !== void 0 && value !== null && value !== false && value !== ""));
}
//#endregion
//#region src/projections/history.ts
async function historyView(ref) {
	const resolved = await resolveSession(ref);
	if (!resolved.record) return {
		schema: "acpx-inspector.history.v1",
		generatedAt: nowIso(),
		resolution: resolved.resolution,
		warnings: resolved.warnings
	};
	const events = await readSessionEvents(resolved.record, {
		stateDir: ref.stateDir,
		tail: ref.tail ?? 80,
		raw: ref.raw
	});
	const entries = events.events.filter((event) => event.text || event.kind === "error" || event.stopReason || event.toolName).slice(-(ref.budget && ref.budget < 800 ? 12 : 30)).map((event) => ({
		seq: event.seq,
		role: event.role ?? "system",
		kind: event.kind,
		preview: truncate(event.text ?? event.summary),
		evidence: {
			method: event.method,
			id: event.id,
			stopReason: event.stopReason,
			status: event.status
		}
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
			permissionRequests: events.events.filter((event) => event.method === "session/request_permission").length
		},
		entries,
		omitted: {
			rawEvents: Math.max(0, events.availableEventCount - entries.length),
			largePayloadBytes: 0
		}
	};
}
//#endregion
//#region src/core/queue.ts
function shortHash(value, length) {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}
function queueLockPath(sessionId, stateDir) {
	const resolved = resolveStateDir(stateDir);
	path.dirname(resolved);
	return path.join(resolved, "queues", `${shortHash(sessionId, 24)}.lock`);
}
async function readQueueHealth(sessionId, stateDir) {
	const lockPath = queueLockPath(sessionId, stateDir);
	try {
		const parsed = JSON.parse(await fs.readFile(lockPath, "utf8"));
		if (!isObject(parsed)) return {
			hasLease: true,
			healthy: false,
			pidAlive: false,
			lockPath
		};
		const pid = numberValue(parsed.pid);
		const pidAlive = isProcessAlive(pid);
		const heartbeatAt = stringValue(parsed.heartbeatAt);
		const stale = heartbeatAt ? Date.now() - Date.parse(heartbeatAt) > 15e3 : true;
		return {
			hasLease: true,
			healthy: pidAlive && !stale,
			pidAlive,
			pid,
			socketPath: stringValue(parsed.socketPath),
			queueDepth: numberValue(parsed.queueDepth),
			heartbeatAt,
			stale,
			lockPath
		};
	} catch {
		return {
			hasLease: false,
			healthy: false,
			pidAlive: false,
			lockPath
		};
	}
}
//#endregion
//#region src/core/agents.ts
const BUILT_INS = {
	pi: "npx pi-acp@^0.0.26",
	openclaw: "openclaw acp",
	codex: "npx -y @agentclientprotocol/codex-acp@^0.0.44",
	claude: "npx -y @agentclientprotocol/claude-agent-acp@^0.37.0",
	gemini: "gemini --acp",
	cursor: "cursor-agent acp",
	copilot: "copilot --acp --stdio",
	droid: "droid exec --output-format acp",
	iflow: "iflow --experimental-acp",
	kilocode: "npx -y @kilocode/cli acp",
	kimi: "kimi acp",
	kiro: "kiro-cli-chat acp",
	opencode: "npx -y opencode-ai acp",
	qoder: "qodercli --acp",
	qwen: "qwen --acp",
	trae: "traecli acp serve"
};
async function loadConfiguredAgents(stateDir, cwd) {
	const configs = [path.join(resolveStateDir(stateDir), "config.json"), cwd ? path.join(path.resolve(cwd), ".acpxrc.json") : void 0].filter((entry) => Boolean(entry));
	const result = {};
	for (const file of configs) try {
		const parsed = JSON.parse(await fs.readFile(file, "utf8"));
		if (!isObject(parsed) || !isObject(parsed.agents)) continue;
		for (const [name, raw] of Object.entries(parsed.agents)) {
			if (!isObject(raw) || typeof raw.command !== "string" || raw.command.trim().length === 0) continue;
			const args = Array.isArray(raw.args) ? raw.args.filter((arg) => typeof arg === "string") : [];
			result[name.toLowerCase()] = args.length > 0 ? `${raw.command.trim()} ${args.map(shellQuote).join(" ")}` : raw.command.trim();
		}
	} catch {}
	return result;
}
async function agentDisplayName(agentCommand, options = {}) {
	const configured = await loadConfiguredAgents(options.stateDir, options.cwd);
	for (const [name, command] of Object.entries({
		...BUILT_INS,
		...configured
	})) if (command === agentCommand || commandWithoutPinnedRange(command) === commandWithoutPinnedRange(agentCommand)) return name;
}
async function acpxCommandPrefix(agentCommand, cwd, options = {}) {
	const name = await agentDisplayName(agentCommand, {
		stateDir: options.stateDir,
		cwd
	});
	if (name) return `acpx --cwd ${shellQuote(cwd)} ${shellQuote(name)}`;
	return `acpx --agent ${shellQuote(agentCommand)} --cwd ${shellQuote(cwd)}`;
}
function commandWithoutPinnedRange(value) {
	return value.replace(/@\^[0-9][^\s]*/g, "").replace(/@latest/g, "").trim();
}
//#endregion
//#region src/projections/actions.ts
async function suggestActions(record, status, options = {}) {
	const prefix = await acpxCommandPrefix(record.agentCommand, record.cwd, { stateDir: options.stateDir });
	const sessionFlag = record.name ? ` -s ${quoteArg(record.name)}` : "";
	const promptCommand = `${prefix}${sessionFlag} '<prompt>'`;
	const actions = [{
		id: "read",
		label: "Read compact history",
		safety: "read_only",
		requiresConfirmation: false,
		command: `acpx-inspector read --id ${quoteArg(record.acpxRecordId)}`,
		why: "Read a compact summary without mutating the session."
	}, {
		id: "report_session",
		label: "Generate session report",
		safety: "read_only",
		requiresConfirmation: false,
		command: `acpx-inspector report session --id ${quoteArg(record.acpxRecordId)} --output session-${safeFilePart(record.acpxRecordId)}.html`,
		why: "Create a static HTML report for human review."
	}];
	if (status === "running") {
		actions.push({
			id: "tail",
			label: "Tail progress",
			safety: "read_only",
			requiresConfirmation: false,
			command: `acpx-inspector tail --id ${quoteArg(record.acpxRecordId)} --events 50`,
			why: "Session is running; tailing gives progress without interrupting."
		}, {
			id: "queue_prompt",
			label: "Queue follow-up prompt",
			safety: "reversible",
			requiresConfirmation: false,
			command: `${prefix}${sessionFlag} --no-wait '<prompt>'`,
			why: "A prompt appears to be running; --no-wait queues the next turn."
		}, {
			id: "cancel",
			label: "Cancel current turn",
			safety: "interrupting",
			requiresConfirmation: true,
			command: `${prefix} cancel${sessionFlag}`,
			why: "Cancel can interrupt in-flight work."
		});
		return actions;
	}
	if (status === "idle") {
		actions.push({
			id: "prompt",
			label: "Send follow-up prompt",
			safety: "reversible",
			requiresConfirmation: false,
			command: promptCommand,
			why: "Session is open and idle."
		}, {
			id: "set_mode",
			label: "Set mode",
			safety: "reversible",
			requiresConfirmation: false,
			command: `${prefix} set-mode <mode>${sessionFlag}`,
			why: "The session can receive mode changes through acpx."
		}, {
			id: "set_model",
			label: "Set model",
			safety: "reversible",
			requiresConfirmation: false,
			command: `${prefix} set model <model-id>${sessionFlag}`,
			why: "The session can receive model changes through acpx."
		}, {
			id: "close",
			label: "Close session",
			safety: "destructive",
			requiresConfirmation: true,
			command: `${prefix} sessions close${record.name ? ` ${quoteArg(record.name)}` : ""}`,
			why: "Closing stops auto-resume for this session."
		});
		return actions;
	}
	if (status === "closed") {
		actions.push({
			id: "export",
			label: "Export session",
			safety: "read_only",
			requiresConfirmation: false,
			command: `${prefix} sessions export${record.name ? ` ${quoteArg(record.name)}` : ""} --output ${safeFilePart(record.acpxRecordId)}.json`,
			why: "Closed sessions can still be exported for archival or transfer."
		}, {
			id: "prune_dry_run",
			label: "Preview prune",
			safety: "read_only",
			requiresConfirmation: false,
			command: `${prefix} sessions prune --dry-run`,
			why: "Preview deletion candidates before pruning."
		});
		return actions;
	}
	if (status === "dead") actions.push({
		id: "prompt",
		label: "Attempt reconnect with prompt",
		safety: "reversible",
		requiresConfirmation: false,
		command: promptCommand,
		why: "acpx can attempt to reconnect or reload saved sessions on the next prompt."
	});
	return actions;
}
function quoteArg(value) {
	return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
function safeFilePart(value) {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48);
}
//#endregion
//#region src/projections/snapshot.ts
async function snapshot(ref) {
	const resolved = await resolveSession(ref);
	if (!resolved.record) return {
		schema: "acpx-inspector.snapshot.v1",
		generatedAt: nowIso(),
		resolution: resolved.resolution,
		warnings: resolved.warnings
	};
	return snapshotForRecord(resolved.record, {
		stateDir: ref.stateDir,
		resolution: resolved.resolution,
		warnings: resolved.warnings
	});
}
async function snapshotForRecord(record, options) {
	const queue = await readQueueHealth(record.acpxRecordId, options.stateDir);
	const status = classifyStatus(record, queue);
	const events = await readSessionEvents(record, {
		stateDir: options.stateDir,
		tail: 0
	});
	const warnings = [...options.warnings ?? [], ...events.warnings];
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
			lastRequestId: record.lastRequestId ?? null
		},
		conversation: {
			messageCount: record.messages.length,
			turnCountApprox: turnCountApprox(record),
			lastUserPreview: lastUserPreview(record),
			lastAssistantPreview: lastAssistantPreview(record),
			tokenUsage: record.cumulativeTokenUsage
		},
		eventLog: {
			activePath,
			segmentCount: record.eventLog?.segment_count ?? 0,
			maxSegments: record.eventLog?.max_segments ?? 0,
			lastWriteAt: record.eventLog?.last_write_at ?? null,
			availableEventCount: events.availableEventCount
		},
		health: {
			classification: status,
			queue,
			reason: statusReason(status, record)
		},
		nextActions
	};
}
function classifyStatus(record, queue) {
	if (record.closed === true) return "closed";
	if (queue.healthy) return "running";
	if (queue.hasLease && !queue.healthy) return "dead";
	if (record.lastAgentExitSignal || (record.lastAgentExitCode ?? 0) !== 0) return "dead";
	return "idle";
}
function statusReason(status, record) {
	switch (status) {
		case "closed": return "session is soft-closed and skipped by auto-resume";
		case "running": return "queue owner appears healthy";
		case "dead": return "queue owner or last agent exit indicates abnormal state";
		case "idle": return "saved session is open and resumable";
		default: return `session ${record.acpxRecordId} status is ${status}`;
	}
}
//#endregion
//#region src/projections/sessions.ts
async function sessionsView(ref) {
	const { records, warnings } = await listSessionRecords(ref.stateDir);
	const filtered = records.filter((record) => {
		if (!ref.includeClosed && record.closed === true) return false;
		if (ref.agent && record.agentCommand !== ref.agent && !record.agentCommand.includes(ref.agent)) return false;
		if (ref.name != null && record.name !== ref.name) return false;
		if (ref.cwd && record.cwd !== ref.cwd && !record.cwd.startsWith(ref.cwd)) return false;
		return true;
	});
	const rows = [];
	const summary = {
		total: 0,
		active: 0,
		closed: 0,
		running: 0,
		idle: 0,
		dead: 0
	};
	for (const record of filtered.slice(0, ref.limit ?? 50)) {
		const status = classifyStatus(record, await readQueueHealth(record.acpxRecordId, ref.stateDir));
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
			nextActionIds: actions.map((action) => action.id)
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
			limit: ref.limit ?? 50
		},
		warnings,
		summary,
		sessions: rows
	};
}
//#endregion
//#region src/projections/diagnose.ts
async function diagnose(ref) {
	const resolved = await resolveSession(ref);
	if (!resolved.record) return {
		schema: "acpx-inspector.diagnosis.v1",
		generatedAt: nowIso(),
		resolution: resolved.resolution,
		warnings: resolved.warnings,
		diagnosis: {
			status: resolved.resolution.status === "ambiguous" ? "ambiguous" : "no_session",
			findings: []
		}
	};
	const snap = await snapshotForRecord(resolved.record, {
		stateDir: ref.stateDir,
		resolution: resolved.resolution,
		warnings: resolved.warnings
	});
	const events = await readSessionEvents(resolved.record, {
		stateDir: ref.stateDir,
		tail: 50
	});
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
				errors.length > 0 ? `${errors.length} ACP error event(s) in recent tail` : void 0,
				resolved.record.lastAgentExitSignal ? `last signal: ${resolved.record.lastAgentExitSignal}` : void 0,
				resolved.record.lastAgentExitCode ? `last exit code: ${resolved.record.lastAgentExitCode}` : void 0
			].filter(Boolean),
			evidence: {
				health: snap.health,
				lastErrors: errors.slice(-5),
				eventCount: events.availableEventCount
			}
		},
		nextActions: snap.nextActions
	};
}
//#endregion
//#region src/core/flow.ts
async function readFlowBundle(options) {
	const runDir = options.runDir ? path.resolve(options.runDir) : path.join(flowsRunsDir(options.stateDir), options.runId ?? "");
	const runId = options.runId ?? path.basename(runDir);
	const warnings = [];
	const [manifest, run, live, steps, traceEvents] = await Promise.all([
		readJson(path.join(runDir, "manifest.json"), warnings),
		readJson(path.join(runDir, "projections", "run.json"), warnings),
		readJson(path.join(runDir, "projections", "live.json"), warnings),
		readJson(path.join(runDir, "projections", "steps.json"), warnings),
		readNdjson(path.join(runDir, "trace.ndjson"), warnings)
	]);
	return {
		runId,
		runDir,
		manifest,
		run,
		live,
		steps,
		traceEvents,
		warnings
	};
}
async function readJson(filePath, warnings) {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") warnings.push(`failed to read ${filePath}: ${String(error)}`);
		return;
	}
}
async function readNdjson(filePath, warnings) {
	try {
		return (await fs.readFile(filePath, "utf8")).split("\n").filter(Boolean).flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				warnings.push(`invalid JSON line in ${filePath}`);
				return [];
			}
		});
	} catch (error) {
		if (error.code !== "ENOENT") warnings.push(`failed to read ${filePath}: ${String(error)}`);
		return [];
	}
}
function flowStatus(bundle) {
	const run = isObject(bundle.run) ? bundle.run : isObject(bundle.live) ? bundle.live : void 0;
	return (run && typeof run.status === "string" ? run.status : void 0) ?? "unknown";
}
//#endregion
//#region src/projections/follow.ts
function parseDurationMs(value, label = "duration") {
	const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
	if (!match) throw new Error(`Invalid ${label}: ${value}`);
	const amount = Number(match[1]);
	const unit = match[2] ?? "s";
	const result = amount * (unit === "ms" ? 1 : unit === "s" ? 1e3 : unit === "m" ? 6e4 : 36e5);
	if (!Number.isFinite(result) || result < 0) throw new Error(`Invalid ${label}: ${value}`);
	return Math.floor(result);
}
async function followSession(ref, options) {
	const writer = options.write ?? ((text) => process.stdout.write(text));
	const sleeper = options.sleep ?? sleep;
	const startedAt = Date.now();
	let tick = 0;
	let announced = false;
	while (true) {
		const sample = await sampleSession(ref, options, tick + 1);
		sample.status;
		if (!announced) {
			writer(formatFollowStartText(sample, options));
			announced = true;
		}
		tick += 1;
		writer(formatFollowTickText(sample));
		if (isTerminalSessionStatus(sample.status)) {
			writer(formatFollowDoneText("terminal", sample.status));
			return {
				reason: "terminal",
				status: sample.status,
				ticks: tick
			};
		}
		if (Date.now() - startedAt >= options.durationMs) {
			writer(formatFollowDoneText("timeout", sample.status));
			return {
				reason: "timeout",
				status: sample.status,
				ticks: tick
			};
		}
		await sleeper(Math.min(options.intervalMs, Math.max(0, options.durationMs - (Date.now() - startedAt))));
	}
}
async function followFlow(options) {
	const writer = options.write ?? ((text) => process.stdout.write(text));
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
			return {
				reason: "terminal",
				status: sample.status,
				ticks: tick
			};
		}
		if (Date.now() - startedAt >= options.durationMs) {
			writer(formatFollowDoneText("timeout", sample.status));
			return {
				reason: "timeout",
				status: sample.status,
				ticks: tick
			};
		}
		await sleeper(Math.min(options.intervalMs, Math.max(0, options.durationMs - (Date.now() - startedAt))));
	}
}
async function sampleSession(ref, options, tick) {
	const resolved = await resolveSession(ref);
	if (!resolved.record) throw new Error(`Unable to resolve session: ${resolved.resolution.status}`);
	const queue = await readQueueHealth(resolved.record.acpxRecordId, options.stateDir);
	const status = classifyStatus(resolved.record, queue);
	const result = await readSessionEvents(resolved.record, {
		stateDir: options.stateDir,
		tail: options.events,
		raw: false
	});
	return {
		target: "session",
		id: resolved.record.acpxRecordId,
		tick,
		at: (options.now?.() ?? /* @__PURE__ */ new Date()).toISOString(),
		status,
		totalEvents: result.availableEventCount,
		lastWriteAt: resolved.record.eventLog?.last_write_at ?? null,
		warnings: [...resolved.warnings, ...result.warnings],
		events: result.events.map((event) => simplifySessionEvent(event, options.maxLine))
	};
}
async function sampleFlow(options, tick) {
	const bundle = await readFlowBundle(options);
	const status = flowStatus(bundle);
	if (status === "unknown" && bundle.traceEvents.length === 0) throw new Error(`Unable to read flow run: ${bundle.runId}`);
	return {
		target: "flow",
		id: bundle.runId,
		tick,
		at: (options.now?.() ?? /* @__PURE__ */ new Date()).toISOString(),
		status,
		totalEvents: bundle.traceEvents.length,
		currentNode: currentFlowNode(bundle),
		warnings: bundle.warnings,
		events: bundle.traceEvents.slice(-options.events).map((event, index) => simplifyFlowEvent(event, bundle.traceEvents.length - Math.min(options.events, bundle.traceEvents.length) + index + 1, options.maxLine))
	};
}
function formatFollowTickText(tick) {
	const detail = tick.target === "flow" ? `currentNode=${tick.currentNode ?? "none"}` : `lastWrite=${tick.lastWriteAt ?? "none"}`;
	const lines = [`[${tick.at}] tick=${tick.tick} ${tick.target} status=${tick.status} events=${tick.totalEvents} ${detail}`];
	for (const event of tick.events) {
		const seq = event.seq == null ? "-" : `#${event.seq}`;
		const status = event.status ? ` ${event.status}` : "";
		const text = event.text ? ` ${event.text}` : "";
		lines.push(`${seq} ${event.role} ${event.label}${status}${text}`);
	}
	if (tick.warnings.length > 0) lines.push(`warnings=${tick.warnings.length}`);
	return `${lines.join("\n")}\n`;
}
function formatFollowStartText(tick, options) {
	return `follow target=${tick.target} id=${tick.id} status=${tick.status} duration=${formatDuration(options.durationMs)} interval=${formatDuration(options.intervalMs)} events=${options.events}\n`;
}
function formatFollowDoneText(reason, status) {
	return `follow done reason=${reason} status=${status}\n`;
}
function simplifySessionEvent(event, maxLine) {
	if (event.role === "tool" || event.toolName) return {
		seq: event.seq,
		role: "tool",
		label: truncate(event.toolName ?? event.summary ?? "tool", maxLine),
		status: event.status
	};
	return {
		seq: event.seq,
		role: event.role ?? event.kind,
		label: truncate(event.summary, maxLine),
		status: event.stopReason ? `stop=${event.stopReason}` : event.status,
		text: event.text ? truncate(event.text, maxLine) : void 0
	};
}
function simplifyFlowEvent(event, seq, maxLine) {
	if (!isObject(event)) return {
		seq,
		role: "flow",
		label: "invalid trace event"
	};
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
		text: detail ? truncate(detail, maxLine) : void 0
	};
}
function currentFlowNode(bundle) {
	const live = isObject(bundle.live) ? bundle.live : void 0;
	const run = isObject(bundle.run) ? bundle.run : void 0;
	return stringField(live, "currentNode") ?? stringField(run, "currentNode") ?? null;
}
function isTerminalSessionStatus(status) {
	return status === "closed" || status === "dead" || status === "idle";
}
function isTerminalFlowStatus(status) {
	return status === "completed" || status === "failed" || status === "timed_out";
}
function stringField(value, key) {
	const field = value?.[key];
	return typeof field === "string" ? field : void 0;
}
function numberField(value, key) {
	const field = value[key];
	return typeof field === "number" && Number.isFinite(field) ? field : void 0;
}
function formatDuration(ms) {
	if (ms % 36e5 === 0) return `${ms / 36e5}h`;
	if (ms % 6e4 === 0) return `${ms / 6e4}m`;
	if (ms % 1e3 === 0) return `${ms / 1e3}s`;
	return `${ms}ms`;
}
async function sleep(ms) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
//#endregion
//#region src/html-report/model.ts
async function sessionReportModel(ref) {
	const resolved = await resolveSession(ref);
	if (!resolved.record) return {
		schema: "acpx-inspector.report.session.v1",
		kind: "session",
		generatedAt: nowIso(),
		title: "Session not found",
		subtitle: JSON.stringify(resolved.resolution.input),
		status: resolved.resolution.status,
		summary: [{
			label: "Resolution",
			value: resolved.resolution.status,
			tone: "danger"
		}],
		sections: [{
			id: "resolution",
			title: "Resolution",
			items: [{
				title: resolved.resolution.status,
				code: JSON.stringify(resolved.resolution, null, 2)
			}]
		}],
		actions: []
	};
	const snap = await snapshotForRecord(resolved.record, {
		stateDir: ref.stateDir,
		resolution: resolved.resolution,
		warnings: resolved.warnings
	});
	const history = await historyView({
		...ref,
		id: resolved.record.acpxRecordId,
		tail: 120
	});
	return {
		schema: "acpx-inspector.report.session.v1",
		kind: "session",
		generatedAt: nowIso(),
		title: resolved.record.title || resolved.record.name || "acpx session",
		subtitle: `${resolved.record.agentCommand} · ${resolved.record.cwd}`,
		status: snap.session?.status ?? "unknown",
		summary: [
			{
				label: "Status",
				value: snap.session?.status ?? "unknown",
				tone: toneForStatus$1(snap.session?.status)
			},
			{
				label: "Agent",
				value: resolved.record.agentCommand
			},
			{
				label: "Events",
				value: String(snap.eventLog?.availableEventCount ?? 0)
			},
			{
				label: "Last prompt",
				value: snap.session?.lastPromptAt ?? "n/a"
			}
		],
		sections: [
			{
				id: "conversation",
				title: "Conversation",
				eyebrow: "Summary",
				items: [{
					title: "Latest user",
					body: snap.conversation?.lastUserPreview ?? "n/a"
				}, {
					title: "Latest assistant",
					body: snap.conversation?.lastAssistantPreview ?? "n/a"
				}]
			},
			{
				id: "timeline",
				title: "Timeline",
				eyebrow: "Session",
				items: history.entries?.map((entry) => ({
					title: `${entry.role} · ${entry.kind}`,
					meta: `seq ${entry.seq}`,
					body: entry.preview
				})) ?? []
			},
			{
				id: "health",
				title: "Health",
				items: [{
					title: snap.health?.classification ?? "unknown",
					body: snap.health?.reason
				}, {
					title: "Queue evidence",
					code: JSON.stringify(snap.health?.queue ?? {}, null, 2)
				}]
			},
			{
				id: "identity",
				title: "Identity",
				items: [{
					title: resolved.record.acpxRecordId,
					code: JSON.stringify(snap.session, null, 2)
				}]
			}
		],
		actions: snap.nextActions ?? []
	};
}
async function oneshotReportModel(input) {
	const rawEvents = (await fs.readFile(input.eventsFile, "utf8")).split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
	const events = rawEvents.map((event, index) => projectEventForReport(event, index + 1));
	const stopReason = [...events].reverse().find((event) => event.stopReason)?.stopReason ?? "unknown";
	const errors = events.filter((event) => event.kind === "error");
	const text = events.filter((event) => event.text).map((event) => event.text).join(" ");
	return {
		schema: "acpx-inspector.report.oneshot.v1",
		kind: "oneshot",
		generatedAt: nowIso(),
		title: "One-shot ACP run",
		subtitle: path.basename(input.eventsFile),
		status: errors.length > 0 ? "failed" : stopReason,
		summary: [
			{
				label: "Stop reason",
				value: stopReason,
				tone: errors.length > 0 ? "danger" : "success"
			},
			{
				label: "Events",
				value: String(events.length)
			},
			{
				label: "Errors",
				value: String(errors.length),
				tone: errors.length > 0 ? "danger" : void 0
			},
			{
				label: "Final text",
				value: truncate(text || "n/a", 80)
			}
		],
		sections: [{
			id: "timeline",
			title: "Event Timeline",
			items: events.map((event) => ({
				title: event.summary,
				meta: `seq ${event.seq}${event.method ? ` · ${event.method}` : ""}`,
				body: event.text,
				tone: event.kind === "error" ? "danger" : void 0
			}))
		}, {
			id: "capture",
			title: "Capture",
			items: [{
				title: input.eventsFile,
				code: input.raw ? JSON.stringify(rawEvents, null, 2) : void 0
			}]
		}],
		actions: [],
		raw: input.raw ? rawEvents : void 0
	};
}
async function flowReportModel(input) {
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
			{
				label: "Status",
				value: status,
				tone: toneForStatus$1(status)
			},
			{
				label: "Steps",
				value: String(steps.length)
			},
			{
				label: "Trace events",
				value: String(bundle.traceEvents.length)
			},
			{
				label: "Warnings",
				value: String(bundle.warnings.length),
				tone: bundle.warnings.length ? "warning" : void 0
			}
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
					tone: toneForStatus$1(step.status)
				}))
			},
			{
				id: "trace",
				title: "Trace",
				items: bundle.traceEvents.slice(-80).map((event, index) => ({
					title: `Trace ${index + 1}`,
					body: truncate(JSON.stringify(event), 260)
				}))
			},
			{
				id: "raw",
				title: "Run Data",
				items: [{
					title: "Manifest and projections",
					code: input.raw ? JSON.stringify(bundle, null, 2) : JSON.stringify({
						run: bundle.run,
						live: bundle.live
					}, null, 2)
				}]
			}
		],
		actions: [],
		raw: input.raw ? bundle : void 0
	};
}
function projectEventForReport(raw, seq) {
	if (!isObject(raw)) return {
		seq,
		kind: "invalid",
		summary: "invalid event"
	};
	const method = typeof raw.method === "string" ? raw.method : void 0;
	if (method === "session/update") {
		const params = isObject(raw.params) ? raw.params : {};
		const update = isObject(params.update) ? params.update : params;
		const content = isObject(update.content) ? update.content : {};
		return {
			seq,
			method,
			kind: "notification",
			summary: typeof update.sessionUpdate === "string" ? update.sessionUpdate : "session/update",
			text: typeof content.text === "string" ? truncate(content.text) : void 0
		};
	}
	if (isObject(raw.result)) return {
		seq,
		kind: "response",
		summary: "response",
		stopReason: typeof raw.result.stopReason === "string" ? raw.result.stopReason : void 0
	};
	if (isObject(raw.error)) return {
		seq,
		kind: "error",
		summary: String(raw.error.message ?? "error")
	};
	return {
		seq,
		method,
		kind: method ? "request" : "invalid",
		summary: method ?? "event"
	};
}
function extractSteps(raw) {
	return (Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.steps) ? raw.steps : isObject(raw) && Array.isArray(raw.items) ? raw.items : []).map((entry) => {
		const record = isObject(entry) ? entry : {};
		const title = typeof record.nodeId === "string" ? record.nodeId : typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : void 0;
		const status = typeof record.status === "string" ? record.status : void 0;
		return {
			title,
			status,
			meta: [
				record.nodeType,
				record.attemptId,
				status
			].filter((value) => typeof value === "string").join(" · "),
			body: truncate(JSON.stringify(record), 260)
		};
	});
}
function toneForStatus$1(status) {
	if (!status) return void 0;
	if ([
		"running",
		"idle",
		"end_turn",
		"completed",
		"ready"
	].includes(status)) return "success";
	if ([
		"dead",
		"failed",
		"error",
		"timed_out"
	].includes(status)) return "danger";
	if ([
		"closed",
		"cancelled",
		"unknown"
	].includes(status)) return "warning";
}
//#endregion
//#region src/html-report/render.ts
function renderReportHtml(model) {
	const data = JSON.stringify(model).replace(/</g, "\\u003c");
	const visual = buildVisualModel(model);
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(model.title)} · acpx inspector</title>
  <style>${CSS}</style>
</head>
<body>
  <script id="report-data" type="application/json">${data}<\/script>
  <div class="shell">
    <aside class="rail">
      <div class="brand">
        <span class="brand__mark">AI</span>
        <div><strong>acpx inspector</strong><span>${escapeHtml(model.kind)}</span></div>
      </div>
      <nav>
        ${model.sections.map((section) => `<a href="#${escapeAttr(section.id)}">${escapeHtml(section.title)}</a>`).join("")}
      </nav>
    </aside>
    <main class="main">
      <header class="top">
        <div>
          <p class="eyebrow">${escapeHtml(model.kind)} report</p>
          <h1>${escapeHtml(model.title)}</h1>
          <p class="subtitle">${escapeHtml(model.subtitle)}</p>
        </div>
        <div class="status status--${escapeAttr(toneForStatus(model.status))}">${escapeHtml(model.status)}</div>
      </header>
      <section class="summary" aria-label="Summary">
        ${model.summary.map((item) => `<div class="metric metric--${escapeAttr(item.tone ?? "neutral")}"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`).join("")}
      </section>
      <section class="signal-strip" aria-label="Visual overview">
        ${visual.sections.map((section) => `<a class="signal-strip__cell signal-strip__cell--${escapeAttr(section.tone)}" href="#${escapeAttr(section.id)}" style="--w:${section.width}%" title="${escapeAttr(section.title)} · ${section.count} item${section.count === 1 ? "" : "s"}"><span></span></a>`).join("")}
      </section>
      <div class="workspace">
        <section class="content">
          ${model.sections.map(renderSection).join("")}
        </section>
        <aside class="visual-panel">
          <p class="eyebrow">Signal map</p>
          <h2>Session Shape</h2>
          <div class="status-gauge status-gauge--${escapeAttr(toneForStatus(model.status))}" aria-label="Status ${escapeAttr(model.status)}">
            <span>${escapeHtml(model.status)}</span>
          </div>
          <div class="viz-block">
            <div class="viz-block__head"><span>Section weight</span><strong>${visual.totalItems}</strong></div>
            <div class="bar-stack">
              ${visual.sections.map((section) => `<a href="#${escapeAttr(section.id)}" class="bar-stack__segment bar-stack__segment--${escapeAttr(section.tone)}" style="--w:${section.width}%" title="${escapeAttr(section.title)}"></a>`).join("")}
            </div>
          </div>
          <div class="viz-block">
            <div class="viz-block__head"><span>Signal tone</span><strong>${visual.toneTotal}</strong></div>
            <div class="tone-grid">
              ${visual.tones.map((tone) => `<div class="tone-grid__row"><span>${escapeHtml(tone.label)}</span><div><i class="tone-grid__fill tone-grid__fill--${escapeAttr(tone.id)}" style="--w:${tone.width}%"></i></div><strong>${tone.count}</strong></div>`).join("")}
            </div>
          </div>
          <div class="viz-block">
            <div class="viz-block__head"><span>Timeline rhythm</span><strong>${visual.rhythm.length}</strong></div>
            <div class="rhythm" aria-label="Timeline rhythm">
              ${visual.rhythm.map((item) => `<a href="#${escapeAttr(item.sectionId)}" class="rhythm__bar rhythm__bar--${escapeAttr(item.tone)}" style="--h:${item.height}%" title="${escapeAttr(item.title)}"></a>`).join("")}
            </div>
          </div>
        </aside>
      </div>
    </main>
  </div>
  <script>${JS}<\/script>
</body>
</html>
`;
}
function renderSection(section) {
	const density = Math.min(100, Math.max(8, section.items.length * 12));
	return `<section class="section" id="${escapeAttr(section.id)}">
    ${section.eyebrow ? `<p class="eyebrow">${escapeHtml(section.eyebrow)}</p>` : ""}
    <div class="section__title-row"><h2>${escapeHtml(section.title)}</h2><span class="density" style="--density:${density}%"></span></div>
    <div class="timeline">
      ${section.items.length === 0 ? `<p class="muted">No items recorded.</p>` : ""}
      ${section.items.map((item) => `<article class="event event--${escapeAttr(item.tone ?? "neutral")}">
        <span class="event__stripe" aria-hidden="true"></span>
        <div class="event__head"><strong>${escapeHtml(item.title)}</strong>${item.meta ? `<span>${escapeHtml(item.meta)}</span>` : ""}</div>
        ${item.body ? `<p>${escapeHtml(item.body)}</p>` : ""}
        ${item.code ? `<details><summary>Raw details</summary><pre>${escapeHtml(item.code)}</pre></details>` : ""}
      </article>`).join("")}
    </div>
  </section>`;
}
function escapeHtml(value) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeAttr(value) {
	return escapeHtml(value).replace(/[^A-Za-z0-9_-]/g, "-");
}
function toneForStatus(status) {
	if ([
		"running",
		"idle",
		"completed",
		"end_turn",
		"success"
	].includes(status)) return "success";
	if ([
		"dead",
		"failed",
		"error",
		"timed_out"
	].includes(status)) return "danger";
	if ([
		"closed",
		"cancelled",
		"unknown"
	].includes(status)) return "warning";
	return "neutral";
}
function buildVisualModel(model) {
	const sectionCounts = model.sections.map((section) => ({
		id: section.id,
		title: section.title,
		count: Math.max(0, section.items.length),
		tone: dominantTone(section.items.map((item) => item.tone ?? "neutral"))
	}));
	const totalItems = Math.max(1, sectionCounts.reduce((sum, section) => sum + section.count, 0));
	const tones = [
		"success",
		"warning",
		"danger",
		"neutral"
	].map((tone) => {
		const count = model.sections.flatMap((section) => section.items).filter((item) => (item.tone ?? "neutral") === tone).length;
		return {
			id: tone,
			label: tone,
			count,
			width: Math.max(count === 0 ? 0 : 6, Math.round(count / totalItems * 100))
		};
	});
	const rhythm = model.sections.flatMap((section) => section.items.map((item, index) => ({
		sectionId: section.id,
		title: item.title,
		tone: item.tone ?? "neutral",
		height: 26 + (index * 17 + section.id.length * 11) % 68
	})));
	return {
		totalItems,
		toneTotal: tones.reduce((sum, tone) => sum + tone.count, 0),
		sections: sectionCounts.map((section) => ({
			...section,
			width: Math.max(section.count === 0 ? 0 : 8, Math.round(section.count / totalItems * 100))
		})),
		tones,
		rhythm
	};
}
function dominantTone(tones) {
	if (tones.includes("danger")) return "danger";
	if (tones.includes("warning")) return "warning";
	if (tones.includes("success")) return "success";
	return "neutral";
}
const CSS = `
:root {
  color-scheme: light;
  --bg: #f6f7f4;
  --ink: #151817;
  --soft: #65706c;
  --line: #d8ddd7;
  --panel: #ffffff;
  --panel-alt: #eef2ef;
  --accent: #176f80;
  --success: #277246;
  --warning: #9b6b13;
  --danger: #a43c3c;
  --shadow: 0 18px 50px rgba(24, 34, 31, 0.12);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--ink); }
code, pre { font-family: "SFMono-Regular", Consolas, monospace; }
.shell { min-height: 100dvh; display: grid; grid-template-columns: 248px minmax(0, 1fr); }
.rail { position: sticky; top: 0; height: 100dvh; padding: 18px 14px; border-right: 1px solid var(--line); background: #fbfcfa; }
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
.brand__mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; background: var(--ink); color: white; font-weight: 800; }
.brand strong, .brand span { display: block; }
.brand span { color: var(--soft); font-size: 0.82rem; margin-top: 2px; }
nav { display: grid; gap: 4px; }
nav a { color: var(--soft); text-decoration: none; padding: 9px 10px; border-radius: 8px; }
nav a:hover, nav a.active { color: var(--ink); background: var(--panel-alt); }
.main { min-width: 0; padding: 22px; }
.top { display: flex; justify-content: space-between; align-items: start; gap: 18px; margin-bottom: 16px; }
.eyebrow { margin: 0 0 5px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.09em; font-size: 0.76rem; font-weight: 800; }
h1 { margin: 0; font-size: 2rem; line-height: 1.05; letter-spacing: 0; }
h2 { margin: 0 0 10px; font-size: 1.06rem; letter-spacing: 0; }
.subtitle { max-width: 960px; margin: 8px 0 0; color: var(--soft); overflow-wrap: anywhere; }
.status { padding: 8px 12px; border-radius: 999px; border: 1px solid var(--line); font-weight: 800; }
.status--success { color: var(--success); background: #e8f4ec; }
.status--warning { color: var(--warning); background: #fff4d8; }
.status--danger { color: var(--danger); background: #fde9e9; }
.summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 16px; }
.metric { min-height: 74px; padding: 12px; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; }
.metric span { display: block; color: var(--soft); font-size: 0.78rem; margin-bottom: 8px; }
.metric strong { display: block; font-size: 1.1rem; overflow-wrap: anywhere; }
.signal-strip { height: 18px; display: flex; gap: 4px; margin-bottom: 16px; }
.signal-strip__cell { flex: 0 0 var(--w); min-width: 10px; height: 100%; border-radius: 4px; background: var(--panel-alt); border: 1px solid var(--line); overflow: hidden; }
.signal-strip__cell span { display: block; width: 100%; height: 100%; opacity: 0.82; }
.signal-strip__cell--success span { background: var(--success); }
.signal-strip__cell--warning span { background: var(--warning); }
.signal-strip__cell--danger span { background: var(--danger); }
.signal-strip__cell--neutral span { background: var(--accent); }
.workspace { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 14px; align-items: start; }
.content { display: grid; gap: 14px; }
.section { padding: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); scroll-margin-top: 16px; }
.section.flash { animation: flash 900ms ease; }
.section__title-row { display: grid; grid-template-columns: minmax(0, auto) minmax(96px, 1fr); gap: 12px; align-items: center; margin-bottom: 10px; }
.section__title-row h2 { margin: 0; }
.density { height: 8px; border-radius: 999px; background: linear-gradient(90deg, var(--accent) var(--density), var(--panel-alt) var(--density)); border: 1px solid var(--line); }
.timeline { display: grid; gap: 8px; }
.event { position: relative; display: grid; grid-template-columns: 8px minmax(0, 1fr); column-gap: 10px; padding: 10px 12px; background: #fbfcfa; border-radius: 8px; border: 1px solid rgba(216, 221, 215, 0.72); }
.event--success { border-left-color: var(--success); }
.event--warning { border-left-color: var(--warning); }
.event--danger { border-left-color: var(--danger); }
.event__stripe { grid-row: 1 / span 3; width: 8px; min-height: 100%; border-radius: 999px; background: var(--accent); opacity: 0.62; }
.event--success .event__stripe { background: var(--success); }
.event--warning .event__stripe { background: var(--warning); }
.event--danger .event__stripe { background: var(--danger); }
.event__head { display: flex; justify-content: space-between; gap: 12px; }
.event__head span, .muted { color: var(--soft); }
.event p, .event details { grid-column: 2; }
.event p { margin: 8px 0 0; color: #2d3633; overflow-wrap: anywhere; }
details { margin-top: 8px; }
summary { cursor: pointer; color: var(--accent); font-weight: 700; }
pre { overflow: auto; padding: 10px; background: #101514; color: #eaf2ee; border-radius: 8px; max-height: 360px; }
.visual-panel { position: sticky; top: 18px; padding: 16px; background: #fbfcfa; border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
.status-gauge { height: 126px; display: grid; place-items: center; margin: 8px 0 14px; border-radius: 8px; border: 1px solid var(--line); background: repeating-linear-gradient(135deg, #f8faf8, #f8faf8 8px, #edf2ef 8px, #edf2ef 16px); }
.status-gauge span { min-width: 68%; text-align: center; padding: 12px; border-radius: 8px; background: var(--panel); border: 2px solid var(--accent); font-size: 1.25rem; font-weight: 900; }
.status-gauge--success span { border-color: var(--success); color: var(--success); }
.status-gauge--warning span { border-color: var(--warning); color: var(--warning); }
.status-gauge--danger span { border-color: var(--danger); color: var(--danger); }
.viz-block { padding: 12px 0; border-top: 1px solid var(--line); }
.viz-block__head { display: flex; justify-content: space-between; gap: 8px; color: var(--soft); font-size: 0.78rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 9px; }
.bar-stack { height: 18px; display: flex; gap: 3px; }
.bar-stack__segment { flex: 0 0 var(--w); min-width: 5px; border-radius: 3px; background: var(--accent); }
.bar-stack__segment--success, .tone-grid__fill--success, .rhythm__bar--success { background: var(--success); }
.bar-stack__segment--warning, .tone-grid__fill--warning, .rhythm__bar--warning { background: var(--warning); }
.bar-stack__segment--danger, .tone-grid__fill--danger, .rhythm__bar--danger { background: var(--danger); }
.bar-stack__segment--neutral, .tone-grid__fill--neutral, .rhythm__bar--neutral { background: var(--accent); }
.tone-grid { display: grid; gap: 7px; }
.tone-grid__row { display: grid; grid-template-columns: 64px minmax(0, 1fr) 28px; gap: 8px; align-items: center; color: var(--soft); font-size: 0.78rem; }
.tone-grid__row div { height: 8px; border-radius: 999px; background: var(--panel-alt); overflow: hidden; border: 1px solid var(--line); }
.tone-grid__fill { display: block; width: var(--w); height: 100%; }
.rhythm { height: 112px; display: flex; align-items: end; gap: 3px; padding: 8px 0 2px; border-bottom: 1px solid var(--line); }
.rhythm__bar { flex: 1 1 6px; min-width: 4px; max-width: 18px; height: var(--h); border-radius: 4px 4px 0 0; background: var(--accent); opacity: 0.86; }
@keyframes flash { from { outline: 3px solid rgba(23,111,128,.35); } to { outline: 0 solid transparent; } }
@media (max-width: 920px) {
  .shell { grid-template-columns: 1fr; }
  .rail { position: sticky; z-index: 2; height: auto; top: 0; border-right: 0; border-bottom: 1px solid var(--line); }
  nav { grid-auto-flow: column; overflow-x: auto; }
  .main { padding: 14px; }
  .top { display: grid; }
  .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .workspace { grid-template-columns: 1fr; }
  .visual-panel { position: static; }
}
`;
const JS = `
const links = Array.from(document.querySelectorAll('nav a'));
const sections = Array.from(document.querySelectorAll('.section'));
function setActive() {
  const current = sections.findLast(section => section.getBoundingClientRect().top < 120) || sections[0];
  links.forEach(link => link.classList.toggle('active', current && link.getAttribute('href') === '#' + current.id));
}
for (const link of links) {
  link.addEventListener('click', () => {
    const id = link.getAttribute('href')?.slice(1);
    const section = id ? document.getElementById(id) : null;
    if (section) {
      section.classList.remove('flash');
      requestAnimationFrame(() => section.classList.add('flash'));
    }
  });
}
document.addEventListener('scroll', setActive, { passive: true });
setActive();
`;
//#endregion
//#region src/html-report/write.ts
async function writeReport(model, outputPath, open = false) {
	const resolved = path.resolve(outputPath);
	await fs.mkdir(path.dirname(resolved), { recursive: true });
	await fs.writeFile(resolved, renderReportHtml(model), "utf8");
	if (open) openFile(resolved);
	return resolved;
}
function openFile(filePath) {
	const url = pathToFileURL(filePath).href;
	spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open", process.platform === "win32" ? [
		"/c",
		"start",
		"",
		url
	] : [url], {
		stdio: "ignore",
		detached: true
	}).unref();
}
//#endregion
export { readSessionEvents as S, suggestActions as _, sessionReportModel as a, listSessionRecords as b, formatFollowTickText as c, sampleSession as d, diagnose as f, snapshotForRecord as g, snapshot as h, oneshotReportModel as i, parseDurationMs as l, classifyStatus as m, renderReportHtml as n, followFlow as o, sessionsView as p, flowReportModel as r, followSession as s, writeReport as t, sampleFlow as u, historyView as v, parseSessionRecord as x, resolveSession as y };
