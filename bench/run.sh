#!/usr/bin/env bash
# One benchmark run of the Kimchi-trial task (starter stock) on a fresh Brew Buddy clone.
#   bench/run.sh <label> <budget|native>
#     budget  = input-token budget per request (scoby shaping)
#     native  = no scoby compaction (pi's own threshold compaction), same router lineup
# Keys come from env: NVIDIA_API_KEY, GEMINI_API_KEY, GROQ_API_KEY.
set -euo pipefail
LABEL=$1; MODE=$2
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC=${SRC:-$HOME/git/brew-buddy-ferment}
BASE=${BASE:-63fe3b6}
OUT="${BENCH_DIR:-/tmp/claude-1000/bench}/$LABEL"
rm -rf "$OUT"; mkdir -p "$OUT"/{home,agent,sessions}

# fresh workspace: only main's history (no Kimchi branch), no remote, deps linked read-only-ish
git clone -q --no-local --single-branch --branch main "$SRC" "$OUT/repo"
git -C "$OUT/repo" checkout -q -b scoby-bench "$BASE"
git -C "$OUT/repo" remote remove origin
ln -s "$SRC/node_modules" "$OUT/repo/node_modules"
ln -s "$SRC/server/node_modules" "$OUT/repo/server/node_modules"
git -C "$OUT/repo" cat-file -e 1579f74 2>/dev/null && { echo "Kimchi's commit leaked into the clone"; exit 1; }

FERMENT_CFG=""
[ "${FERMENT:-0}" = "1" ] && FERMENT_CFG='"ferment": { "enabled": true },'
COMPACTION=""
[ "$MODE" = "native" ] && COMPACTION='"cancelNativeCompaction": false,'
cat > "$OUT/scoby.json" <<EOF
{
  "connections": {
    "nim": { "baseUrl": "https://integrate.api.nvidia.com/v1", "apiKeyEnv": "NVIDIA_API_KEY", "models": [
      { "id": "deepseek-ai/deepseek-v4-flash-0731", "contextWindow": 128000, "maxTokens": 8192 },
      { "id": "nvidia/nemotron-3-super-120b-a12b", "contextWindow": 128000, "maxTokens": 8192 },
      { "id": "openai/gpt-oss-20b", "contextWindow": 128000, "maxTokens": 8192 } ] },
    "gemini": { "provider": "google" },
    "groq": { "provider": "groq" }
  },
  "policy": { "repoContentLeavesMachine": true },
  "roles": {
    "builder":   ["nim/deepseek-ai/deepseek-v4-flash-0731", "nim/nvidia/nemotron-3-super-120b-a12b"],
    "planner":   ["nim/nvidia/nemotron-3-super-120b-a12b"],
    "compactor": ["nim/nvidia/nemotron-3-super-120b-a12b"],
    "judge":     ["groq/openai/gpt-oss-120b"]
  },
  "defaultRole": "builder",
  "failover": { "cooldownSeconds": 300 },
  ${FERMENT_CFG}
  "compaction": { ${COMPACTION} "recentShare": 0.5 },
  "finish": { "requireChanges": true, "gates": ["npx tsc --noEmit -p tsconfig.app.json", "npx tsc --noEmit -p server/tsconfig.json", "npx vite build --outDir /tmp/claude-1000/bench-vite-$LABEL"], "maxNudges": 3 }
}
EOF

# pi's own retry: hung requests fail over after 2 minutes instead of 5 (r9 lost most of its window to
# 5-minute timeouts), and a few more agent-level retries before a run gives up
cat > "$OUT/agent/settings.json" <<EOF
{ "retry": { "enabled": true, "maxRetries": ${PI_MAX_RETRIES:-4}, "baseDelayMs": ${PI_BASE_DELAY_MS:-2000},
             "provider": { "timeoutMs": ${PI_PROVIDER_TIMEOUT_MS:-120000} } } }
EOF
[ "${SETUP_ONLY:-0}" = "1" ] && { echo "workspace ready: $OUT"; exit 0; }

ARGS=(-p --session-dir "$OUT/sessions" -e "$ROOT/extensions/scoby/index.ts")
if [ "$MODE" = "native" ]; then
	ARGS+=(--budget 10000000) # effectively no shaping; pi's own compaction stays on
else
	ARGS+=(--budget "$MODE")
fi

echo "run $LABEL mode=$MODE -> $OUT"
START=$(date +%s)
set +e
# isolated HOME: no kubeconfig, no git/gh credentials; the agent's bash runs on this host
(cd "$OUT/repo" && env -u KUBECONFIG HOME="$OUT/home" PI_CODING_AGENT_DIR="$OUT/agent" \
	PI_OFFLINE=1 PI_TELEMETRY=0 SCOBY_CONFIG="$OUT/scoby.json" PATH="$PATH" \
	timeout "${RUN_TIMEOUT:-3600}" "$ROOT/node_modules/.bin/pi" "${ARGS[@]}" -- "$(cat "$ROOT/bench/prompt.md")" \
	< /dev/null > "$OUT/answer.md" 2> "$OUT/stderr.log")
EXIT=$?
set -e
echo "$EXIT $(( $(date +%s) - START ))" > "$OUT/exit"
echo "exit=$EXIT after $(( $(date +%s) - START ))s"
node "$ROOT/bench/report.mjs" "$OUT"
