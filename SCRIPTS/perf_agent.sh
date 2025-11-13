#!/usr/bin/env bash
set -euo pipefail

BODY='{"q":"返品したい場合の送料について教えて","debug":false}'
URL="http://localhost:3000/agent.search"
OUT_DIR="logs/perf-agent"
mkdir -p "$OUT_DIR"

echo "[perf_agent] running autocannon..."
TS=$(date +%Y%m%d-%H%M%S)

autocannon -j \
  -d 15 \
  -c 20 \
  -p 2 \
  -m POST \
  -H "Content-Type: application/json" \
  -b "$BODY" \
  "$URL" \
  | tee "$OUT_DIR/${TS}-agent.json"