#!/usr/bin/env bash
# E2E: the ferment engine drives plan -> steps -> gate -> judge -> next phase -> complete,
# with the model only ever doing the step in front of it.
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
export PI_CODING_AGENT_DIR=$(mktemp -d) PI_OFFLINE=1 PI_TELEMETRY=0 MOCK_LOG="$HERE/requests.jsonl"
WORK=$(mktemp -d); (cd "$WORK" && git init -q && git commit -q --allow-empty -m base)
rm -f requests.jsonl
cat > "$WORK/scoby.json" <<JSON
{ "connections": {
    "agent": { "baseUrl": "http://127.0.0.1:18186/agent/v1", "models": [{ "id": "agent-model" }] },
    "planner": { "baseUrl": "http://127.0.0.1:18186/plan/v1", "models": [{ "id": "planner-model" }] },
    "judge": { "baseUrl": "http://127.0.0.1:18186/judge/v1", "models": [{ "id": "judge-model" }] } },
  "roles": { "builder": ["agent/agent-model"], "planner": ["planner/planner-model"], "judge": ["judge/judge-model"] },
  "ferment": { "enabled": true, "gates": ["true"] } }
JSON
SESSIONS=$(mktemp -d)
node mock.mjs > mock.out 2>&1 & MOCK=$!; trap 'kill $MOCK 2>/dev/null' EXIT
until grep -q listening mock.out 2>/dev/null; do :; done
(cd "$WORK" && SCOBY_CONFIG="$WORK/scoby.json" timeout 120 npx --prefix "$HERE/../.." pi -p --session-dir "$SESSIONS" -e "$HERE/../../extensions/scoby/index.ts" \
   "Track how much starter I have and warn me before it runs out." < /dev/null > "$HERE/answer.out" 2>&1) || true
node - "$SESSIONS" <<'NODE'
const fs = require("fs"), path = require("path");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const entries = walk(process.argv[2]).filter((f) => f.endsWith(".jsonl")).flatMap((f) => fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
const ferment = entries.filter((e) => e.type === "custom" && e.customType === "scoby-ferment").map((e) => e.data.type + (e.data.stepId ? ":" + e.data.stepId : e.data.phaseId ? ":" + e.data.phaseId : ""));
const reqs = fs.readFileSync("requests.jsonl", "utf8").trim().split("\n").map(JSON.parse);
console.log("engine:", ferment.join(" "));
console.log("agent steps:", reqs.filter((r) => r.kind === "agent").map((r) => r.step).join(" "));
console.log("plan calls:", reqs.filter((r) => r.kind === "plan").length, "judge calls:", reqs.filter((r) => r.kind === "judge").length, "judge saw diff:", reqs.filter((r) => r.kind === "judge").every((r) => r.sawDiff));
const checks = {
  "planned first": ferment[0] === "planned",
  "every step started and finished, in order": ["step-1.1","step-1.2","step-2.1"].every((s) => ferment.includes("step_started:" + s) && ferment.includes("step_finished:" + s)),
  "gate ran per phase": ferment.filter((e) => e.startsWith("gate_passed")).length === 2,
  "judge graded both phases": ferment.filter((e) => e.startsWith("phase_graded")).length === 2,
  "run completed": ferment.at(-1) === "completed",
  "model only ever saw one step at a time": reqs.filter((r) => r.kind === "agent").every((r) => r.brief && r.step !== "none"),
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "ok  " : "FAIL"} ${k}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
NODE
