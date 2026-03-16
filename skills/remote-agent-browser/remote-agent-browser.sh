#!/bin/bash
# Remote Agent Browser - Unified Management Script
# Start Xvfb + x11vnc + noVNC, then let agent-browser launch headed browser

set -e

# ============================================================================
# Configuration
# ============================================================================

DISPLAY_NUM=99
VNC_PORT=5900
NOVNC_PORT=6080
SCREEN_SIZE="1600x1200x24"
START_URL="about:blank"
VERBOSE=false
FOREGROUND=false

VNC_PASSWORD_FILE="/tmp/remote-agent-browser-vnc-password.txt"
AGENT_BROWSER_LOG="/tmp/remote-agent-browser-agent-browser.log"

# ============================================================================
# Colors
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ============================================================================
# Logging
# ============================================================================

log_info() {
    echo -e "$@"
}

log_error() {
    echo -e "$@" >&2
}

log_verbose() {
    if [ "$VERBOSE" = true ]; then
        echo -e "$@"
    fi
}

# ============================================================================
# Helpers
# ============================================================================

check_command() {
    command -v "$1" >/dev/null 2>&1
}

find_pid() {
    pgrep -f "$1" 2>/dev/null | head -1
}

is_port_listening() {
    local port=$1

    if check_command ss && ss -tuln 2>/dev/null | grep -q ":${port} "; then
        return 0
    fi

    if check_command netstat && netstat -tuln 2>/dev/null | grep -q ":${port} "; then
        return 0
    fi

    return 1
}

check_port() {
    local port=$1
    local name=$2
    if is_port_listening "$port"; then
        log_error "${RED}✗ Error: Port ${port} ($name) is already in use${NC}"
        exit 1
    fi
}

find_novnc_pid() {
    local pid=""
    pid=$(find_pid "websockify.*${NOVNC_PORT}")
    [ -z "$pid" ] && pid=$(find_pid "novnc_proxy.*${NOVNC_PORT}")
    echo "$pid"
}

cleanup_runtime_files() {
    rm -f /tmp/.x11vnc-* 2>/dev/null || true
    rm -f "$VNC_PASSWORD_FILE" 2>/dev/null || true
}

is_remote_service_running() {
    local xvfb_pid=""
    local x11vnc_pid=""

    xvfb_pid=$(find_pid "Xvfb :${DISPLAY_NUM}")
    x11vnc_pid=$(find_pid "x11vnc.*:${DISPLAY_NUM}")

    [ -n "$xvfb_pid" ] && [ -n "$x11vnc_pid" ] && is_port_listening "$NOVNC_PORT"
}

# ============================================================================
# Options
# ============================================================================

parse_port_options_with_help() {
    local help_func="$1"
    shift

    while [[ $# -gt 0 ]]; do
        case $1 in
            --vnc-port)
                [ -n "$2" ] && [[ "$2" != -* ]] && VNC_PORT="$2" && shift 2 || { log_error "${RED}✗ Error: --vnc-port requires a port number${NC}"; exit 1; }
                ;;
            --novnc-port)
                [ -n "$2" ] && [[ "$2" != -* ]] && NOVNC_PORT="$2" && shift 2 || { log_error "${RED}✗ Error: --novnc-port requires a port number${NC}"; exit 1; }
                ;;
            -h|--help)
                "$help_func"
                exit 0
                ;;
            *)
                log_error "${RED}✗ Error: Unknown parameter $1${NC}"
                exit 1
                ;;
        esac
    done
}

parse_start_options() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -v|--verbose)
                VERBOSE=true
                shift
                ;;
            -f|--foreground)
                FOREGROUND=true
                shift
                ;;
            --vnc-port)
                [ -n "$2" ] && [[ "$2" != -* ]] && VNC_PORT="$2" && shift 2 || { log_error "${RED}✗ Error: --vnc-port requires a port number${NC}"; exit 1; }
                ;;
            --novnc-port)
                [ -n "$2" ] && [[ "$2" != -* ]] && NOVNC_PORT="$2" && shift 2 || { log_error "${RED}✗ Error: --novnc-port requires a port number${NC}"; exit 1; }
                ;;
            --screen-size)
                [ -n "$2" ] && [[ "$2" != -* ]] && SCREEN_SIZE="$2" && shift 2 || { log_error "${RED}✗ Error: --screen-size requires a resolution${NC}"; exit 1; }
                ;;
            --start-url)
                [ -n "$2" ] && [[ "$2" != -* ]] && START_URL="$2" && shift 2 || { log_error "${RED}✗ Error: --start-url requires a URL${NC}"; exit 1; }
                ;;
            -h|--help)
                show_start_help
                exit 0
                ;;
            *)
                log_error "${RED}✗ Error: Unknown parameter $1${NC}"
                exit 1
                ;;
        esac
    done
}

