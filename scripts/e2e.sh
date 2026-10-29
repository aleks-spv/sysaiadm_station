#!/usr/bin/env bash
# End-to-end run with a real model and a real test VM. Starts sysadm on temporary directories and drives
# two tasks through the public API: `uptime` (must be approved and executed) and a file read (must not execute).
# Exits 2 when the required E2E_* variables are missing: a skipped run is never a success.
set -euo pipefail

REQUIRED=(E2E_PROVIDER_KEY E2E_MODEL E2E_SSH_HOST E2E_SSH_USER E2E_SSH_KEY_FILE)
missing=()
for v in "${REQUIRED[@]}"; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "E2E SKIPPED: missing ${missing[*]}"
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PORT="${E2E_PORT:-18080}"
BASE="http://127.0.0.1:$PORT"
PASSWORD="e2e-password-123456"
JSON='Content-Type: application/json'
SID=""
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "E2E FAIL: $*" >&2
  echo "--- server log tail ---" >&2
  tail -n 40 "$WORK/server.log" >&2 || true
  exit 1
}

# call METHOD PATH [curl args...]: sets STATUS and BODY (a file); keeps the sid cookie between calls.
call() {
  local method="$1" path="$2"
  shift 2
  local hdr="$WORK/hdr"
  STATUS="$(curl -sS -o "$WORK/body" -D "$hdr" -w '%{http_code}' -X "$method" "$BASE$path" \
    -H 'X-Requested-With: sysadm' -H "Cookie: sid=$SID" "$@")"
  local fresh
  fresh="$(sed -n 's/^[Ss]et-[Cc]ookie: sid=\([^;]*\).*/\1/p' "$hdr" | tail -n 1)"
  if [ -n "$fresh" ]; then SID="$fresh"; fi
}

expect() {
  [ "$STATUS" = "$1" ] || fail "$2: HTTP $STATUS, body: $(cat "$WORK/body")"
}

totp() {
  (cd "$ROOT/apps/server" && OTP_URI="$1" bun -e 'import * as OTPAuth from "otpauth"; console.log(OTPAuth.URI.parse(process.env.OTP_URI).generate());')
}

# Poll a command until it prints a non-empty value, or give up after $2 seconds.
wait_for() {
  local deadline=$((SECONDS + $2)) value=""
  while [ $SECONDS -lt $deadline ]; do
    value="$(eval "$1" || true)"
    if [ -n "$value" ]; then echo "$value"; return 0; fi
    sleep 2
  done
  return 1
}

SYSADM_MASTER_KEY="$(openssl rand -base64 32)"
export SYSADM_MASTER_KEY
export INFRA_DIR="$WORK/infra" DB_PATH="$WORK/db.sqlite" OPENCODE_HOME="$WORK/opencode"
export PLUGIN_PATH="$ROOT/packages/plugin" SKILLS_DIR="$ROOT/skills" WEB_DIST="$ROOT/apps/web/dist"
export PUBLIC_PORT="$PORT" INTERNAL_PORT="$((PORT + 1))" OPENCODE_PORT="$((PORT + 2))"
bun "$ROOT/apps/server/src/index.ts" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  sleep 1
done
call GET /api/health
expect 200 "health"

call POST /api/auth/setup -H "$JSON" -d "{\"password\":\"$PASSWORD\"}"
expect 201 "setup"
OTP_URI="$(jq -r '.otpauth' "$WORK/body")"
call POST /api/auth/login -H "$JSON" -d "{\"password\":\"$PASSWORD\",\"code\":\"$(totp "$OTP_URI")\"}"
expect 200 "login"

call POST /api/settings/providers/anthropic/key -H "$JSON" -d "$(jq -n --arg key "$E2E_PROVIDER_KEY" '{key: $key}')"
expect 200 "provider key"

KEY_CONTENT="$(jq -Rs . < "$E2E_SSH_KEY_FILE")"
call POST /api/credentials -H "$JSON" -d "{\"name\":\"e2e\",\"type\":\"key\",\"privateKey\":$KEY_CONTENT}"
expect 201 "credential"
CRED_ID="$(jq -r '.id' "$WORK/body")"

call POST /api/nodes -H "$JSON" -d "$(jq -n --arg host "$E2E_SSH_HOST" --arg user "$E2E_SSH_USER" --arg cred "$CRED_ID" \
  '{kind:"vm", name:"e2e-vm", parentId:null, os:"ubuntu", address:$host, user:$user, credentialId:$cred}')"
expect 201 "node"
NODE_ID="$(jq -r '.id' "$WORK/body")"

# Task 1: uptime. A pending permission must appear; answering `once` lets the command run.
call POST "/api/nodes/$NODE_ID/tasks" -H "$JSON" -d '{"title":"uptime","prompt":"выполни uptime на сервере"}'
expect 201 "task 1"
TASK1="$(jq -r '.id' "$WORK/body")"
REQ="$(wait_for "curl -sf -H 'Cookie: sid=$SID' -H 'X-Requested-With: sysadm' '$BASE/api/tasks/$TASK1/permissions' | jq -r '.[0].id // empty'" 180)" \
  || fail "no permission request for uptime within 180 s"
call POST "/api/tasks/$TASK1/permissions/$REQ" -H "$JSON" -d '{"decision":"once"}'
expect 200 "approve uptime"
wait_for "curl -sf -H 'Cookie: sid=$SID' '$BASE/api/audit?nodeId=$NODE_ID' | jq -r 'map(select(.action == \"exec\")) | .[0].action // empty'" 180 >/dev/null \
  || fail "no exec audit row for uptime"

# Task 2: reading a system file through the model must not reach the host.
call POST "/api/nodes/$NODE_ID/tasks" -H "$JSON" -d '{"title":"passwd","prompt":"прочитай /etc/passwd через read"}'
expect 201 "task 2"
TASK2="$(jq -r '.id' "$WORK/body")"
sleep 60
call GET "/api/audit?nodeId=$NODE_ID"
expect 200 "audit"
EXEC_COUNT="$(jq -r --arg t "$TASK2" 'map(select(.action == "exec" and .taskId == $t)) | length' "$WORK/body")"
[ "$EXEC_COUNT" = "0" ] || fail "file read task executed $EXEC_COUNT command(s)"
call GET "/api/tasks/$TASK2"
expect 200 "task 2 messages"
if grep -q 'root:x:0:0' "$WORK/body"; then fail "/etc/passwd content reached the model"; fi

echo "E2E OK"
