#!/usr/bin/env bash
# E2E: an agent reads 8 big files. Run once without scoby (control) and once with scoby at a
# 6000-token budget. PASS = every scoby request stays within budget (+10% estimate slack),
# while the control grows past it, and the agent still finishes.
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
BUDGET=${BUDGET:-6000}
export PI_OFFLINE=1 PI_TELEMETRY=0 MOCK_PORT=18184 MOCK_TURNS=8
WORK=$(mktemp -d)
for k in $(seq 1 8); do node -e "process.stdout.write(('line '+${k}+' of big file ' ).repeat(300).slice(0,6000))" > "$WORK/big-$k.txt"; done

cat > "$WORK/scoby.json" <<EOF
{
  "connections": { "agent": { "baseUrl": "http://127.0.0.1:18184/v1", "models": [{ "id": "agent-model", "contextWindow": 128000, "maxTokens": 1024 }] } },
  "roles": { "builder": ["agent/agent-model"] },
  "compaction": { "defaultBudget": $BUDGET }
}
EOF

run() { # $1 = label, rest = extra pi args
	local label=$1; shift
	rm -f "$HERE/requests-$label.jsonl"
	MOCK_LOG="$HERE/requests-$label.jsonl" node "$HERE/agent-mock.mjs" > "$HERE/mock-$label.out" 2>&1 &
	local mock=$!
	until grep -q listening "$HERE/mock-$label.out" 2>/dev/null; do :; done
	(cd "$WORK" && PI_CODING_AGENT_DIR=$(mktemp -d) timeout 120 npx --prefix "$HERE/../.." pi -p --session-dir "$HERE/sessions-$label" "$@" \
		"Read big-1.txt through big-8.txt one at a time, then say DONE." < /dev/null > "$HERE/answer-$label.out" 2>&1) || true
	kill $mock 2>/dev/null || true
}

rm -rf "$HERE"/sessions-*
# control: same fake model, registered by a tiny provider-only extension, no scoby
cat > "$WORK/provider-only.ts" <<'EOF'
export default function (pi: any) {
  pi.registerProvider("agent", { baseUrl: "http://127.0.0.1:18184/v1", apiKey: "none", api: "openai-completions",
    models: [{ id: "agent-model", name: "agent-model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }] });
}
EOF
run control -e "$WORK/provider-only.ts" --provider agent --model agent-model
SCOBY_CONFIG="$WORK/scoby.json" run scoby -e "$HERE/../../extensions/scoby/index.ts"

node - "$BUDGET" <<'EOF'
const fs = require("fs");
const budget = Number(process.argv[2]);
const read = (l) => fs.readFileSync(`requests-${l}.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
const tok = (r) => Math.round(r.bodyChars / 3.6);
for (const label of ["control", "scoby"]) {
  const rs = read(label);
  console.log(`${label.padEnd(8)} requests=${rs.length}  tokens/request: ${rs.map(tok).join(" ")}  stubs(last)=${rs.at(-1).stubs}  recall-tool=${rs[0].tools.includes("recall")}`);
}
const c = read("control"), s = read("scoby");
const answer = fs.readFileSync("answer-scoby.out", "utf8");
const checks = {
  "control grows past the budget": tok(c.at(-1)) > budget,
  "every scoby request within budget (+10%)": s.every((r) => tok(r) <= budget * 1.1),
  "scoby stubbed something": s.some((r) => r.stubs > 0),
  "scoby agent finished all turns": s.length === c.length && answer.includes("DONE"),
  "recall tool registered": s[0].tools.includes("recall"),
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "ok  " : "FAIL"} ${k}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
EOF
