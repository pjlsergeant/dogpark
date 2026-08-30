#!/usr/bin/env bash
# End-to-end check against a running Dogpark, driving the scenarios in
# docs/scenarios.md rather than testing units. Written against docs/http-api.md,
# so a divergence between the implementation and the contract fails here.
#
#   DOGPARK_URL=http://localhost:8080 DOGPARK_PASSWORD=... ./scripts/smoke.sh
set -uo pipefail

URL="${DOGPARK_URL:-http://localhost:8080}"
PW="${DOGPARK_PASSWORD:?set DOGPARK_PASSWORD}"
JAR=$(mktemp); CSRF=""
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; echo "        wanted: $2"; echo "        got:    $3"; FAIL=$((FAIL+1)); }
step(){ echo; echo "$1"; }

admin() { # method path [json]
  local m="$1" p="$2" body="${3:-}"
  local args=(-sS -X "$m" -b "$JAR" -c "$JAR" -H 'Content-Type: application/json')
  [ -n "$CSRF" ] && args+=(-H "X-CSRF-Token: $CSRF")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "$URL/api/admin$p"
}
agent() { # key method path [json]
  local k="$1" m="$2" p="$3" body="${4:-}"
  local args=(-sS -X "$m" -H "Authorization: Bearer $k" -H 'Content-Type: application/json')
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "$URL/api/agent$p"
}
key() { openssl rand -hex 8; }

step "logging in"
LOGIN=$(curl -sS -c "$JAR" -X POST -H 'Content-Type: application/json' \
  -d "{\"password\":\"$PW\"}" "$URL/api/admin/session")
CSRF=$(echo "$LOGIN" | jq -r '.csrfToken // empty')
[ -n "$CSRF" ] && ok "session established" || bad "login" "a csrf token" "$LOGIN"

step "scenario: introducing two agents that already exist"
ACC=$(admin POST /agents '{"name":"accounting"}')
STR=$(admin POST /agents '{"name":"strategy"}')
ACC_KEY=$(echo "$ACC" | jq -r '.key // empty'); ACC_ID=$(echo "$ACC" | jq -r '.agent.id // empty')
STR_KEY=$(echo "$STR" | jq -r '.key // empty'); STR_ID=$(echo "$STR" | jq -r '.agent.id // empty')
{ [ -n "$ACC_KEY" ] && [ -n "$STR_KEY" ]; } && ok "two agents created, keys shown once" \
  || bad "agent creation" "keys returned" "$ACC / $STR"

SPACE=$(admin POST /spaces '{"name":"money-and-life"}' | jq -r '.id // empty')
admin PUT "/spaces/$SPACE/members/$ACC_ID" >/dev/null
admin PUT "/spaces/$SPACE/members/$STR_ID" >/dev/null
[ -n "$SPACE" ] && ok "space created, both agents added" || bad "space" "an id" "$SPACE"

step "an agent bootstraps knowing only its key"
ID=$(agent "$ACC_KEY" GET /identity)
SEEN=$(echo "$ID" | jq -r '[.spaces[].id] | index("'"$SPACE"'") // "no"')
[ "$SEEN" != "no" ] && ok "identity() reports the new space" || bad "identity" "the space listed" "$ID"
echo "$ID" | jq -e '.limits.maxMessageBytes and .reservedSequence' >/dev/null \
  && ok "limits and reserved sequence reported" || bad "identity" "limits + reserved sequence" "$ID"

step "the human opens the conversation"
admin POST /messages "{\"target\":{\"space\":\"$SPACE\",\"title\":\"2027 budget\"},\"body\":\"You two coordinate. @accounting has the numbers.\",\"idempotencyKey\":\"$(key)\"}" >/dev/null
STREAM=$(agent "$ACC_KEY" GET /stream)
N=$(echo "$STREAM" | jq -r '[.items[] | select(.kind=="message")] | length')
[ "$N" -ge 1 ] && ok "agent sees the human's message ($N items)" || bad "stream" ">=1 message" "$STREAM"
echo "$STREAM" | jq -e '[.items[] | select(.kind=="message") | .sender.kind] | index("human")' >/dev/null \
  && ok "sender is attributed to the human" || bad "sender" "kind=human" "$STREAM"
echo "$STREAM" | jq -e '[.items[] | select(.kind=="message") | .mentions[]] | length > 0' >/dev/null \
  && ok "mention resolved to a reference" || bad "mentions" "a resolved mention" "$STREAM"

