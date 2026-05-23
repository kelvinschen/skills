#!/usr/bin/env bash
set -euo pipefail

if ! command -v acpx >/dev/null 2>&1; then
  echo "ERROR: acpx is not available on PATH" >&2
  exit 1
fi

echo "Using: acpx"
echo

echo "== acpx help =="
acpx --help | sed -n '1,80p'
echo

echo "== acpx config =="
acpx config show
echo

if [[ "$#" -gt 0 ]]; then
  AGENTS=("$@")
else
  read -r -a AGENTS <<<"${ACPX_HEALTHCHECK_AGENTS:-trae aiden}"
fi

echo "== local commands =="
for cmd in "${AGENTS[@]}" acpx; do
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '%-8s %s\n' "$cmd" "$(command -v "$cmd")"
  else
    printf '%-8s %s\n' "$cmd" "not found"
  fi
done
echo

for agent in "${AGENTS[@]}"; do
  echo "== ${agent} help =="
  acpx "$agent" --help | sed -n '1,120p'
  echo
done
