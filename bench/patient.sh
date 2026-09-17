#!/usr/bin/env bash
# Keep one ferment run going until it ends on its own terms — through provider outages, for days if
# needed. The session file is the state: when capacity is gone the run stops, this waits, then
# continues the SAME session and ferment picks up at the current step.
#   bench/patient.sh <label> <budget>        (status: $BENCH_DIR/<label>/status.json)
set -uo pipefail
LABEL=$1; BUDGET=$2
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH_DIR=${BENCH_DIR:-/tmp/claude-1000/bench}
OUT="$BENCH_DIR/$LABEL"
export PATH=$HOME/.local/node22/bin:/usr/local/bin:/usr/bin:/bin
key() { kubectl -n scoby get secret scoby-llm-keys -o "jsonpath={.data.$1}" | base64 -d; }
: "${NVIDIA_API_KEY:=$(key nvidia)}" "${GEMINI_API_KEY:=$(key gemini)}" "${GROQ_API_KEY:=$(key groq)}"
export NVIDIA_API_KEY GEMINI_API_KEY GROQ_API_KEY

# a prepared workspace is reused as is (that is what makes this resumable)
[ -d "$OUT/repo" ] || FERMENT=1 SETUP_ONLY=1 BENCH_DIR=$BENCH_DIR "$ROOT/bench/run.sh" "$LABEL" "$BUDGET" || exit 1
PROMPT="$(cat "${PROMPT_FILE:-$ROOT/bench/prompt.md}")"
MODELS=${MODELS:-"deepseek-ai/deepseek-v4-flash-0731 nvidia/nemotron-3-super-120b-a12b openai/gpt-oss-20b"}
capacity() {
	if [ -n "${CAPACITY_CMD:-}" ]; then eval "$CAPACITY_CMD"; return; fi
	for m in $MODELS; do node "$ROOT/bench/preflight.mjs" "$m" && return 0; done
	return 1
}
state() { node "$ROOT/bench/ferment-state.mjs" "$OUT"; }
status() { INVOCATION=$invocation node "$ROOT/bench/ferment-state.mjs" "$OUT" "$1"; }

START=$(date +%s); DEADLINE=$((START + ${MAX_DAYS:-5} * 86400)); invocation=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
	case "$(state)" in complete|failed) break ;; esac
	until capacity; do
		status waiting; echo "$(date -Is) no capacity — next check in ${INTERVAL:-1200}s"
		sleep "${INTERVAL:-1200}"
		[ "$(date +%s)" -lt "$DEADLINE" ] || break 2
	done
	invocation=$((invocation + 1)); status running
	SESSION=$(ls -t "$OUT"/sessions/*.jsonl 2>/dev/null | head -1)
	if [ -z "$SESSION" ]; then SARGS=(--session-dir "$OUT/sessions"); P="$PROMPT"
	else SARGS=(--session "$SESSION"); P="Continue the task from where it stopped."; fi
	echo "$(date -Is) invocation $invocation ($([ -z "$SESSION" ] && echo fresh || echo resume)) state=$(state)"
	(cd "$OUT/repo" && env -u KUBECONFIG HOME="$OUT/home" PI_CODING_AGENT_DIR="$OUT/agent" PI_OFFLINE=1 PI_TELEMETRY=0 \
		SCOBY_CONFIG="$OUT/scoby.json" timeout "${RUN_TIMEOUT:-14400}" "$ROOT/node_modules/.bin/pi" -p "${SARGS[@]}" \
		-e "$ROOT/extensions/scoby/index.ts" --budget "$BUDGET" -- "$P" < /dev/null >> "$OUT/answer.md" 2>> "$OUT/stderr.log")
	echo "$(date -Is) invocation $invocation ended (exit $?) state=$(state)"
done

final=$(state)
echo "$([ "$final" = complete ] && echo 0 || echo 1) $(( $(date +%s) - START ))" > "$OUT/exit"
status finished
echo "$(date -Is) finished: ferment=$final after $invocation invocation(s)"
[ "${SKIP_REPORT:-0}" = "1" ] || node "$ROOT/bench/report.mjs" "$OUT" > "$OUT/report.out" 2>&1
[ "${SKIP_JUDGE:-0}" = "1" ] || node "$ROOT/bench/judge.mjs" "$OUT/repo" "${JUDGE_BASE:-63fe3b6}" > "$OUT/judge.json" 2> "$OUT/judge.err"
[ "$final" = complete ]
