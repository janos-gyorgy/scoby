#!/usr/bin/env bash
# E2E for the planner call itself (ferment-32k-r6 lost its whole run to one "overloaded"):
#   A) planner chain [busy, good] -> plans on the second target, run completes
#   B) planner chain [busy only]  -> run stops before any agent turn (no silent fallback)
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
export PI_OFFLINE=1 PI_TELEMETRY=0 SCOBY_BACKOFF_SCALE=0.01
node mock.mjs > mock.out 2>&1 & MOCK=$!; trap 'kill $MOCK 2>/dev/null' EXIT
until grep -q listening mock.out 2>/dev/null; do :; done
scenario() { # $1 label, $2 planner chain json
	local label=$1 chain=$2 work sessions
	work=$(mktemp -d); sessions=$(mktemp -d); (cd "$work" && git init -q && git commit -q --allow-empty -m base)
	cat > "$work/scoby.json" <<JSON
{ "connections": {
    "agent": { "baseUrl": "http://127.0.0.1:18186/agent/v1", "models": [{ "id": "agent-model" }] },
    "busy": { "baseUrl": "http://127.0.0.1:18186/plan-busy/v1", "models": [{ "id": "busy-model" }] },
    "planner": { "baseUrl": "http://127.0.0.1:18186/plan/v1", "models": [{ "id": "planner-model" }] },
    "chatty": { "baseUrl": "http://127.0.0.1:18186/plan-chatty/v1", "models": [{ "id": "chatty-model" }] },
    "judge": { "baseUrl": "http://127.0.0.1:18186/judge/v1", "models": [{ "id": "judge-model" }] } },
  "policy": { "repoContentLeavesMachine": true },
  "roles": { "builder": ["agent/agent-model"], "planner": $chain, "judge": ["judge/judge-model"] },
  "ferment": { "enabled": true, "gates": ["true"] } }
JSON
	rm -f "$HERE/requests-$label.jsonl"
	(cd "$work" && MOCK_LOG="$HERE/requests-$label.jsonl" PI_CODING_AGENT_DIR=$(mktemp -d) SCOBY_CONFIG="$work/scoby.json" timeout 120 \
		npx --prefix "$HERE/../.." pi -p --session-dir "$sessions" -e "$HERE/../../extensions/scoby/index.ts" \
		"Track how much starter I have and warn me before it runs out." < /dev/null > "$HERE/answer-$label.out" 2>&1) || true
	node -e '
const fs=require("fs"),p=require("path");const w=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?w(p.join(d,e.name)):[p.join(d,e.name)]);
const ev=w(process.argv[1]).filter(f=>f.endsWith(".jsonl")).flatMap(f=>fs.readFileSync(f,"utf8").trim().split("\n").map(JSON.parse)).filter(e=>e.type==="custom"&&e.customType.startsWith("scoby-ferment")).map(e=>e.data.type||e.data.event);
console.log(process.argv[2]+": "+ev.join(" "));' "$sessions" "$label"
}
# the mock logs to $MOCK_LOG set at start; restart it per scenario so each gets its own log
kill $MOCK; MOCK_LOG="$HERE/requests-A.jsonl" node mock.mjs > mock.out 2>&1 & MOCK=$!; until grep -q listening mock.out 2>/dev/null; do :; done
scenario A '["busy/busy-model", "planner/planner-model"]'
kill $MOCK; sleep 0.2 2>/dev/null || true; : > mock.out; MOCK_LOG="$HERE/requests-B.jsonl" node mock.mjs > mock.out 2>&1 & MOCK=$!; until grep -q listening mock.out 2>/dev/null; do :; done
scenario B '["busy/busy-model"]'
kill $MOCK; : > mock.out; MOCK_LOG="$HERE/requests-C.jsonl" node mock.mjs > mock.out 2>&1 & MOCK=$!; until grep -q listening mock.out 2>/dev/null; do :; done
scenario C '["chatty/chatty-model"]'
node - <<'NODE'
const fs = require("fs");
const read = (l) => fs.readFileSync(`requests-${l}.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const A = read("A"), B = read("B"), C = read("C");
const checks = {
  "A: busy planner tried, then the good one planned": A.some((r) => r.kind === "plan-busy") && A.some((r) => r.kind === "plan" && r.sawGoal),
  "A: the run went on to do steps": A.filter((r) => r.kind === "agent").length >= 2,
  "B: planner retried before giving up": B.filter((r) => r.kind === "plan-busy").length >= 3,
  "B: no agent turn at all (no silent fallback)": !B.some((r) => r.kind === "agent"),
  "C: a prose reply is re-asked with a JSON-only reminder, then the run proceeds": C.some((r) => r.kind === "plan-chatty" && !r.reminded) && C.some((r) => r.kind === "plan-chatty" && r.reminded) && C.filter((r) => r.kind === "agent").length >= 2,
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "ok  " : "FAIL"} ${k}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
NODE
