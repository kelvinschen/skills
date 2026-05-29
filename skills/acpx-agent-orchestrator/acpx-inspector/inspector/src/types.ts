export type JsonObject = Record<string, unknown>;

export type OutputFormat = "json" | "jsonl";

export type SessionStatus =
  | "running"
  | "idle"
  | "dead"
  | "closed"
  | "no_session"
  | "ambiguous"
  | "unknown";

export type ActionSafety = "read_only" | "reversible" | "interrupting" | "destructive";

export type Action = {
  id: string;
  label: string;
  safety: ActionSafety;
  requiresConfirmation: boolean;
  command: string | null;
  why: string;
};

export type SessionRecord = {
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

export type SessionMessage =
  | "Resume"
  | {
      User: {
        id: string;
        content: Array<Record<string, unknown>>;
      };
    }
  | {
      Agent: {
        content: Array<Record<string, unknown>>;
        tool_results?: Record<string, unknown>;
      };
    };

export type SessionRef = {
  stateDir?: string;
  cwd?: string;
  agent?: string;
  name?: string;
  id?: string;
  includeClosed?: boolean;
};

export type Resolution =
  | {
      status: "resolved";
      strategy: string;
      input: JsonObject;
      matched: SessionIdentity;
    }
  | {
      status: "ambiguous";
      input: JsonObject;
      candidates: SessionIdentity[];
    }
  | {
      status: "not_found";
      input: JsonObject;
    };

export type SessionIdentity = {
  acpxRecordId: string;
  acpSessionId: string;
  agentSessionId?: string;
  agentCommand: string;
  cwd: string;
  name?: string;
};

export type QueueHealth = {
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

export type ProjectedEvent = {
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

export type Snapshot = {
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

export type HistoryView = {
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

export type SessionsView = {
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

export type ReportKind = "oneshot" | "session" | "flow";

export type ReportModel = {
  schema:
    | "acpx-inspector.report.oneshot.v1"
    | "acpx-inspector.report.session.v1"
    | "acpx-inspector.report.flow.v1";
  kind: ReportKind;
  generatedAt: string;
  title: string;
  subtitle: string;
  status: string;
  summary: Array<{ label: string; value: string; tone?: string }>;
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
