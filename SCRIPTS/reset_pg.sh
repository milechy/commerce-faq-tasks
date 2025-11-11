#!/usr/bin/env bash
set -e
PGURL='postgres://postgres:pass@127.0.0.1:5434/faq'
psql "$PGURL" -c 'TRUNCATE TABLE docs RESTART IDENTITY;'
"$(dirname "$0")/seed_pg.sh"