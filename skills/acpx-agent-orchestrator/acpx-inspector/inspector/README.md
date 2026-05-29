# acpx-inspector

`acpx-inspector` is an Agent Core inspector for acpx sessions. The recommended agent workflow is:

```bash
acpx-inspector sessions
acpx-inspector snapshot --id <session-id>
acpx-inspector read --id <session-id>
acpx-inspector diagnose --id <session-id>
acpx-inspector follow --id <session-id>
```

For flow progress, use the same follow surface:

```bash
acpx-inspector follow --run-id <flow-run-id>
acpx-inspector follow --run-dir <flow-run-dir>
```

## Agent Core

- `sessions`: discover manageable acpx sessions.
- `snapshot`: inspect compact session state at low context cost.
- `read`: read budgeted compact history.
- `diagnose`: inspect health, errors, and queue state.
- `follow`: block while tracking session or flow progress with duration, interval, and event limits.

## Human And Debug Extras

These commands remain supported, but they are not the recommended agent workflow:

- `tail`: debug event view for projected ACP events.
- `actions`: legacy convenience view for suggested actions.
- `command`: legacy helper that prints one suggested shell command.
- `report`: human handoff HTML reports for sessions, oneshot captures, or flows.

`--raw` options are debug escape hatches. Agent callers should prefer compact defaults to keep context bounded.

## Public API

Stable Agent Core exports:

- `sessionsView`
- `snapshot`
- `historyView`
- `diagnose`
- `followSession`
- `followFlow`
- `formatFollowTickText`
- `parseDurationMs`

Other exports are retained for advanced, debug, report, or compatibility use. They should not be treated as the primary agent-facing API.
