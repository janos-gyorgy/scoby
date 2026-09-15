#!/usr/bin/env bash
# Failover probe. Needs Node >= 22.19 (pi's engine requirement).
#   ./run.sh                       -> mock flaky (429) -> mock good   (deterministic, no keys)
#   TARGET=groq/openai/gpt-oss-120b ./run.sh          (needs GROQ_API_KEY)
#   TARGET=google/gemini-3.5-flash THINKING=low ./run.sh   (needs GEMINI_API_KEY)
set -euo pipefail
cd "$(dirname "$0")"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$(mktemp -d)}" PI_OFFLINE=1 PI_TELEMETRY=0
rm -f probe.log mock-hits.log
node mock.mjs > mock.out 2>&1 &
MOCK=$!; trap 'kill $MOCK 2>/dev/null' EXIT
until grep -q listening mock.out 2>/dev/null; do :; done
# stdin must be closed: pi -p reads piped stdin and otherwise waits forever
FAILOVER_MODE=msgend FAILOVER_TARGET="${TARGET:-good/good-model}" FAILOVER_THINKING="${THINKING:-}" \
  npx pi -p --no-session -e ./failover.ts --provider flaky --model flaky-model "Reply with exactly: failover ok" < /dev/null
echo "--- mock hits";  cat mock-hits.log
echo "--- probe";      cat probe.log
