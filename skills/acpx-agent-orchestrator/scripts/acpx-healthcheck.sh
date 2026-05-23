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

echo "== local commands =="
for cmd in trae aiden acpx; do
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '%-8s %s\n' "$cmd" "$(command -v "$cmd")"
  else
    printf '%-8s %s\n' "$cmd" "not found"
  fi
done
echo

echo "== trae help =="
acpx trae --help | sed -n '1,120p'
echo

echo "== aiden help =="
acpx aiden --help | sed -n '1,120p'
