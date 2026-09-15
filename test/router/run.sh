#!/usr/bin/env bash
# End-to-end: one prompt through the real extension, against a 429 -> 503 -> good chain.
# Expect: 3 requests (one per endpoint, in order), answer from good-model, exit 0.
set -euo pipefail
cd "$(dirname "$0")"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$(mktemp -d)}" PI_OFFLINE=1 PI_TELEMETRY=0
export SCOBY_CONFIG="$PWD/scoby.json" MOCK_LOG="$PWD/mock-hits.log"
SESSIONS=$(mktemp -d)
rm -f mock-hits.log
node mock.mjs > mock.out 2>&1 &
MOCK=$!; trap 'kill $MOCK 2>/dev/null' EXIT
until grep -q listening mock.out 2>/dev/null; do :; done

# stdin closed: pi -p otherwise waits for piped input
npx pi -p --session-dir "$SESSIONS" -e ../../extensions/router/index.ts "Reply with exactly: routed" < /dev/null | tee answer.out

echo "--- requests, in order"; cat mock-hits.log
echo "--- router decisions (session entries)"
node -e '
const fs=require("fs"),p=require("path");
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p.join(d,e.name)):[p.join(d,e.name)]);
for (const f of walk(process.argv[1]).filter(f=>f.endsWith(".jsonl")))
  for (const l of fs.readFileSync(f,"utf8").trim().split("\n")) {
    const e=JSON.parse(l); if (e.type==="custom"&&e.customType==="scoby-router") { const {at,...d}=e.data; console.log(JSON.stringify(d)); }
  }' "$SESSIONS"

grep -q "ROUTED-OK served by good-model" answer.out && [ "$(cut -d' ' -f1 mock-hits.log | tr '\n' ' ')" = "ratelimited busy good " ] \
  && echo "PASS" || { echo "FAIL"; exit 1; }
