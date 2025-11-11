#!/usr/bin/env bash
set -e
for i in {1..60}; do curl -fsS http://localhost:9200 >/dev/null && exit 0; sleep 1; done
echo 'ES not ready' >&2; exit 1