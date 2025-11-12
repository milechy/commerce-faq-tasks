#!/usr/bin/env bash
set -e
echo "# Doctor"
echo "Node:" $(node -v)
echo "pnpm:" $(pnpm -v)
echo "Docker:" $(docker --version 2>/dev/null || echo none)
echo "jq:" $(jq --version 2>/dev/null || echo none)
echo
echo "# Checking Docker Desktop..."
docker info >/dev/null 2>&1 && echo ok || echo warn
echo "# Checking ES..."
curl -fsS http://localhost:9200 >/dev/null && echo ok || echo warmup
echo "# Checking PG..."
PGPASSWORD=pass psql "postgres://postgres:pass@127.0.0.1:5434/postgres" -tAc 'SELECT 1' >/dev/null 2>&1 && echo ok || echo warmup
echo "# Checking CE deps..."
node -e "try{require('onnxruntime-node');console.log('onnxruntime-node: ok')}catch(e){console.log('onnxruntime-node: missing')}"
echo
echo "# Hints"
echo "- Start stack: pnpm run stack:auto"
echo "- Warmup CE: pnpm run ce:auto"
echo "- All-in-one: pnpm run all:auto"