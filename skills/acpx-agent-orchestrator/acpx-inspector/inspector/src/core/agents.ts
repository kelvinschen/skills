import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "./state-dir.js";
import { isObject, shellQuote } from "./util.js";

const BUILT_INS: Record<string, string> = {
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
  trae: "traecli acp serve",
};

export async function loadConfiguredAgents(stateDir?: string, cwd?: string): Promise<Record<string, string>> {
  const configs = [
    path.join(resolveStateDir(stateDir), "config.json"),
    cwd ? path.join(path.resolve(cwd), ".acpxrc.json") : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  const result: Record<string, string> = {};
  for (const file of configs) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      if (!isObject(parsed) || !isObject(parsed.agents)) {
        continue;
      }
      for (const [name, raw] of Object.entries(parsed.agents)) {
        if (!isObject(raw) || typeof raw.command !== "string" || raw.command.trim().length === 0) {
          continue;
        }
        const args = Array.isArray(raw.args)
          ? raw.args.filter((arg): arg is string => typeof arg === "string")
          : [];
        result[name.toLowerCase()] =
          args.length > 0 ? `${raw.command.trim()} ${args.map(shellQuote).join(" ")}` : raw.command.trim();
      }
    } catch {
      // Ignore config read failures; inspector still works from session files.
    }
  }
  return result;
}

export async function agentDisplayName(
  agentCommand: string,
  options: { stateDir?: string; cwd?: string } = {},
): Promise<string | undefined> {
  const configured = await loadConfiguredAgents(options.stateDir, options.cwd);
  for (const [name, command] of Object.entries({ ...BUILT_INS, ...configured })) {
    if (command === agentCommand || commandWithoutPinnedRange(command) === commandWithoutPinnedRange(agentCommand)) {
      return name;
    }
  }
  return undefined;
}

export async function acpxCommandPrefix(
  agentCommand: string,
  cwd: string,
  options: { stateDir?: string } = {},
): Promise<string> {
  const name = await agentDisplayName(agentCommand, { stateDir: options.stateDir, cwd });
  if (name) {
    return `acpx --cwd ${shellQuote(cwd)} ${shellQuote(name)}`;
  }
  return `acpx --agent ${shellQuote(agentCommand)} --cwd ${shellQuote(cwd)}`;
}

function commandWithoutPinnedRange(value: string): string {
  return value.replace(/@\^[0-9][^\s]*/g, "").replace(/@latest/g, "").trim();
}
