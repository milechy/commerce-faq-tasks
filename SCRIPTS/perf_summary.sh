#!/usr/bin/env bash
set -euo pipefail
N="${N:-0}"
shopt -s nullglob
files=(logs/perf/*.json)
if [ ${#files[@]} -eq 0 ]; then
  echo "no perf logs under logs/perf"
  exit 1
fi
sorted="$(printf "%s\n" "${files[@]}" | sort)"
# N が指定されていれば最後の N 件だけに絞る（新しい N 件）
if [ "$N" -gt 0 ] 2>/dev/null; then
  sorted="$(printf "%s\n" "$sorted" | tail -n "$N")"
fi
out="logs/perf/summary.md"
mkdir -p logs/perf

{
  echo "| Date | RPS | P50 | P90 | ERR |"
  echo "|------|-----:|----:|----:|----:|"
  printf "%s\n" "$sorted" \
  | xargs -I{} jq -r \
      '[.start, .requests.average, .latency.p50, (.latency.p90 // .latency.p97_5 // 0), .errors] | @tsv' {} \
  | awk '{printf "| %s | %.0f | %.0f | %.0f | %d |\n",$1,$2,$3,$4,$5}'
} > "$out"

echo "✅ Wrote $out"
