//#region src/types.d.ts
type JsonObject = Record<string, unknown>;
type OutputFormat = "json" | "jsonl";
type SessionStatus = "running" | "idle" | "dead" | "closed" | "no_session" | "ambiguous" | "unknown";
type ActionSafety = "read_only" | "reversible" | "interrupting" | "destructive";
type Action = {
  id: string;
  label: string;
  safety: ActionSafety;
  requiresConfirmation: boolean;
  command: string | null;
  why: string;
};
type SessionRecord = {
  schema: "acpx.session.v1";
  acpxRecordId: string;
  acpSessionId: string;
  agentSessionId?: string;
  agentCommand: string;
  cwd: string;
  name?: string;
  createdAt: string;
  lastUsedAt: string;
  lastSeq: number;
  lastRequestId?: string;
  eventLog?: {
    active_path?: string;
    segment_count?: number;
    max_segment_bytes?: number;
    max_segments?: number;
    last_write_at?: string;
    last_write_error?: string | null;
  };
  closed?: boolean;
  closedAt?: string;
  pid?: number;
  agentStartedAt?: string;
  lastPromptAt?: string;
  lastAgentExitCode?: number | null;
  lastAgentExitSignal?: string | null;
  lastAgentExitAt?: string;
  lastAgentDisconnectReason?: string;
  title?: string | null;
  messages: SessionMessage[];
  updatedAt: string;
  cumulativeTokenUsage: Record<string, number>;
  requestTokenUsage: Record<string, Record<string, number>>;
  acpx?: {
    current_mode_id?: string;
    desired_mode_id?: string;
    current_model_id?: string;
    available_models?: string[];
    available_commands?: string[];
    desired_config_options?: Record<string, string>;
    config_options?: unknown[];
    session_options?: unknown;
  };
  raw: JsonObject;
  filePath: string;
};
type SessionMessage = "Resume" | {
  User: {
    id: string;
    content: Array<Record<string, unknown>>;
  };
} | {
  Agent: {
    content: Array<Record<string, unknown>>;
    tool_results?: Record<string, unknown>;
  };
};
type SessionRef = {
  stateDir?: string;
  cwd?: string;
  agent?: string;
  name?: string;
  id?: string;
  includeClosed?: boolean;
};
type Resolution = {
  status: "resolved";
  strategy: string;
  input: JsonObject;
  matched: SessionIdentity;
} | {
  status: "ambiguous";
  input: JsonObject;
  candidates: SessionIdentity[];
} | {
  status: "not_found";
  input: JsonObject;
};
type SessionIdentity = {
  acpxRecordId: string;
  acpSessionId: string;
  agentSessionId?: string;
  agentCommand: string;
  cwd: string;
  name?: string;
};
type QueueHealth = {
  hasLease: boolean;
  healthy: boolean;
  pidAlive: boolean;
  pid?: number;
  socketPath?: string;
  queueDepth?: number;
  heartbeatAt?: string;
  stale?: boolean;
  lockPath?: string;
};
type ProjectedEvent = {
  seq: number;
  method?: string;
  id?: string | number;
  kind: "request" | "response" | "error" | "notification" | "invalid";
  summary: string;
  role?: "user" | "assistant" | "tool" | "system";
  text?: string;
  stopReason?: string;
  toolName?: string;
  status?: string;
  raw?: unknown;
};
type Snapshot = {
  schema: "acpx-inspector.snapshot.v1";
  generatedAt: string;
  resolution: Resolution;
  warnings: string[];
  session?: SessionIdentity & {
    status: SessionStatus;
    closed: boolean;
    mode: string | null;
    model: string | null;
    availableModels: string[] | null;
    createdAt: string;
    lastPromptAt: string | null;
    lastUsedAt: string;
    lastSeq: number;
    lastRequestId: string | null;
  };
  conversation?: {
    messageCount: number;
    turnCountApprox: number;
    lastUserPreview: string | null;
    lastAssistantPreview: string | null;
    tokenUsage: Record<string, number>;
  };
  eventLog?: {
    activePath: string | null;
    segmentCount: number;
    maxSegments: number;
    lastWriteAt: string | null;
    availableEventCount: number;
  };
  health?: {
    classification: SessionStatus;
    queue: QueueHealth;
    reason: string;
  };
  nextActions?: Action[];
};
type HistoryView = {
  schema: "acpx-inspector.history.v1";
  generatedAt: string;
  resolution: Resolution;
  warnings: string[];
  summary?: {
    latestOutcome: "completed" | "failed" | "unknown";
    latestStopReason: string | null;
    openToolCalls: number;
    errors: number;
    permissionRequests: number;
  };
  entries?: Array<{
    seq: number;
    role: string;
    kind: string;
    preview: string;
    evidence: JsonObject;
  }>;
  omitted?: {
    rawEvents: number;
    largePayloadBytes: number;
  };
};
type SessionsView = {
  schema: "acpx-inspector.sessions.v1";
  generatedAt: string;
  stateDir: string;
  filters: JsonObject;
  warnings: string[];
  summary: {
    total: number;
    active: number;
    closed: number;
    running: number;
    idle: number;
    dead: number;
  };
  sessions: Array<SessionIdentity & {
    status: SessionStatus;
    closed: boolean;
    title: string | null;
    lastPromptAt: string | null;
    lastUsedAt: string;
    lastSeq: number;
    mode: string | null;
    model: string | null;
    preview: string | null;
    nextActionIds: string[];
  }>;
};
type ReportKind = "oneshot" | "session" | "flow";
type ReportModel = {
  schema: "acpx-inspector.report.oneshot.v1" | "acpx-inspector.report.session.v1" | "acpx-inspector.report.flow.v1";
  kind: ReportKind;
  generatedAt: string;
  title: string;
  subtitle: string;
  status: string;
  summary: Array<{
    label: string;
    value: string;
    tone?: string;
  }>;
  sections: Array<{
    id: string;
    title: string;
    eyebrow?: string;
    items: Array<{
      title: string;
      meta?: string;
      body?: string;
      tone?: string;
      code?: string;
    }>;
  }>;
  actions: Action[];
  raw?: unknown;
};
//#endregion
//#region src/projections/sessions.d.ts
declare function sessionsView(ref: SessionRef & {
  limit?: number;
}): Promise<SessionsView>;
//#endregion
//#region src/projections/snapshot.d.ts
declare function snapshot(ref: SessionRef): Promise<Snapshot>;
declare function snapshotForRecord(record: SessionRecord, options: {
  stateDir?: string;
  resolution: Snapshot["resolution"];
  warnings?: string[];
}): Promise<Snapshot>;
declare function classifyStatus(record: SessionRecord, queue: {
  hasLease: boolean;
  healthy: boolean;
  pidAlive: boolean;
}): SessionStatus;
//#endregion
//#region src/projections/history.d.ts
declare function historyView(ref: SessionRef & {
  tail?: number;
  raw?: boolean;
  budget?: number;
}): Promise<HistoryView>;
//#endregion
//#region src/projections/diagnose.d.ts
declare function diagnose(ref: SessionRef): Promise<{
  schema: string;
  generatedAt: string;
  resolution: Resolution;
  warnings: string[];
  diagnosis: {
    status: string;
    findings: never[];
    evidence?: undefined;
  };
  nextActions?: undefined;
} | {
  schema: string;
  generatedAt: string;
  resolution: Resolution;
  warnings: string[];
  diagnosis: {
    status: SessionStatus;
    findings: (string | undefined)[];
    evidence: {
      health: {
        classification: SessionStatus;
        queue: QueueHealth;
        reason: string;
      } | undefined;
      lastErrors: ProjectedEvent[];
      eventCount: number;
    };
  };
  nextActions: Action[] | undefined;
}>;
//#endregion
//#region src/projections/follow.d.ts
type FollowTarget = "session" | "flow";
type FollowEventLine = {
  seq?: number;
  role: string;
  label: string;
  status?: string;
  text?: string;
};
type FollowTick = {
  target: FollowTarget;
  id: string;
  tick: number;
  at: string;
  status: string;
  totalEvents: number;
  lastWriteAt?: string | null;
  currentNode?: string | null;
  warnings: string[];
  events: FollowEventLine[];
};
type FollowResult = {
  reason: "terminal" | "timeout";
  status: string;
  ticks: number;
};
type FollowLoopOptions = {
  durationMs: number;
  intervalMs: number;
  events: number;
  maxLine: number;
  write?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};
