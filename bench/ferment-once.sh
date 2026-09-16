#!/usr/bin/env bash
# One ferment run + judge, as a unit that survives the Claude session. Usage: ferment-once.sh <label> <budget>
set -uo pipefail
export PATH=$HOME/.local/node22/bin:/usr/local/bin:/usr/bin:/bin
ROOT=$HOME/git/github/scoby-pi; BENCH_DIR=${BENCH_DIR:-/tmp/claude-1000/bench}; LABEL=$1; BUDGET=$2
key() { kubectl -n scoby get secret scoby-llm-keys -o "jsonpath={.data.$1}" | base64 -d; }
export NVIDIA_API_KEY=$(key nvidia) GEMINI_API_KEY=$(key gemini) GROQ_API_KEY=$(key groq)
node "$ROOT/bench/preflight.mjs" || { echo "no capacity"; exit 1; }
FERMENT=1 RUN_TIMEOUT=${RUN_TIMEOUT:-5400} BENCH_DIR=$BENCH_DIR "$ROOT/bench/run.sh" "$LABEL" "$BUDGET" > "$BENCH_DIR/$LABEL.log" 2>&1
node "$ROOT/bench/judge.mjs" "$BENCH_DIR/$LABEL/repo" 63fe3b6 > "$BENCH_DIR/$LABEL/judge.json" 2> "$BENCH_DIR/$LABEL/judge.err"
echo "done $(date -Is)"
