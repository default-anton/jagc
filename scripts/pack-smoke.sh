#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jagc-pack-smoke.XXXXXX")"
PREFIX_DIR="$TMP_DIR/prefix"
WORKSPACE_DIR="$TMP_DIR/workspace"
SERVER_LOG_FILE="$TMP_DIR/server.log"
PORT="${JAGC_PACK_SMOKE_PORT:-32415}"
API_URL="http://127.0.0.1:$PORT"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi

  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

PACK_OUTPUT="$(npm pack --pack-destination "$TMP_DIR")"
TARBALL_NAME="$(echo "$PACK_OUTPUT" | tail -n 1)"
TARBALL_PATH="$TMP_DIR/$TARBALL_NAME"

TARBALL_CONTENTS_FILE="$TMP_DIR/tarball-contents.txt"
tar -tf "$TARBALL_PATH" >"$TARBALL_CONTENTS_FILE"

if command -v rg >/dev/null 2>&1; then
  if ! rg -q '^package/defaults/skills/agents-md/SKILL\.md$' "$TARBALL_CONTENTS_FILE"; then
    echo "pack smoke tarball missing defaults/skills payload" >&2
    exit 1
  fi

  if ! rg -q '^package/defaults/extensions/30-global-agents-loader\.ts$' "$TARBALL_CONTENTS_FILE"; then
    echo "pack smoke tarball missing defaults/extensions payload" >&2
    exit 1
  fi

  if ! rg -q '^package/defaults/memory/INDEX\.md$' "$TARBALL_CONTENTS_FILE"; then
    echo "pack smoke tarball missing defaults/memory payload" >&2
    exit 1
  fi
else
  if ! grep -q '^package/defaults/skills/agents-md/SKILL\.md$' "$TARBALL_CONTENTS_FILE"; then
    echo "pack smoke tarball missing defaults/skills payload" >&2
    exit 1
  fi

  if ! grep -q '^package/defaults/extensions/30-global-agents-loader\.ts$' "$TARBALL_CONTENTS_FILE"; then
    echo "pack smoke tarball missing defaults/extensions payload" >&2
    exit 1
  fi

  if ! grep -q '^package/defaults/memory/INDEX\.md$' "$TARBALL_CONTENTS_FILE"; then
    echo "pack smoke tarball missing defaults/memory payload" >&2
    exit 1
  fi
fi

npm install -g --prefix "$PREFIX_DIR" "$TARBALL_PATH" >/dev/null

CLI_PATH="$PREFIX_DIR/bin/jagc"
PKG_DIR="$PREFIX_DIR/lib/node_modules/jagc"
SERVER_ENTRYPOINT="$PKG_DIR/dist/server/main.mjs"

"$CLI_PATH" --help >/dev/null

JAGC_RUNNER=echo JAGC_WORKSPACE_DIR="$WORKSPACE_DIR" JAGC_PORT="$PORT" node "$SERVER_ENTRYPOINT" >"$SERVER_LOG_FILE" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 80); do
  if curl -sf "$API_URL/healthz" >/dev/null; then
    break
  fi

  sleep 0.25
done

if ! curl -sf "$API_URL/healthz" >/dev/null; then
  echo "pack smoke server failed to start; see $SERVER_LOG_FILE" >&2
  exit 1
fi

if [[ ! -f "$WORKSPACE_DIR/skills/agents-md/SKILL.md" ]]; then
  echo "pack smoke workspace bootstrap missing skills payload" >&2
  exit 1
fi

if [[ ! -f "$WORKSPACE_DIR/extensions/30-global-agents-loader.ts" ]]; then
  echo "pack smoke workspace bootstrap missing extensions payload" >&2
  exit 1
fi

if [[ ! -f "$WORKSPACE_DIR/memory/INDEX.md" ]]; then
  echo "pack smoke workspace bootstrap missing memory payload" >&2
  exit 1
fi

"$CLI_PATH" --api-url "$API_URL" health --json | jq -e '.ok == true' >/dev/null
RUN_ID="$("$CLI_PATH" --api-url "$API_URL" message "pack smoke ping" --json | jq -r '.run_id')"
"$CLI_PATH" --api-url "$API_URL" run wait "$RUN_ID" --json | jq -e '.status == "succeeded"' >/dev/null

echo "pack smoke ok"
