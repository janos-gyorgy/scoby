#!/usr/bin/env bash
# E2E for the patient supervisor: the builder is DOWN during the first invocation (planning works,
# every agent turn gets 503), the supervisor waits, capacity "returns", and the second invocation
# must continue the SAME session to completion — no re-planning, no double-counted step start.
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD; ROOT=$(cd ../.. && pwd)
export BENCH_DIR=$(mktemp -d) LABEL=patient-test
OUT=$BENCH_DIR/$LABEL; mkdir -p "$OUT"/{home,agent,sessions}
(git init -q "$OUT/repo" && cd "$OUT/repo" && git commit -q --allow-empty -m base)
cat > "$OUT/scoby.json" <<JSON
{ "connections": {
    "agent": { "baseUrl": "http://127.0.0.1:18186/agent/v1", "models": [{ "id": "agent-model" }] },
    "planner": { "baseUrl": "http://127.0.0.1:18186/plan/v1", "models": [{ "id": "planner-model" }] },
    "judge": { "baseUrl": "http://127.0.0.1:18186/judge/v1", "models": [{ "id": "judge-model" }] } },
  "policy": { "repoContentLeavesMachine": true },
  "roles": { "builder": ["agent/agent-model"], "planner": ["planner/planner-model"], "judge": ["judge/judge-model"] },
  "failover": { "cooldownSeconds": 1 },
  "ferment": { "enabled": true, "gates": ["true"] } }
JSON
echo '{ "retry": { "enabled": true, "maxRetries": 1, "baseDelayMs": 50, "provider": { "timeoutMs": 5000 } } }' > "$OUT/agent/settings.json"
echo "Track how much starter I have and warn me before it runs out." > "$OUT/prompt.md"

export DOWN_FLAG="$OUT/down" MOCK_LOG="$HERE/requests-patient.jsonl"; touch "$DOWN_FLAG"; rm -f "$MOCK_LOG"
# capacity: check 1 says yes (so invocation 1 runs into the outage), check 2 says no and ends the
# outage, check 3 says yes
COUNTER="$OUT/checks"; echo 0 > "$COUNTER"
CAPACITY_CMD='n=$(( $(cat '"$COUNTER"') + 1 )); echo $n > '"$COUNTER"'; if [ $n -eq 2 ]; then rm -f '"$DOWN_FLAG"'; false; else true; fi'
node mock.mjs > mock.out 2>&1 & MOCK=$!; trap 'kill $MOCK 2>/dev/null' EXIT
until grep -q listening mock.out 2>/dev/null; do :; done

NVIDIA_API_KEY=x GEMINI_API_KEY=x GROQ_API_KEY=x CAPACITY_CMD="$CAPACITY_CMD" INTERVAL=1 SKIP_REPORT=1 SKIP_JUDGE=1 \
	PROMPT_FILE="$OUT/prompt.md" timeout 240 "$ROOT/bench/patient.sh" "$LABEL" 32000 > supervisor.out 2>&1 || true
grep -E "invocation|finished|no capacity" supervisor.out | sed 's/^[^ ]* //'
cat "$OUT/status.json"
node - "$OUT" <<'NODE'
const fs = require("fs");
const out = process.argv[2];
const reqs = fs.readFileSync("requests-patient.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const status = JSON.parse(fs.readFileSync(`${out}/status.json`, "utf8"));
const session = fs.readdirSync(`${out}/sessions`).filter((f) => f.endsWith(".jsonl"));
const ev = fs.readFileSync(`${out}/sessions/${session[0]}`, "utf8").trim().split("\n").map(JSON.parse)
  .filter((e) => e.type === "custom" && e.customType === "scoby-ferment").map((e) => e.data.type + (e.data.stepId ? ":" + e.data.stepId : ""));
const checks = {
  "the outage really happened": reqs.some((r) => r.kind === "agent-down"),
  "planned exactly once, across both invocations": reqs.filter((r) => r.kind === "plan").length === 1 && ev.filter((e) => e === "planned").length === 1,
  "one session, continued (not a new one)": session.length === 1,
  "the running step was not re-counted on resume": ev.filter((e) => e === "step_started:step-1.1").length === 1,
  "two invocations, ferment complete": status.invocations === 2 && status.ferment === "complete" && status.supervisor === "finished",
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "ok  " : "FAIL"} ${k}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
NODE