type FollowSessionOptions = FollowLoopOptions & {
  stateDir?: string;
};
type FollowFlowOptions = FollowLoopOptions & {
  stateDir?: string;
  runId?: string;
  runDir?: string;
};
declare function parseDurationMs(value: string, label?: string): number;
declare function followSession(ref: SessionRef, options: FollowSessionOptions): Promise<FollowResult>;
declare function followFlow(options: FollowFlowOptions): Promise<FollowResult>;
declare function sampleSession(ref: SessionRef, options: Pick<FollowSessionOptions, "stateDir" | "events" | "maxLine" | "now">, tick: number): Promise<FollowTick>;
declare function sampleFlow(options: Pick<FollowFlowOptions, "stateDir" | "runId" | "runDir" | "events" | "maxLine" | "now">, tick: number): Promise<FollowTick>;
declare function formatFollowTickText(tick: FollowTick): string;
//#endregion
//#region src/projections/actions.d.ts
declare function suggestActions(record: SessionRecord, status: SessionStatus, options?: {
  stateDir?: string;
}): Promise<Action[]>;
//#endregion
//#region src/core/event-stream.d.ts
type EventReadResult = {
  events: ProjectedEvent[];
  rawEvents: unknown[];
  warnings: string[];
  availableEventCount: number;
};
declare function readSessionEvents(record: SessionRecord, options?: {
  stateDir?: string;
  tail?: number;
  raw?: boolean;
}): Promise<EventReadResult>;
//#endregion
//#region src/core/resolver.d.ts
declare function resolveSession(ref: SessionRef): Promise<{
  resolution: Resolution;
  record?: SessionRecord;
  warnings: string[];
}>;
//#endregion
//#region src/core/session-record.d.ts
declare function listSessionRecords(stateDir?: string): Promise<{
  records: SessionRecord[];
  warnings: string[];
}>;
declare function parseSessionRecord(raw: unknown, filePath?: string): SessionRecord | undefined;
//#endregion
//#region src/html-report/model.d.ts
declare function sessionReportModel(ref: SessionRef): Promise<ReportModel>;
declare function oneshotReportModel(input: {
  eventsFile: string;
  raw?: boolean;
}): Promise<ReportModel>;
declare function flowReportModel(input: {
  stateDir?: string;
  runId?: string;
  runDir?: string;
  raw?: boolean;
}): Promise<ReportModel>;
//#endregion
//#region src/html-report/render.d.ts
declare function renderReportHtml(model: ReportModel): string;
//#endregion
//#region src/html-report/write.d.ts
declare function writeReport(model: ReportModel, outputPath: string, open?: boolean): Promise<string>;
//#endregion
export { type Action, type ActionSafety, type HistoryView, type JsonObject, type OutputFormat, type ProjectedEvent, type QueueHealth, type ReportKind, type ReportModel, type Resolution, type SessionIdentity, type SessionMessage, type SessionRecord, type SessionRef, type SessionStatus, type SessionsView, type Snapshot, classifyStatus, diagnose, flowReportModel, followFlow, followSession, formatFollowTickText, historyView, listSessionRecords, oneshotReportModel, parseDurationMs, parseSessionRecord, readSessionEvents, renderReportHtml, resolveSession, sampleFlow, sampleSession, sessionReportModel, sessionsView, snapshot, snapshotForRecord, suggestActions, writeReport };