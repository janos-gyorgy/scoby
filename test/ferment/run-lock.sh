#!/usr/bin/env bash
# E2E: one build per repo. A repo whose lock names another session's run in progress refuses a new
# build before the planner is ever called; the owner's own session resumes normally; a finished run
# leaves no lock behind.
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
export PI_CODING_AGENT_DIR=$(mktemp -d) PI_OFFLINE=1 PI_TELEMETRY=0 MOCK_LOG="$HERE/requests-lock.jsonl"
WORK=$(mktemp -d); (cd "$WORK" && git init -q && git commit -q --allow-empty -m base)
rm -f "$MOCK_LOG"
cat > "$WORK/scoby.json" <<JSON
{ "connections": {
    "agent": { "baseUrl": "http://127.0.0.1:18186/agent/v1", "models": [{ "id": "agent-model" }] },
    "planner": { "baseUrl": "http://127.0.0.1:18186/plan/v1", "models": [{ "id": "planner-model" }] },
    "judge": { "baseUrl": "http://127.0.0.1:18186/judge/v1", "models": [{ "id": "judge-model" }] } },
  "policy": { "repoContentLeavesMachine": true },
  "roles": { "builder": ["agent/agent-model"], "planner": ["planner/planner-model"], "judge": ["judge/judge-model"] },
  "ferment": { "enabled": true, "gates": ["true"] } }
JSON
SESSIONS=$(mktemp -d)
node mock.mjs > mock-lock.out 2>&1 & MOCK=$!; trap 'kill $MOCK 2>/dev/null' EXIT
until grep -q listening mock-lock.out 2>/dev/null; do :; done
PI="npx --prefix $HERE/../.. pi"
run() { (cd "$WORK" && SCOBY_CONFIG="$WORK/scoby.json" timeout 120 $PI -p "$@" -e "$HERE/../../extensions/scoby/index.ts" < /dev/null); }

# 1. another session's interrupted build holds the lock
mkdir -p "$WORK/.scoby"
cat > "$WORK/.scoby/lock.json" <<JSON
{ "sessionFile": "/elsewhere/other-session.jsonl", "pid": 4194399, "goal": "the other build", "startedAt": "2026-09-17T16:38:00Z", "updatedAt": "2026-09-17T20:04:57Z", "step": "step-2.3" }
JSON
run --session-dir "$SESSIONS" "Track how much starter I have and warn me before it runs out." > answer-lock-1.out 2> stderr-lock-1.out || true
PLANS=$(grep -c '"kind":"plan"' "$MOCK_LOG" 2>/dev/null || echo 0)
ok1=1; grep -q "already in progress" stderr-lock-1.out && [ "$PLANS" = 0 ] && [ -f "$WORK/.scoby/lock.json" ] && ok1=0
echo "$([ $ok1 = 0 ] && echo 'ok  ' || echo FAIL) refused before planning: planner calls=$PLANS, lock kept, message on stderr"
grep -q "scoby --session /elsewhere/other-session.jsonl" stderr-lock-1.out && echo "ok   the message names the owning session" || { echo "FAIL message lacks the resume command"; ok1=1; }

# 2. the lock dropped: the same repo builds to completion and ends unlocked
rm "$WORK/.scoby/lock.json"; rm -f "$MOCK_LOG"
run --session-dir "$SESSIONS" "Track how much starter I have and warn me before it runs out." > answer-lock-2.out 2> stderr-lock-2.out || true
LAST=$(ls -t "$SESSIONS"/*.jsonl | head -1)
FINAL=$(grep -o '"customType":"scoby-ferment","data":{"type":"[a-z_]*"' "$LAST" | tail -1 | sed 's/.*"type":"//;s/"//')
ok2=1; [ "$FINAL" = completed ] && [ ! -f "$WORK/.scoby/lock.json" ] && ok2=0
echo "$([ $ok2 = 0 ] && echo 'ok  ' || echo FAIL) unlocked repo builds to the end (last event: $FINAL) and leaves no lock"
git -C "$WORK" status --porcelain | grep -q "\.scoby/" && { echo "FAIL .scoby shows up in git status"; ok2=1; } || echo "ok   .scoby stays out of git status"

exit $((ok1 + ok2))
