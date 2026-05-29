import path from "node:path";
import { listSessionRecords } from "./session-record.js";
import { sessionIdentity } from "./conversation.js";
import type { Resolution, SessionRecord, SessionRef } from "../types.js";

export async function resolveSession(ref: SessionRef): Promise<{
  resolution: Resolution;
  record?: SessionRecord;
  warnings: string[];
}> {
  const { records, warnings } = await listSessionRecords(ref.stateDir);
  const input = cleanInput(ref);

  if (ref.id) {
    const exact = records.filter((record) => idValues(record).includes(ref.id ?? ""));
    if (exact.length === 1) {
      return {
        resolution: {
          status: "resolved",
          strategy: "id_exact",
          input,
          matched: sessionIdentity(exact[0]!),
        },
        record: exact[0],
        warnings,
      };
    }
    if (exact.length > 1) {
      return ambiguous(input, exact, warnings);
    }
    const suffix = records.filter((record) =>
      idValues(record).some((value) => value.endsWith(ref.id ?? "")),
    );
    if (suffix.length === 1) {
      return {
        resolution: {
          status: "resolved",
          strategy: "id_suffix",
          input,
          matched: sessionIdentity(suffix[0]!),
        },
        record: suffix[0],
        warnings,
      };
    }
    if (suffix.length > 1) {
      return ambiguous(input, suffix, warnings);
    }
    return { resolution: { status: "not_found", input }, warnings };
  }

  const byScope = resolveByScope(records, ref);
  if (byScope.length === 1) {
    return {
      resolution: {
        status: "resolved",
        strategy: "scope",
        input,
        matched: sessionIdentity(byScope[0]!),
      },
      record: byScope[0],
      warnings,
    };
  }
  if (byScope.length > 1) {
    return ambiguous(input, byScope, warnings);
  }

  return { resolution: { status: "not_found", input }, warnings };
}

function resolveByScope(records: SessionRecord[], ref: SessionRef): SessionRecord[] {
  const cwd = ref.cwd ? path.resolve(ref.cwd) : undefined;
  const candidates = records.filter((record) => {
    if (!ref.includeClosed && record.closed === true) {
      return false;
    }
    if (ref.agent && record.agentCommand !== ref.agent && !record.agentCommand.includes(ref.agent)) {
      return false;
    }
    if (ref.name != null && record.name !== ref.name) {
      return false;
    }
    if (!cwd) {
      return true;
    }
    return record.cwd === cwd || isParent(record.cwd, cwd);
  });
  return candidates.sort((a, b) => b.cwd.length - a.cwd.length || b.lastUsedAt.localeCompare(a.lastUsedAt));
}

function isParent(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function idValues(record: SessionRecord): string[] {
  return [record.acpxRecordId, record.acpSessionId, record.agentSessionId].filter(
    (entry): entry is string => Boolean(entry),
  );
}

function ambiguous(input: Record<string, unknown>, records: SessionRecord[], warnings: string[]) {
  return {
    resolution: {
      status: "ambiguous" as const,
      input,
      candidates: records.map(sessionIdentity),
    },
    warnings,
  };
}

function cleanInput(ref: SessionRef): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(ref).filter(
      ([, value]) => value !== undefined && value !== null && value !== false && value !== "",
    ),
  );
}
