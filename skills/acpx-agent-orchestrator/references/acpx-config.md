# ACPX Configuration

Current known local facts from this machine:

- `acpx` is expected to be installed on `PATH`.
- Global config path: `~/.acpx/config.json`.
- `trae` is an acpx built-in command and does not need a custom `agents` config entry.
- `aiden` is available through the custom command `aiden acp`.
- Any registered acpx agent can be used by this skill.

## Minimal Config Shape

When editing `~/.acpx/config.json`, preserve all existing keys. Add only missing aliases:

```json
{
  "agents": {
    "aiden": {
      "command": "aiden acp"
    }
  }
}
```

Recommended global defaults:

```json
{
  "defaultAgent": "trae",
  "defaultPermissions": "approve-all",
  "nonInteractivePermissions": "deny",
  "authPolicy": "skip",
  "ttl": 300,
  "queueMaxDepth": 16,
  "format": "text"
}
```

Do not overwrite local auth or unrelated agent aliases.

## Commands

Use these commands to inspect and manage acpx agents:

```bash
AGENT=trae
acpx config show
acpx "$AGENT" sessions
acpx "$AGENT" sessions ensure --name impl
acpx "$AGENT" status
```

Use one-shot prompts when you do not want a saved session:

```bash
AGENT=aiden
acpx --approve-reads --no-terminal "$AGENT" exec "Summarize the repo in five bullets."
```

Use persistent sessions for real work:

```bash
AGENT=trae
acpx --approve-all "$AGENT" -s impl "Implement the accepted plan..."
```

## End-to-End Session Validation

Use named sessions to prove the agent can both start and converse. Run this only after a real tool call fails or when explicitly asked to diagnose availability:

```bash
scripts/acpx-e2e-validate.sh trae aiden
scripts/acpx-e2e-validate.sh <agent>
```
