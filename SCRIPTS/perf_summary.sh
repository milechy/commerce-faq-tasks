#!/usr/bin/env bash
set -euo pipefail

N="${N:-0}"
shopt -s nullglob || true
files=(logs/perf/*.json)
if [ ${#files[@]} -eq 0 ]; then
  echo "no perf logs under logs/perf"
  exit 1
fi
sorted=$(printf "%s\n" "${files[@]}" | sort)
if [ "$N" -gt 0 ] 2>/dev/null; then
  sorted=$(printf "%s\n" "$sorted" | tail -n "$N")
fi


out="logs/perf/summary.md"
mkdir -p logs/perf
rps_min="${RPS_MIN:-4000}"
p90_max="${P90_MAX:-20}"
last=$(printf "%s\n" "$sorted" | tail -n 1)
read -r last_date last_rps last_p50 last_p90 last_err < <(
  jq -r '[.start, .requests.average, .latency.p50, (.latency.p90 // .latency.p97_5 // 0), .errors] | @tsv' "$last"
)

status_gate="PASS"
awk -v v="$last_rps" -v t="$rps_min" 'BEGIN{exit (v>=t)?0:1}' || status_gate="FAIL"
awk -v v="$last_p90" -v t="$p90_max" 'BEGIN{exit (v<=t)?0:1}' || status_gate="FAIL"
[ "${last_err:-0}" -eq 0 ] || status_gate="FAIL"
{
  echo "**Perf Gate:** ${status_gate}  (RPS_MIN=${rps_min}, P90_MAX=${p90_max}, last=[${last_date} RPS=${last_rps} P90=${last_p90} ERR=${last_err}])"
  echo
  echo "| Date | Status | RPS | P50 | P90 | ERR |"
  echo "|------|:------:|----:|----:|----:|----:|"
  printf "%s\n" "$sorted" \
    | xargs -I{} jq -r \
        '[.start, .requests.average, .latency.p50, (.latency.p90 // .latency.p97_5 // 0), .errors] | @tsv' {} \
    | awk '{
        status = ($2==0 || $5>0) ? "FAIL" : "OK";
        printf "| %s | %s | %.0f | %.0f | %.0f | %d |\n",$1,status,$2,$3,$4,$5
      }'
} > "$out"

echo "✅ Wrote $out"
