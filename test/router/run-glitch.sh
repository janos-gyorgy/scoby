#!/usr/bin/env bash
# E2E: a provider error pi will NOT retry ("list index out of range", as NIM sent mid-run).
# Expect: router fails over AND resumes the run itself -> answer from good-model, exit 0.
set -euo pipefail
cd "$(dirname "$0")"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$(mktemp -d)}" PI_OFFLINE=1 PI_TELEMETRY=0
export SCOBY_CONFIG="$PWD/scoby-glitch.json" MOCK_LOG="$PWD/mock-hits.log"
SESSIONS=$(mktemp -d)
rm -f mock-hits.log
node mock.mjs > mock.out 2>&1 &
MOCK=$!; trap 'kill $MOCK 2>/dev/null' EXIT
until grep -q listening mock.out 2>/dev/null; do :; done
set +e
timeout 60 npx pi -p --session-dir "$SESSIONS" -e ../../extensions/scoby/index.ts "Reply with exactly: routed" < /dev/null > answer.out 2>&1
EXIT=$?
set -e
echo "exit=$EXIT"; cat answer.out
echo "--- requests"; cat mock-hits.log
echo "--- router"
node -e 'const fs=require("fs"),p=require("path");const w=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?w(p.join(d,e.name)):[p.join(d,e.name)]);for(const f of w(process.argv[1]).filter(f=>f.endsWith(".jsonl")))for(const l of fs.readFileSync(f,"utf8").trim().split("\n")){const e=JSON.parse(l);if(e.type==="custom"&&e.customType==="scoby-router"){const{at,...d}=e.data;console.log(JSON.stringify(d))}}' "$SESSIONS"
grep -q "ROUTED-OK served by good-model" answer.out && [ $EXIT -eq 0 ] && echo PASS || { echo FAIL; exit 1; }
