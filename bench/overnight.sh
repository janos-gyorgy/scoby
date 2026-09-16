#!/usr/bin/env bash
# Overnight sweep: only runs if NIM's Nemotron answers a tool call right now. Keys come from the
# cluster secret, so they are not baked into a systemd unit.
set -uo pipefail
export PATH=$HOME/.local/node22/bin:/usr/local/bin:/usr/bin:/bin
ROOT=$HOME/git/github/scoby-pi
BENCH_DIR=${BENCH_DIR:-/tmp/claude-1000/bench}
mkdir -p "$BENCH_DIR"
LOG="$BENCH_DIR/overnight.log"
exec >> "$LOG" 2>&1
echo "=== overnight $(date -Is)"

key() { kubectl -n scoby get secret scoby-llm-keys -o "jsonpath={.data.$1}" | base64 -d; }
export NVIDIA_API_KEY=$(key nvidia) GEMINI_API_KEY=$(key gemini) GROQ_API_KEY=$(key groq)
[ -n "$NVIDIA_API_KEY" ] || { echo "no keys from cluster secret — aborting"; exit 1; }

for attempt in 1 2 3; do
	if node "$ROOT/bench/preflight.mjs" "${PREFLIGHT_MODEL:-deepseek-ai/deepseek-v4-flash-0731}"; then
		echo "preflight ok (attempt $attempt) — starting sweep"
		SUFFIX=${SUFFIX:-r3} RUN_TIMEOUT=${RUN_TIMEOUT:-3600} BENCH_DIR=$BENCH_DIR "$ROOT/bench/sweep.sh" > "$BENCH_DIR/sweep-${SUFFIX:-r3}.log" 2>&1
		echo "sweep exit=$? $(date -Is)"; tail -5 "$BENCH_DIR/sweep-${SUFFIX:-r3}.log"
		exit 0
	fi
	echo "preflight failed (attempt $attempt)"
	[ $attempt -lt 3 ] && sleep 900
done
echo "NIM still unusable after 3 checks — no sweep. DeepSeek is the fallback (needs a key)."
exit 1