# ============================================================================
# Dependency check
# ============================================================================

check_dependencies() {
    local missing_deps=()
    local install_cmds=()

    if ! check_command Xvfb; then
        missing_deps+=("Xvfb (Virtual X Server)")
        install_cmds+=("sudo apt-get install xvfb")
    fi

    if ! check_command x11vnc; then
        missing_deps+=("x11vnc (VNC Server)")
        install_cmds+=("sudo apt-get install x11vnc")
    fi

    if ! check_command openssl; then
        missing_deps+=("openssl (Password Generator)")
        install_cmds+=("sudo apt-get install openssl")
    fi

    if ! check_command agent-browser; then
        missing_deps+=("agent-browser")
        install_cmds+=("npm i -g agent-browser")
    fi

    local novnc_found=false
    for path in /usr/share/novnc/utils/launch.sh /usr/share/novnc/utils/novnc_proxy /usr/share/novnc/utils/novnc_proxy.py; do
        [ -f "$path" ] && novnc_found=true && break
    done

    if [ "$novnc_found" = false ]; then
        if ! check_command websockify && ! check_command novnc_proxy; then
            missing_deps+=("noVNC (Web VNC Client)")
            install_cmds+=("sudo apt-get install novnc websockify")
        fi
    fi

    if [ ${#missing_deps[@]} -gt 0 ]; then
        log_error "${RED}${BOLD}✗ Error: Missing required dependencies${NC}"
        log_error ""
        echo -e "${YELLOW}The following dependencies are not installed:${NC}"
        for dep in "${missing_deps[@]}"; do
            echo -e "  ${RED}✗${NC} ${dep}"
        done
        log_error ""
        echo -e "${YELLOW}Installation commands:${NC}"
        for cmd in "${install_cmds[@]}"; do
            echo -e "  ${CYAN}${cmd}${NC}"
        done
        exit 1
    fi
}

# ============================================================================
# Runtime process management
# ============================================================================

pkill_remote_processes() {
    local force="$1"
    local patterns=(
        "Xvfb :${DISPLAY_NUM}"
        "x11vnc.*:${DISPLAY_NUM}"
        "websockify.*${NOVNC_PORT}"
        "novnc_proxy.*${NOVNC_PORT}"
    )

    local pattern
    for pattern in "${patterns[@]}"; do
        if [ "$force" = true ]; then
            pkill -9 -f "$pattern" 2>/dev/null || true
        else
            pkill -f "$pattern" 2>/dev/null || true
        fi
    done
}

# ============================================================================
# Commands
# ============================================================================

do_start() {
    parse_start_options "$@"

    log_info "${GREEN}${BOLD}╔════════════════════════════════════════════╗${NC}"
    log_info "${GREEN}${BOLD}║   Starting Remote Agent Browser Service    ║${NC}"
    log_info "${GREEN}${BOLD}╚════════════════════════════════════════════╝${NC}"
    log_info ""

    log_info "${YELLOW}• Checking dependencies...${NC}"
    check_dependencies

    log_info "${YELLOW}• Checking port availability...${NC}"
    if is_port_listening "$VNC_PORT" || is_port_listening "$NOVNC_PORT"; then
        log_info "${YELLOW}! Detected occupied port(s). Checking existing service status...${NC}"
        do_status --vnc-port "$VNC_PORT" --novnc-port "$NOVNC_PORT"

        if is_remote_service_running; then
            log_info "${YELLOW}Service is already running. You can reuse it directly, or run restart:${NC}"
            echo -e "   ${CYAN}./remote-agent-browser.sh restart --vnc-port ${VNC_PORT} --novnc-port ${NOVNC_PORT}${NC}"
            exit 0
        fi

        log_error "${RED}✗ Ports are occupied by other processes.${NC}"
        log_error "${YELLOW}Please free the ports or use different ports.${NC}"
        exit 1
    fi

    VNC_PASSWORD=$(openssl rand -hex 6)

    log_info "${YELLOW}• Starting virtual display Xvfb :${DISPLAY_NUM}...${NC}"
    Xvfb :${DISPLAY_NUM} -screen 0 ${SCREEN_SIZE} >/dev/null 2>&1 &
    XVFB_PID=$!
    sleep 0.5
    if ! kill -0 "$XVFB_PID" 2>/dev/null; then
        log_error "${RED}✗ Error: Xvfb failed to start${NC}"
        do_cleanup
        exit 1
    fi
    log_info "${GREEN}  ✓ Xvfb started${NC}"

    log_info "${YELLOW}• Starting x11vnc (port ${VNC_PORT})...${NC}"
    echo "$VNC_PASSWORD" > "$VNC_PASSWORD_FILE"
    chmod 600 "$VNC_PASSWORD_FILE"
    x11vnc -display :${DISPLAY_NUM} -forever -shared -rfbport ${VNC_PORT} -passwd ${VNC_PASSWORD} -bg -o /tmp/x11vnc.log >/dev/null 2>&1
    sleep 0.5
    log_info "${GREEN}  ✓ x11vnc started${NC}"

    log_info "${YELLOW}• Starting noVNC (port ${NOVNC_PORT})...${NC}"
    NOVNC_LAUNCHER=""
    for path in /usr/share/novnc/utils/launch.sh /usr/share/novnc/utils/novnc_proxy /usr/share/novnc/utils/novnc_proxy.py; do
        [ -f "$path" ] && NOVNC_LAUNCHER="$path" && break
    done

    if [ -z "$NOVNC_LAUNCHER" ]; then
        if check_command websockify; then
            NOVNC_LAUNCHER=$(command -v websockify)
        elif check_command novnc_proxy; then
            NOVNC_LAUNCHER=$(command -v novnc_proxy)
        fi
    fi

    if [ -z "$NOVNC_LAUNCHER" ]; then
        log_error "${RED}✗ Error: noVNC launch script not found${NC}"
        do_cleanup
        exit 1
    fi

    if [[ "$NOVNC_LAUNCHER" == *"launch.sh"* ]] || [[ "$NOVNC_LAUNCHER" == *"novnc_proxy"* ]]; then
        "$NOVNC_LAUNCHER" --vnc localhost:${VNC_PORT} --listen ${NOVNC_PORT} >/dev/null 2>&1 &
    else
        "$NOVNC_LAUNCHER" --web /usr/share/novnc localhost:${NOVNC_PORT} localhost:${VNC_PORT} >/dev/null 2>&1 &
    fi
    NOVNC_PID=$!
    sleep 0.5
    if ! is_port_listening "$NOVNC_PORT"; then
        log_error "${RED}✗ Error: noVNC failed to start${NC}"
        do_cleanup
        exit 1
    fi
    log_info "${GREEN}  ✓ noVNC started${NC}"

    DISPLAY=:${DISPLAY_NUM} agent-browser close >/dev/null 2>&1 || true
    if pgrep -f "agent-browser-linux" >/dev/null 2>&1; then
        pkill -f "agent-browser-linux" >/dev/null 2>&1 || true
    fi

    log_info "${YELLOW}• Launching browser via agent-browser (headed)...${NC}"
    if DISPLAY=:${DISPLAY_NUM} agent-browser --headed open "$START_URL" >"$AGENT_BROWSER_LOG" 2>&1; then
        log_info "${GREEN}  ✓ agent-browser launched headed browser${NC}"
    else
        log_error "${RED}✗ Error: agent-browser failed to launch browser${NC}"
        log_error "${YELLOW}  Log: ${AGENT_BROWSER_LOG}${NC}"
        do_cleanup
        exit 1
    fi

    HOST_IP=$(hostname -I | awk '{print $1}')

    log_info ""
    log_info "${GREEN}${BOLD}═════════════════════════════════════════════${NC}"
    log_info "${GREEN}${BOLD}          ✓ Service Started Successfully!${NC}"
    log_info "${GREEN}${BOLD}═════════════════════════════════════════════${NC}"
    log_info ""
    log_info "${BOLD}Web Access URL:${NC}"
    echo -e "   ${CYAN}${BOLD}http://${HOST_IP}:${NOVNC_PORT}/vnc.html?host=${HOST_IP}&port=${NOVNC_PORT}&password=${VNC_PASSWORD}&autoconnect=true${NC}"
    log_info ""
    log_info "${BOLD}VNC Connection:${NC}"
    echo -e "   ${CYAN}${BOLD}${HOST_IP}:${VNC_PORT}${NC} ${YELLOW}(Password: ${VNC_PASSWORD})${NC}"
    log_info ""
    log_info "${BOLD}Tips:${NC}"
    echo -e "   ${CYAN}agent-browser open https://example.com${NC}"
    echo -e "   ${CYAN}agent-browser snapshot -i${NC}"

    if [ "$VERBOSE" = true ]; then
        log_info ""
        log_info "${BOLD}Process Information:${NC}"
        echo -e "   Xvfb:    ${XVFB_PID}"
        echo -e "   x11vnc:  $(find_pid "x11vnc.*:${DISPLAY_NUM}")"
        echo -e "   noVNC:   ${NOVNC_PID}"
        echo -e "   agent-browser log: ${AGENT_BROWSER_LOG}"
    fi

    log_info ""

    if [ "$FOREGROUND" = true ]; then
        echo -e "${YELLOW}Note: Press Ctrl+C to stop all services${NC}"
        while true; do
            ! kill -0 "$XVFB_PID" 2>/dev/null && log_error "${RED}✗ Xvfb exited unexpectedly${NC}" && exit 1
            [ -n "$NOVNC_PID" ] && ! kill -0 "$NOVNC_PID" 2>/dev/null && log_error "${RED}✗ noVNC exited unexpectedly${NC}" && exit 1
            sleep 5
        done
    else
        echo -e "${YELLOW}Note: Service is running in background. Use 'remote-agent-browser.sh status' to check, 'remote-agent-browser.sh stop' to stop.${NC}"
    fi
}

do_cleanup() {
    # Close agent-browser browser if possible
    if check_command agent-browser; then
        DISPLAY=:${DISPLAY_NUM} agent-browser close >/dev/null 2>&1 || true
    fi

    pkill_remote_processes false
    cleanup_runtime_files
}

do_stop_silent() {
    pkill_remote_processes false
    cleanup_runtime_files
}

do_stop() {
    parse_port_options_with_help show_stop_help "$@"

    log_info "${YELLOW}Stopping Remote Agent Browser Service...${NC}"

    XVFB_PID=$(find_pid "Xvfb :${DISPLAY_NUM}")
    X11VNC_PID=$(find_pid "x11vnc.*:${DISPLAY_NUM}")
    NOVNC_RUNNING_PID=$(find_novnc_pid)

    if check_command agent-browser; then
        DISPLAY=:${DISPLAY_NUM} agent-browser close >/dev/null 2>&1 || true
        log_info "${GREEN}✓ agent-browser browser closed${NC}"
    fi

    [ -n "$X11VNC_PID" ] && kill "$X11VNC_PID" 2>/dev/null && log_info "${GREEN}✓ x11vnc stopped${NC}"
    [ -n "$NOVNC_RUNNING_PID" ] && kill "$NOVNC_RUNNING_PID" 2>/dev/null && log_info "${GREEN}✓ noVNC stopped${NC}"
    [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null && log_info "${GREEN}✓ Xvfb stopped${NC}"

    sleep 0.5
    pkill_remote_processes true
    cleanup_runtime_files

    log_info "${GREEN}${BOLD}✓ Service stopped${NC}"
}

do_restart() {
    if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
        show_restart_help
        exit 0
    fi

    # Validate start options first to avoid stopping service on bad args
    parse_start_options "$@"

    log_info "${YELLOW}Restarting Remote Agent Browser Service...${NC}"
    do_stop --vnc-port "$VNC_PORT" --novnc-port "$NOVNC_PORT"
    do_start "$@"
}

do_status() {
    parse_port_options_with_help show_status_help "$@"

    XVFB_PID=$(find_pid "Xvfb :${DISPLAY_NUM}")
    X11VNC_PID=$(find_pid "x11vnc.*:${DISPLAY_NUM}")
    NOVNC_PID=$(find_novnc_pid)

    SERVICE_RUNNING=false
    [ -n "$XVFB_PID" ] && [ -n "$X11VNC_PID" ] && is_port_listening "$NOVNC_PORT" && SERVICE_RUNNING=true

    log_info "${GREEN}${BOLD}╔════════════════════════════════════════════╗${NC}"
    log_info "${GREEN}${BOLD}║  Remote Agent Browser Service - Status     ║${NC}"
    log_info "${GREEN}${BOLD}╚════════════════════════════════════════════╝${NC}"
    log_info ""

    if [ "$SERVICE_RUNNING" = true ]; then
        log_info "${GREEN}${BOLD}Status: Running${NC}"
        echo -e "  ${GREEN}✓${NC} Xvfb PID: ${XVFB_PID}"
        echo -e "  ${GREEN}✓${NC} x11vnc PID: ${X11VNC_PID}"
        echo -e "  ${GREEN}✓${NC} noVNC PID: ${NOVNC_PID}"

        if check_command agent-browser && DISPLAY=:${DISPLAY_NUM} agent-browser --headed get url >/dev/null 2>&1; then
            echo -e "  ${GREEN}✓${NC} agent-browser session: active"
        else
            echo -e "  ${YELLOW}⚠${NC} agent-browser session: not detected"
        fi

        HOST_IP=$(hostname -I | awk '{print $1}')
        VNC_PASSWORD=""
        [ -f "$VNC_PASSWORD_FILE" ] && VNC_PASSWORD=$(cat "$VNC_PASSWORD_FILE" 2>/dev/null)

        log_info ""
        log_info "${BOLD}Web Access URL:${NC}"
        if [ -n "$VNC_PASSWORD" ]; then
            echo -e "   ${CYAN}${BOLD}http://${HOST_IP}:${NOVNC_PORT}/vnc.html?host=${HOST_IP}&port=${NOVNC_PORT}&password=${VNC_PASSWORD}&autoconnect=true${NC}"
            echo -e "   ${CYAN}${BOLD}VNC: ${HOST_IP}:${VNC_PORT}${NC} ${YELLOW}(Password: ${VNC_PASSWORD})${NC}"
        else
            echo -e "   ${CYAN}${BOLD}http://${HOST_IP}:${NOVNC_PORT}/vnc.html${NC}"
            echo -e "   ${CYAN}${BOLD}VNC: ${HOST_IP}:${VNC_PORT}${NC}"
        fi
    else
        log_info "${RED}${BOLD}Status: Not Running${NC}"
        log_info ""
        log_info "${YELLOW}Start with:${NC}"
        echo -e "   ${CYAN}./remote-agent-browser.sh start${NC}"
    fi

    log_info ""
}

# ============================================================================
# Help
# ============================================================================

show_help() {
    echo "Usage: ./remote-agent-browser.sh <command> [options]"
    echo ""
    echo "Commands:"
    echo "  start     Start Xvfb + VNC + noVNC and launch browser via agent-browser"
    echo "  stop      Stop all services"
    echo "  restart   Restart service (stop then start)"
    echo "  status    Show status and access URLs"
    echo ""
    echo "Run './remote-agent-browser.sh <command> --help' for options"
}

show_start_help() {
    echo "Usage: ./remote-agent-browser.sh start [options]"
    echo ""
    echo "Options:"
    echo "  -v, --verbose              Enable verbose logging"
    echo "  -f, --foreground           Run in foreground"
    echo "  --vnc-port <port>          VNC server port (default: 5900)"
    echo "  --novnc-port <port>        noVNC web access port (default: 6080)"
    echo "  --screen-size <WxHxD>      Screen size (default: 1600x1200x24)"
    echo "  --start-url <url>          Initial URL opened by agent-browser"
    echo "  -h, --help                 Show help"
}

show_stop_help() {
    echo "Usage: ./remote-agent-browser.sh stop [options]"
    echo ""
    echo "Options:"
    echo "  --vnc-port <port>          VNC server port (default: 5900)"
    echo "  --novnc-port <port>        noVNC web access port (default: 6080)"
    echo "  -h, --help                 Show help"
}

show_restart_help() {
    echo "Usage: ./remote-agent-browser.sh restart [options]"
    echo ""
    echo "Restart = stop + start."
    echo "Options are the same as start:"
    echo "  -v, --verbose              Enable verbose logging"
    echo "  -f, --foreground           Run in foreground"
    echo "  --vnc-port <port>          VNC server port (default: 5900)"
    echo "  --novnc-port <port>        noVNC web access port (default: 6080)"
    echo "  --screen-size <WxHxD>      Screen size (default: 1600x1200x24)"
    echo "  --start-url <url>          Initial URL opened by agent-browser"
    echo "  -h, --help                 Show help"
}

show_status_help() {
    echo "Usage: ./remote-agent-browser.sh status [options]"
    echo ""
    echo "Options:"
    echo "  --vnc-port <port>          VNC server port (default: 5900)"
    echo "  --novnc-port <port>        noVNC web access port (default: 6080)"
    echo "  -h, --help                 Show help"
}

# ============================================================================
# Main
# ============================================================================

if [ $# -eq 0 ]; then
    show_help
    exit 1
fi

COMMAND="$1"
shift

case "$COMMAND" in
    start)
        do_start "$@"
        ;;
    stop)
        do_stop "$@"
        ;;
    restart)
        do_restart "$@"
        ;;
    status)
        do_status "$@"
        ;;
    -h|--help)
        show_help
        ;;
    *)
        log_error "${RED}✗ Error: Unknown command '${COMMAND}'${NC}"
        show_help
        exit 1
        ;;
esac
