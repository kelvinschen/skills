#!/usr/bin/env bash
set -u

if ! command -v acpx >/dev/null 2>&1; then
  echo "ERROR: acpx is not available on PATH" >&2
  exit 1
fi

PROMPT='Reply exactly OK and nothing else.'
TIMEOUT_SECONDS="${ACPX_E2E_TIMEOUT_SECONDS:-150}"
STAMP="$(date +%Y%m%d%H%M%S)"

run_session_probe() {
  local agent="$1"
  local session="e2e-${agent}-${STAMP}"
  local out code start duration

  printf '\n== %s session new ==\n' "$agent"
  start=$(date +%s)
  out=$(timeout "$TIMEOUT_SECONDS" acpx "$agent" sessions new -s "$session" 2>&1)
  code=$?
  duration=$(($(date +%s) - start))
  printf 'session=%s exit=%s duration=%ss\n' "$session" "$code" "$duration"
  printf '%s\n' "$out" | sed -n '1,80p'
  if [[ "$code" -ne 0 ]]; then
    printf 'RESULT FAIL agent=%s phase=session-new\n' "$agent"
    return
  fi

  printf '\n== %s persistent prompt ==\n' "$agent"
  start=$(date +%s)
  out=$(timeout "$TIMEOUT_SECONDS" acpx --timeout 120 --format text --deny-all --no-terminal "$agent" -s "$session" "$PROMPT" 2>&1)
  code=$?
  duration=$(($(date +%s) - start))
  if [[ "$code" -eq 0 ]] && grep -q '^OK$' <<<"$out"; then
    printf 'RESULT PASS agent=%s session=%s exit=%s duration=%ss\n' "$agent" "$session" "$code" "$duration"
  else
    printf 'RESULT FAIL agent=%s session=%s exit=%s duration=%ss\n' "$agent" "$session" "$code" "$duration"
  fi
  printf '%s\n' "$out" | sed -n '1,100p'

  printf '\n== %s session show ==\n' "$agent"
  timeout 60 acpx "$agent" sessions show "$session" 2>&1 | sed -n '1,80p' || true

  printf '\n== %s session cleanup ==\n' "$agent"
  out=$(timeout 60 acpx "$agent" sessions close "$session" 2>&1)
  code=$?
  if [[ "$code" -eq 0 ]]; then
    printf 'CLEANUP PASS agent=%s session=%s\n' "$agent" "$session"
  else
    printf 'CLEANUP WARN agent=%s session=%s exit=%s\n' "$agent" "$session" "$code"
  fi
  printf '%s\n' "$out" | sed -n '1,80p'
}

echo "Using: acpx"
echo "Timeout: ${TIMEOUT_SECONDS}s"

run_session_probe trae
run_session_probe aiden
