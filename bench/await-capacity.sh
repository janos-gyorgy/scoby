#!/usr/bin/env bash
# Wait for free capacity, then run the sweep once. NIM's free tier is non-stationary: 06:28 healthy,
# 09:34 both builders down. Instead of guessing a window, check every 30 min and take the first green.
set -uo pipefail
export PATH=$HOME/.local/node22/bin:/usr/local/bin:/usr/bin:/bin
ROOT=$HOME/git/github/scoby-pi
BENCH_DIR=${BENCH_DIR:-/tmp/claude-1000/bench}
SUFFIX=${SUFFIX:-r4}
mkdir -p "$BENCH_DIR"
exec >> "$BENCH_DIR/await.log" 2>&1

key() { kubectl -n scoby get secret scoby-llm-keys -o "jsonpath={.data.$1}" | base64 -d; }
export NVIDIA_API_KEY=$(key nvidia) GEMINI_API_KEY=$(key gemini) GROQ_API_KEY=$(key groq)
[ -n "$NVIDIA_API_KEY" ] || { echo "no keys from cluster secret"; exit 1; }

MODELS=${MODELS:-"deepseek-ai/deepseek-v4-flash-0731 nvidia/nemotron-3-super-120b-a12b"}
for attempt in $(seq 1 "${MAX_ATTEMPTS:-24}"); do
	echo "=== attempt $attempt $(date -Is)"
	for m in $MODELS; do
		if node "$ROOT/bench/preflight.mjs" "$m"; then
			echo "capacity back on $m — starting sweep $SUFFIX"
			SUFFIX=$SUFFIX RUN_TIMEOUT=${RUN_TIMEOUT:-5400} BENCH_DIR=$BENCH_DIR "$ROOT/bench/sweep.sh" > "$BENCH_DIR/sweep-$SUFFIX.log" 2>&1
			code=$?
			echo "sweep exit=$code $(date -Is)"
			if [ $code -eq 0 ]; then exit 0; fi
			# an early ABORT means capacity died again mid-sweep: keep waiting for a better window
			grep -q "^ABORT" "$BENCH_DIR/sweep-$SUFFIX.log" || exit $code
			echo "sweep aborted early — back to waiting"
			break
		fi
	done
	sleep "${INTERVAL:-1800}"
done
echo "no capacity after ${MAX_ATTEMPTS:-24} attempts"
exit 1
