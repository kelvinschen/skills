---
name: remote-agent-browser
description: Launch, stop, restart, or check a remote GUI browser service started by agent-browser in headed mode. Use this whenever the user wants a stable VNC/noVNC remote browser for visual monitoring + automation, especially when they want to reuse agent-browser profile/session behavior and avoid manually launching chromium.
---

# Remote Agent Browser Management

Use `remote-agent-browser.sh` to manage a remote browser stack (`Xvfb + x11vnc + noVNC`) where the browser is launched by `agent-browser --headed`.

## Basic Usage

```bash
# Start service
./remote-agent-browser.sh start

# Check status and access URL
./remote-agent-browser.sh status

# Restart service (stop + start)
./remote-agent-browser.sh restart

# Stop service
./remote-agent-browser.sh stop
```

## Integration with agent-browser

After the service starts, you can directly use `agent-browser` for automation while observing the browser through VNC/noVNC:

```bash
agent-browser open https://example.com
agent-browser snapshot -i
agent-browser click @e1
agent-browser tab # list all tabs
```

## Detailed Options

For all command options and advanced examples, see:
- [references/options.md](references/options.md)
