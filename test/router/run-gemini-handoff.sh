#!/usr/bin/env bash
# LIVE (needs GEMINI_API_KEY): a non-Gemini model makes a tool call, then goes "overloaded"; the router
# fails over to real Gemini 3.5 Flash, which must accept the foreign, unsigned tool call in history.
# This is exactly how all four runs of the first sweep died.
set -euo pipefail
cd "$(dirname "$0")"
: "${GEMINI_API_KEY:?}"
WORK=$(mktemp -d); echo '{ "name": "brew-buddy" }' > "$WORK/package.json"
export PI_CODING_AGENT_DIR=$(mktemp -d) PI_OFFLINE=1 PI_TELEMETRY=0 MOCK_LOG="$PWD/mock-hits.log"
cat > "$WORK/scoby.json" <<JSON
{ "connections": { "handoff": { "baseUrl": "http://127.0.0.1:18182/handoff/v1", "models": [{ "id": "handoff-model" }] },
                   "gemini": { "provider": "google" } },
  "policy": { "repoContentLeavesMachine": true },
  "roles": { "builder": ["handoff/handoff-model", "gemini/gemini-3.5-flash:low"] } }
JSON
SESSIONS=$(mktemp -d); rm -f mock-hits.log
node mock.mjs > mock.out 2>&1 & MOCK=$!; trap 'kill $MOCK 2>/dev/null' EXIT
until grep -q listening mock.out 2>/dev/null; do :; done
set +e
(cd "$WORK" && SCOBY_CONFIG="$WORK/scoby.json" timeout 180 npx --prefix "$OLDPWD/../.." pi -p --session-dir "$SESSIONS" -e "$OLDPWD/../../extensions/scoby/index.ts" \
  "Read package.json with the read tool and reply with only the project name." < /dev/null > "$OLDPWD/answer.out" 2>&1)
EXIT=$?; set -e
echo "exit=$EXIT"; tail -3 answer.out
node -e 'const fs=require("fs"),p=require("path");const w=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?w(p.join(d,e.name)):[p.join(d,e.name)]);for(const f of w(process.argv[1]).filter(f=>f.endsWith(".jsonl")))for(const l of fs.readFileSync(f,"utf8").trim().split("\n")){const e=JSON.parse(l);if(e.type==="custom"&&e.customType==="scoby-router"){const{at,...d}=e.data;console.log(JSON.stringify(d))}}' "$SESSIONS"
[ $EXIT -eq 0 ] && grep -qi "brew-buddy" answer.out && echo PASS || { echo FAIL; exit 1; }
