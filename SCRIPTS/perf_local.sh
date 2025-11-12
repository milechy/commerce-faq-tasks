#!/usr/bin/env bash
set -e
mkdir -p logs/perf
BODY=$(jq -nc --arg q '返品 送料' '{q:$q}')
npx autocannon -j -d 10 -c 10 -p 4 --renderStatusCodes -m POST -H 'Content-Type: application/json' -b "$BODY" http://localhost:3000/search \
  | tee "logs/perf/$(date +%Y%m%d-%H%M%S).json"