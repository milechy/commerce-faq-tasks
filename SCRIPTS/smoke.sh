#!/usr/bin/env bash
set -e
curl -s http://localhost:3000/health | jq .
echo
jq -n --arg q '返品 送料' '{q:$q}' | curl -s -X POST http://localhost:3000/search -H 'Content-Type: application/json' --data @- | jq .