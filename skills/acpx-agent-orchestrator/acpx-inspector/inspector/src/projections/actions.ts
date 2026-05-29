import { acpxCommandPrefix } from "../core/agents.js";
import type { Action, SessionRecord, SessionStatus } from "../types.js";

export async function suggestActions(
  record: SessionRecord,
  status: SessionStatus,
  options: { stateDir?: string } = {},
): Promise<Action[]> {
  const prefix = await acpxCommandPrefix(record.agentCommand, record.cwd, {
    stateDir: options.stateDir,
  });
  const sessionFlag = record.name ? ` -s ${quoteArg(record.name)}` : "";
  const promptCommand = `${prefix}${sessionFlag} '<prompt>'`;
  const actions: Action[] = [
    {
      id: "read",
      label: "Read compact history",
      safety: "read_only",
      requiresConfirmation: false,
      command: `acpx-inspector read --id ${quoteArg(record.acpxRecordId)}`,
      why: "Read a compact summary without mutating the session.",
    },
    {
      id: "report_session",
      label: "Generate session report",
      safety: "read_only",
      requiresConfirmation: false,
      command: `acpx-inspector report session --id ${quoteArg(record.acpxRecordId)} --output session-${safeFilePart(record.acpxRecordId)}.html`,
      why: "Create a static HTML report for human review.",
    },
  ];

  if (status === "running") {
    actions.push(
      {
        id: "tail",
        label: "Tail progress",
        safety: "read_only",
        requiresConfirmation: false,
        command: `acpx-inspector tail --id ${quoteArg(record.acpxRecordId)} --events 50`,
        why: "Session is running; tailing gives progress without interrupting.",
      },
      {
        id: "queue_prompt",
        label: "Queue follow-up prompt",
        safety: "reversible",
        requiresConfirmation: false,
        command: `${prefix}${sessionFlag} --no-wait '<prompt>'`,
        why: "A prompt appears to be running; --no-wait queues the next turn.",
      },
      {
        id: "cancel",
        label: "Cancel current turn",
        safety: "interrupting",
        requiresConfirmation: true,
        command: `${prefix} cancel${sessionFlag}`,
        why: "Cancel can interrupt in-flight work.",
      },
    );
    return actions;
  }

  if (status === "idle") {
    actions.push(
      {
        id: "prompt",
        label: "Send follow-up prompt",
        safety: "reversible",
        requiresConfirmation: false,
        command: promptCommand,
        why: "Session is open and idle.",
      },
      {
        id: "set_mode",
        label: "Set mode",
        safety: "reversible",
        requiresConfirmation: false,
        command: `${prefix} set-mode <mode>${sessionFlag}`,
        why: "The session can receive mode changes through acpx.",
      },
      {
        id: "set_model",
        label: "Set model",
        safety: "reversible",
        requiresConfirmation: false,
        command: `${prefix} set model <model-id>${sessionFlag}`,
        why: "The session can receive model changes through acpx.",
      },
      {
        id: "close",
        label: "Close session",
        safety: "destructive",
        requiresConfirmation: true,
        command: `${prefix} sessions close${record.name ? ` ${quoteArg(record.name)}` : ""}`,
        why: "Closing stops auto-resume for this session.",
      },
    );
    return actions;
  }

  if (status === "closed") {
    actions.push(
      {
        id: "export",
        label: "Export session",
        safety: "read_only",
        requiresConfirmation: false,
        command: `${prefix} sessions export${record.name ? ` ${quoteArg(record.name)}` : ""} --output ${safeFilePart(record.acpxRecordId)}.json`,
        why: "Closed sessions can still be exported for archival or transfer.",
      },
      {
        id: "prune_dry_run",
        label: "Preview prune",
        safety: "read_only",
        requiresConfirmation: false,
        command: `${prefix} sessions prune --dry-run`,
        why: "Preview deletion candidates before pruning.",
      },
    );
    return actions;
  }

  if (status === "dead") {
    actions.push({
      id: "prompt",
      label: "Attempt reconnect with prompt",
      safety: "reversible",
      requiresConfirmation: false,
      command: promptCommand,
      why: "acpx can attempt to reconnect or reload saved sessions on the next prompt.",
    });
  }

  return actions;
}

function quoteArg(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48);
}
