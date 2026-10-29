#!/usr/bin/env bash
# Smoke test against a running sysadm server on a fresh database: setup, login with TOTP,
# credentials, import (idempotent), jump chain from the import, and the public/internal split.
# Needs curl, jq and bun. Does not need Docker or real hosts; SSH is not exercised here.
set -euo pipefail

BASE="${SYSADM_URL:-http://127.0.0.1:8080}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASSWORD="${SMOKE_PASSWORD:-smoke-password-123}"
JSON='Content-Type: application/json'
JAR="$(mktemp)"
HDR="$(mktemp)"
BODY="$(mktemp)"
trap 'rm -f "$JAR" "$HDR" "$BODY"' EXIT
SID=""

fail() {
  echo "SMOKE FAIL: $*" >&2
  exit 1
}

# call METHOD PATH [curl args...]: sets STATUS, response body in $BODY, Set-Cookie in $HDR.
# The sid cookie is sent by hand: it is Secure, and curl does not send Secure cookies over plain http.
call() {
  local method="$1" path="$2"
  shift 2
  STATUS="$(curl -sS -o "$BODY" -D "$HDR" -w '%{http_code}' -X "$method" "$BASE$path" \
    -H 'X-Requested-With: sysadm' -H "Cookie: sid=$SID" "$@")"
  local fresh
  fresh="$(sed -n 's/^[Ss]et-[Cc]ookie: sid=\([^;]*\).*/\1/p' "$HDR" | tail -n 1)"
  if [ -n "$fresh" ]; then SID="$fresh"; fi
}

expect() {
  [ "$STATUS" = "$1" ] || fail "$2: HTTP $STATUS, body: $(cat "$BODY")"
}

# Current TOTP code for an otpauth URI, computed with the server's own otpauth dependency.
totp() {
  (cd "$ROOT/apps/server" && OTP_URI="$1" bun -e 'import * as OTPAuth from "otpauth"; console.log(OTPAuth.URI.parse(process.env.OTP_URI).generate());')
}

# Imports the RustConn fixture and prints "created" from the apply response.
import_sample() {
  call POST /api/import/preview -F "file=@$ROOT/tests/fixtures/import/sample.rcn" -F source=rustconn
  expect 200 "import preview"
  local token
  token="$(jq -r '.token' "$BODY")"
  call POST /api/import/apply -H "$JSON" -d "{\"token\":\"$token\",\"skipKeys\":[]}"
  expect 200 "import apply"
  jq -r '.created' "$BODY"
}

call GET /api/health
expect 200 "health"

call POST /api/auth/setup -H "$JSON" -d "{\"password\":\"$PASSWORD\"}"
expect 201 "setup (server must be on a fresh database)"
OTP_URI="$(jq -r '.otpauth' "$BODY")"

call POST /api/auth/login -H "$JSON" -d "{\"password\":\"$PASSWORD\",\"code\":\"000000\"}"
expect 401 "login with a wrong code"

call POST /api/auth/login -H "$JSON" -d "{\"password\":\"$PASSWORD\",\"code\":\"$(totp "$OTP_URI")\"}"
expect 200 "login"
[ -n "$SID" ] || fail "login set no sid cookie"

call GET /api/tree
expect 200 "tree without a session"
call POST /api/credentials -H "$JSON" -d '{"name":"smoke","type":"password","password":"not-a-real-secret"}'
expect 201 "create credential"

CREATED="$(import_sample)"
[ "$CREATED" -gt 0 ] || fail "first import created nothing"
AGAIN="$(import_sample)"
[ "$AGAIN" = "0" ] || fail "second import of the same file created $AGAIN nodes (expected 0)"

call GET /api/tree
expect 200 "tree"
VM_ID="$(jq -r '.[] | select(.name == "vm-01") | .id' "$BODY")"
[ -n "$VM_ID" ] || fail "vm-01 not in tree after import"

call GET "/api/nodes/$VM_ID"
expect 200 "node vm-01"
jq -e '.effective.jumpChain | length == 1' "$BODY" >/dev/null || fail "vm-01 jump chain is not one bastion: $(jq -c '.effective.jumpChain' "$BODY")"

call GET /api/credentials
expect 200 "credentials"
jq -e 'all(.[]; keys | all(. == "id" or . == "name" or . == "type" or . == "createdAt"))' "$BODY" >/dev/null \
  || fail "credential list exposes fields other than id/name/type/createdAt"

# Bearer tokens: a read-only token reads the tree, and is refused on mutations and on /api/tokens.
call POST /api/tokens -H "$JSON" -d '{"name":"smoke-read","scopes":["read"],"ttlDays":1}'
expect 201 "create read token"
READ_TOKEN="$(jq -r '.token' "$BODY")"
[[ "$READ_TOKEN" == sat_* ]] || fail "token does not start with sat_"

bearer() {
  local method="$1" path="$2"
  shift 2
  STATUS="$(curl -sS -o "$BODY" -w '%{http_code}' -X "$method" "$BASE$path" \
    -H "Authorization: Bearer $READ_TOKEN" "$@")"
}
bearer GET /api/tree
expect 200 "read token on tree"
bearer POST /api/nodes -H "$JSON" -d '{"kind":"company","name":"x","parentId":null}'
expect 403 "read token creating a node"
bearer GET /api/tokens
expect 403 "read token listing tokens"

call GET /api/system/health
expect 200 "system health"
jq -e 'has("opencode")' "$BODY" >/dev/null || fail "health has no opencode state"

call POST /internal/exec -H "$JSON" -d '{"sessionID":"x","command":"uptime"}'
[ "$STATUS" = "404" ] || fail "internal route answers on the public port (HTTP $STATUS)"

echo "SMOKE OK"
