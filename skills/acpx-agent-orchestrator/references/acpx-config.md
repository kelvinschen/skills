# ACPX Configuration

Current known local facts from this machine:

- `acpx` is expected to be installed on `PATH`.
- Global config path: `~/.acpx/config.json`.
- `trae` is an acpx built-in command and does not need a custom `agents` config entry.
- `aiden` is available through the custom command `aiden acp`.
- Current final target agent set is only `trae` and `aiden`.

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

Use these commands to inspect and manage acpx:

```bash
acpx config show
acpx trae sessions
acpx aiden sessions
acpx trae sessions ensure --name impl
acpx aiden sessions ensure --name review
acpx trae status
acpx aiden status
```

Use one-shot prompts when you do not want a saved session:

```bash
acpx --approve-reads --no-terminal aiden exec "Summarize the repo in five bullets."
```

Use persistent sessions for real work:

```bash
acpx --approve-all trae -s impl "Implement the accepted plan..."
```

## End-to-End Session Validation

Use named sessions to prove the agent can both start and converse. Run this only after a real tool call fails or when explicitly asked to diagnose availability:

```bash
acpx trae sessions new -s e2e-trae
acpx --timeout 120 --format text --deny-all --no-terminal trae -s e2e-trae 'Reply exactly OK and nothing else.'
acpx trae sessions close e2e-trae

acpx aiden sessions new -s e2e-aiden
acpx --timeout 120 --format text --deny-all --no-terminal aiden -s e2e-aiden 'Reply exactly OK and nothing else.'
acpx aiden sessions close e2e-aiden
```
