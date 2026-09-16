#!/usr/bin/env bash
# E2E: the agent claims "done" while a gate shows a new error -> scoby sends the errors back and the
# run continues; once the gate is green the run ends. Expect 2 requests, the 2nd carrying the error.
set -euo pipefail
cd "$(dirname "$0")"
export PI_CODING_AGENT_DIR=$(mktemp -d) PI_OFFLINE=1 PI_TELEMETRY=0 MOCK_LOG="$PWD/requests.jsonl" GATE_STATE=$(mktemp -u)
rm -f requests.jsonl
cat > scoby.json <<JSON
{ "connections": { "agent": { "baseUrl": "http://127.0.0.1:18185/v1", "models": [{ "id": "agent-model" }] } },
  "policy": { "repoContentLeavesMachine": true },
  "roles": { "builder": ["agent/agent-model"] },
  "finish": { "gates": ["node $PWD/gate.mjs"], "maxNudges": 3 } }
JSON
node mock.mjs > mock.out 2>&1 & MOCK=$!; trap 'kill $MOCK 2>/dev/null' EXIT
until grep -q listening mock.out 2>/dev/null; do :; done
SCOBY_CONFIG="$PWD/scoby.json" timeout 60 npx pi -p --no-session -e ../../extensions/scoby/index.ts "Do the thing." < /dev/null > answer.out 2>&1
cat requests.jsonl
[ "$(wc -l < requests.jsonl)" -eq 2 ] && [ "$(sed -n 2p requests.jsonl)" = '{"sawGateErrors":true}' ] && echo PASS || { echo FAIL; exit 1; }
