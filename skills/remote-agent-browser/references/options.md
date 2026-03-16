# remote-agent-browser.sh Options

## Commands

- `start`: Start Xvfb + x11vnc + noVNC and launch browser via agent-browser
- `stop`: Stop all services
- `restart`: Stop then start (supports the same options as `start`)
- `status`: Show running status and access URLs

## start

Usage:

```bash
./remote-agent-browser.sh start [options]
```

Options:

- `-v, --verbose` Enable verbose logging
- `-f, --foreground` Run in foreground mode
- `--vnc-port <port>` VNC server port (default: `5900`)
- `--novnc-port <port>` noVNC web access port (default: `6080`)
- `--screen-size <WxHxD>` Screen size (default: `1600x1200x24`)
- `--start-url <url>` Initial URL opened by agent-browser (default: `about:blank`)
- `-h, --help` Show help

Examples:

```bash
./remote-agent-browser.sh start --vnc-port 5901 --novnc-port 6081
./remote-agent-browser.sh start --screen-size 1920x1080x24
./remote-agent-browser.sh start --start-url https://example.com
./remote-agent-browser.sh start -f -v
```

## stop

Usage:

```bash
./remote-agent-browser.sh stop [options]
```

Options:

- `--vnc-port <port>` VNC server port (default: `5900`)
- `--novnc-port <port>` noVNC web access port (default: `6080`)
- `-h, --help` Show help

## restart

Usage:

```bash
./remote-agent-browser.sh restart [options]
```

Behavior:
- Equivalent to `stop` then `start`
- Accepts the same options as `start`

## status

Usage:

```bash
./remote-agent-browser.sh status [options]
```

Options:

- `--vnc-port <port>` VNC server port (default: `5900`)
- `--novnc-port <port>` noVNC web access port (default: `6080`)
- `-h, --help` Show help

## Port Occupancy Behavior on start

When running `start`:

- If target ports are occupied, script will call `status` automatically.
- If an existing remote-agent-browser service is detected, you can reuse it or run `restart`.
- If occupied by other processes, free ports or use different ports.

## Logs and Troubleshooting

- agent-browser launch log: `/tmp/remote-agent-browser-agent-browser.log`
- If status shows session not detected, run one command like:

```bash
agent-browser open https://example.com
```
