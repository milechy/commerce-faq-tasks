#!/usr/bin/env bash
set -euo pipefail

f=$(ls -t logs/perf-agent/*.json | head -n 1)
[ -n "$f" ] || { echo '[perf_agent_budget] no perf logs'; exit 1; }

p95=$(jq -r '.latency.p95 // .latency.p90 // 0' "$f")
rps=$(jq -r '.requests.average' "$f")

# initial budgets
P95_MAX=${P95_MAX:-600}
RPS_MIN=${RPS_MIN:-300}

pass=1

awk -v v="$p95" -v t="$P95_MAX" 'BEGIN{exit !(v<=t)}' \
  || { echo "✗ p95 $p95 > $P95_MAX"; pass=0; }

awk -v v="$rps" -v t="$RPS_MIN" 'BEGIN{exit !(v>=t)}' \
  || { echo "✗ RPS $rps < $RPS_MIN"; pass=0; }

if [ $pass -eq 1 ]; then
  echo "✓ PERF AGENT OK: p95=$p95 RPS=$rps"
else
  echo "Perf agent budget failed"
  exit 1
fi