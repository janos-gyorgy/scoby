#!/usr/bin/env bash
# The budget sweep: same task, same lineup, one run per budget, sequential (free tiers).
# Writes bench/<label>/report.json and judge.json for each run, plus a judged Kimchi reference.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH_DIR=${BENCH_DIR:-/tmp/claude-1000/bench}
SUFFIX=${SUFFIX:-r1}
: "${NVIDIA_API_KEY:?}" "${GEMINI_API_KEY:?}" "${GROQ_API_KEY:?}"

for spec in "unbounded:native" "b64k:64000" "b32k:32000" "b16k:16000"; do
	label="${spec%%:*}-$SUFFIX"; mode="${spec##*:}"
	echo "=== $label ($mode) $(date +%T)"
	BENCH_DIR=$BENCH_DIR "$ROOT/bench/run.sh" "$label" "$mode" > "$BENCH_DIR/$label.log" 2>&1
	# a run that errors out within 3 minutes means something systemic (sweep r1: all four died the same
	# way in under 75s) — stop instead of burning the remaining arms
	read -r code secs < "$BENCH_DIR/$label/exit"
	if [ "$code" != "0" ] && [ "$secs" -lt 180 ]; then
		echo "ABORT: $label exited $code after ${secs}s"; tail -3 "$BENCH_DIR/$label/stderr.log"; exit 1
	fi
	node "$ROOT/bench/judge.mjs" "$BENCH_DIR/$label/repo" 63fe3b6 > "$BENCH_DIR/$label/judge.json" 2> "$BENCH_DIR/$label/judge.err"
	node -e 'const r=require(process.argv[1]+"/report.json");let j={};try{j=require(process.argv[1]+"/judge.json")}catch{};console.log(JSON.stringify({label:r.label,exit:r.exitCode,min:r.minutes,requests:r.requests,models:r.models,input:r.inputTokens,folds:r.folds,stubbed:r.shaping.stubbed,dropped:r.shaping.dropped,recalls:r.recalls,gates:r.gates,grade:j.grade,loop:j.starter_batch_consumes_starter,leadTime:j.lead_time_warning}))' "$BENCH_DIR/$label"
done

# Kimchi's July Ferment result, graded by the same judge
KIMCHI="$BENCH_DIR/kimchi-ferment"; mkdir -p "$KIMCHI"
node "$ROOT/bench/judge.mjs" "$HOME/git/brew-buddy-ferment" 63fe3b6 1579f74 > "$KIMCHI/judge.json" 2> "$KIMCHI/judge.err"
echo "=== kimchi reference"; cat "$KIMCHI/judge.json"