step "scenario: appending to your own log without remembering anything"
T="accounting — diary"
A=$(agent "$ACC_KEY" POST /messages "{\"target\":{\"space\":\"$SPACE\",\"title\":\"$T\"},\"body\":\"first entry\",\"idempotencyKey\":\"$(key)\"}")
CONV=$(echo "$A" | jq -r '.conversation.id // empty')
B=$(agent "$ACC_KEY" POST /messages "{\"target\":{\"space\":\"$SPACE\",\"title\":\"$T\"},\"body\":\"second entry\",\"idempotencyKey\":\"$(key)\"}")
CONV2=$(echo "$B" | jq -r '.conversation.id // empty')
{ [ -n "$CONV" ] && [ "$CONV" = "$CONV2" ]; } && ok "same title appends to the same thread" \
  || bad "title addressing" "one thread" "$CONV vs $CONV2"

step "idempotency"
K=$(key)
R1=$(agent "$ACC_KEY" POST /messages "{\"target\":{\"conversation\":\"$CONV\"},\"body\":\"once\",\"idempotencyKey\":\"$K\"}")
R2=$(agent "$ACC_KEY" POST /messages "{\"target\":{\"conversation\":\"$CONV\"},\"body\":\"once\",\"idempotencyKey\":\"$K\"}")
M1=$(echo "$R1" | jq -r '.message.id'); M2=$(echo "$R2" | jq -r '.message.id')
[ "$M1" = "$M2" ] && ok "replayed key returns the original message" || bad "idempotency" "same id" "$M1 vs $M2"
R3=$(agent "$ACC_KEY" POST /messages "{\"target\":{\"conversation\":\"$CONV\"},\"body\":\"DIFFERENT\",\"idempotencyKey\":\"$K\"}")
echo "$R3" | jq -e '.code' >/dev/null && ok "same key, different body is rejected" \
  || bad "idempotency" "an error" "$R3"

step "the reserved sequence is rejected, not stripped"
RS=$(agent "$ACC_KEY" POST /messages "{\"target\":{\"conversation\":\"$CONV\"},\"body\":\"a\\u001eb\",\"idempotencyKey\":\"$(key)\"}")
[ "$(echo "$RS" | jq -r '.code // empty')" = "reserved_sequence" ] && ok "U+001E rejected" \
  || bad "reserved sequence" "code=reserved_sequence" "$RS"

step "isolation: an agent outside the space sees nothing of it"
OUT=$(admin POST /agents '{"name":"outsider"}')
OUT_KEY=$(echo "$OUT" | jq -r '.key')
SPACES=$(agent "$OUT_KEY" GET /identity | jq -r '.spaces | length')
[ "$SPACES" = "0" ] && ok "outsider has no spaces" || bad "isolation" "0 spaces" "$SPACES"
PEEK=$(agent "$OUT_KEY" GET "/spaces/$SPACE/messages")
[ "$(echo "$PEEK" | jq -r '.code // empty')" = "not_found" ] && ok "foreign space reports not_found" \
  || bad "isolation" "not_found" "$PEEK"
PEERS=$(agent "$OUT_KEY" GET /agents | jq -r 'length')
[ "$PEERS" = "0" ] && ok "outsider cannot enumerate agents" || bad "existence isolation" "0 agents" "$PEERS"

step "escalation"
ESC=$(agent "$ACC_KEY" POST /escalations "{\"conversation\":\"$CONV\",\"reason\":\"numbers look wrong\",\"idempotencyKey\":\"$(key)\"}")
INBOX=$(admin GET /escalations | jq -r 'length')
[ "${INBOX:-0}" -ge 1 ] && ok "escalation reaches the human's inbox" || bad "escalation" ">=1" "$INBOX / $ESC"

step "the read log recorded reads, with their parameters"
LOG=$(admin GET "/reads?agent=$ACC_ID")
echo "$LOG" | jq -e 'length > 0' >/dev/null && ok "reads recorded" || bad "read log" ">0 rows" "$LOG"

step "revocation hides the space immediately"
admin DELETE "/spaces/$SPACE/members/$STR_ID" >/dev/null
AFTER=$(agent "$STR_KEY" GET "/spaces/$SPACE/messages")
[ "$(echo "$AFTER" | jq -r '.code // empty')" = "not_found" ] && ok "revoked agent loses the space" \
  || bad "revocation" "not_found" "$AFTER"

echo; echo "$PASS passed, $FAIL failed"; rm -f "$JAR"; [ "$FAIL" -eq 0 ]
