#!/usr/bin/env bash
set -euo pipefail

# ビルド
pnpm run build

# サーバ起動 → ヘルスチェックOKで → ベンチ → ゲート判定
npx start-server-and-test \
  "PORT=3000 LOG_LEVEL=error PERF_MODE=1 pnpm run start:prod" \
  http://127.0.0.1:3000/health \
  "BODYFILE=\$(mktemp); trap 'rm -f \"\$BODYFILE\"' EXIT; printf '%s' '{}' > \"\$BODYFILE\"; \
   mkdir -p logs/perf; \
   npx autocannon -j -d 25 -c 6 -p 10 -H 'x-perf: 1' \
     -m POST -H 'Content-Type: application/json' -i \"\$BODYFILE\" \
     http://127.0.0.1:3000/search.v1 \
     > logs/perf/\$(date +%Y%m%d-%H%M%S)-ci.json; \
   RPS_MIN=6000 P90_MAX=14 pnpm run perf:budget"
