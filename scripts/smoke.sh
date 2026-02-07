#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUNNER="${JAGC_RUNNER:-echo}"
PORT="${JAGC_PORT:-31415}"
HOST="${JAGC_HOST:-127.0.0.1}"
API_URL="http://$HOST:$PORT"
DB_HOST="${JAGC_PGHOST:-127.0.0.1}"
DB_PORT="${JAGC_PGPORT:-5432}"
DB_USER="${JAGC_PGUSER:-postgres}"
DB_NAME="${JAGC_PGDATABASE:-jagc}"
SERVER_LOG_FILE="${JAGC_SMOKE_SERVER_LOG_FILE:-/tmp/jagc-smoke-server.log}"

scripts/dev-postgres.sh createdb

export JAGC_DATABASE_URL="postgres://$DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"

REMOVE_WORKSPACE_DIR=0
SMOKE_WORKSPACE_DIR="${JAGC_WORKSPACE_DIR:-}"
if [[ -z "$SMOKE_WORKSPACE_DIR" ]]; then
  SMOKE_WORKSPACE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jagc-smoke-workspace.XXXXXX")"
  REMOVE_WORKSPACE_DIR=1
else
  mkdir -p "$SMOKE_WORKSPACE_DIR"
fi

export JAGC_WORKSPACE_DIR="$SMOKE_WORKSPACE_DIR"
export JAGC_RUNNER="$RUNNER"
export JAGC_PORT="$PORT"
export JAGC_API_URL="$API_URL"

pnpm -s exec tsx src/server/main.ts >"$SERVER_LOG_FILE" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  wait "$SERVER_PID" >/dev/null 2>&1 || true

  if [[ "$REMOVE_WORKSPACE_DIR" == "1" ]]; then
    rm -rf "$SMOKE_WORKSPACE_DIR"
  fi
}
trap cleanup EXIT

server_ready=0
for _ in $(seq 1 60); do
  if curl -sf "$API_URL/healthz" >/dev/null; then
    server_ready=1
    break
  fi
  sleep 0.25
done

if [[ "$server_ready" != "1" ]]; then
  echo "smoke server failed to start; see $SERVER_LOG_FILE" >&2
  exit 1
fi

pnpm -s dev:cli health --json | jq -e '.ok == true' >/dev/null

MESSAGE_JSON="$(pnpm -s dev:cli message "ping" --json)"
RUN_ID="$(echo "$MESSAGE_JSON" | jq -r '.run_id')"

if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  echo "missing run_id in message response" >&2
  echo "$MESSAGE_JSON" >&2
  exit 1
fi

RUN_RESULT="$(pnpm -s dev:cli run wait "$RUN_ID" --json)"
STATUS="$(echo "$RUN_RESULT" | jq -r '.status')"

if [[ "$STATUS" != "succeeded" ]]; then
  echo "run did not succeed" >&2
  echo "$RUN_RESULT" >&2
  exit 1
fi

echo "$RUN_RESULT"
