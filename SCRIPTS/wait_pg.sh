#!/usr/bin/env bash
set -e
for i in {1..60}; do PGPASSWORD=pass psql 'postgres://postgres:pass@127.0.0.1:5434/postgres' -tAc 'SELECT 1' >/dev/null 2>&1 && exit 0; sleep 1; done
echo 'PG not ready' >&2; exit 1