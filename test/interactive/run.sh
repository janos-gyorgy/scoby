#!/usr/bin/env bash
# E2E of the interactive flow through pi's RPC mode (the same dialogs the TUI shows).
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD; ROOT=$(cd ../.. && pwd)
T=$(mktemp -d); WORK=$T/repo; mkdir -p "$WORK" "$T/agent" "$T/sessions"
(cd "$WORK" && git init -q -b main && git commit -q --allow-empty -m base)
echo '{ "retry": { "enabled": true, "maxRetries": 1, "baseDelayMs": 50, "provider": { "timeoutMs": 5000 } } }' > "$T/agent/settings.json"
cat > "$T/scoby.json" <<JSON
{ "connections": {
    "agent": { "baseUrl": "http://127.0.0.1:18186/agent/v1", "models": [{ "id": "agent-model" }] },
    "planner": { "baseUrl": "http://127.0.0.1:18186/plan/v1", "models": [{ "id": "planner-model" }] },
    "judge": { "baseUrl": "http://127.0.0.1:18186/judge/v1", "models": [{ "id": "judge-model" }] } },
  "policy": { "repoContentLeavesMachine": true },
  "roles": { "builder": ["agent/agent-model"], "planner": ["planner/planner-model"], "judge": ["judge/judge-model"] },
  "failover": { "cooldownSeconds": 1 },
  "notify": { "url": "http://127.0.0.1:18187", "topic": "scoby" },
  "ferment": { "enabled": true, "gates": ["true"], "waitIntervalSeconds": 1, "waitNotifyAfterSeconds": 0 } }
JSON
export MOCK_LOG="$HERE/requests.jsonl" DOWN_FLAG="$T/down"; rm -f "$MOCK_LOG"
node ../ferment/mock.mjs > mock.out 2>&1 & MOCK=$!; trap 'kill $MOCK 2>/dev/null' EXIT
until grep -q listening mock.out 2>/dev/null; do :; done
timeout 240 node driver.mjs "$ROOT" "$WORK" "$T/sessions" "$T/agent" "$DOWN_FLAG"
node - "$T/result.json" <<'NODE'
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const reqs = fs.readFileSync("requests.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const plans = reqs.filter((q) => q.kind === "plan");
const pushTitles = r.pushes.map((p) => `${p.priority}:${p.title}`);
console.log(`${r.seconds}s  branch=${r.branch}  selects=${JSON.stringify(r.seen.selects)}`);
console.log("pushes:", pushTitles.join(" | "));
const checks = {
  "asked 'Plan & build / Just answer' for each request": r.seen.selects.filter((t) => t === "scoby").length === 2,
  "plan shown twice: Change… then Approve": r.seen.selects.filter((t) => t.startsWith("scoby: build this plan")).length === 2 && r.seen.inputs === 1,
  "the revision carried the human's sentence": plans.length === 2 && !plans[0].sawFeedback && plans[1].sawFeedback,
  "plan and progress shown in the panel": r.seen.widgets.some((w) => w.startsWith("scoby — plan")) && r.seen.widgets.some((w) => /\d+\/\d+ steps/.test(w)),
  "built on a scoby/ branch": r.branch.startsWith("scoby/"),
  "the outage happened, scoby waited, and came back by itself": reqs.some((q) => q.kind === "agent-down") && r.seen.widgets.some((w) => w.includes("waiting for models")) && reqs.some((q) => q.kind === "probe"),
  "build finished": r.finished,
  "phone: plan-ready (high) per draft": r.pushes.filter((p) => p.title.startsWith("scoby: plan ready") && p.priority === 4).length === 2,
  "phone: both phase grades, the wait (low), and finished": r.pushes.filter((p) => /— [ABC]$/.test(p.title)).length === 2 && r.pushes.some((p) => p.title.includes("waiting") && p.priority === 2) && r.pushes.some((p) => p.title === "scoby finished"),
  "phone: token sent": r.pushes.every((p) => p.auth === "Bearer test-token"),
  "a later question stayed plain chat (no new plan)": r.chatAnswered && plans.length === 2 && reqs.some((q) => q.kind === "agent" && q.chat && !q.brief),
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "ok  " : "FAIL"} ${k}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
NODE
