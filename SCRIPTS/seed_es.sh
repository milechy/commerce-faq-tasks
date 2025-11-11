#!/usr/bin/env bash
set -e
curl -s -X PUT localhost:9200/docs >/dev/null || true
curl -s -X PUT localhost:9200/docs/_doc/1 -H 'Content-Type: application/json' -d '{"text":"配送と返品 送料 のガイド：セール品は対象外の場合があります。"}' >/dev/null
curl -s -X PUT localhost:9200/docs/_doc/2 -H 'Content-Type: application/json' -d '{"text":"【FAQ】返品 送料 の基本ポリシー：条件次第で当社負担になります。"}' >/dev/null
curl -s -X PUT localhost:9200/docs/_doc/3 -H 'Content-Type: application/json' -d '{"text":"返金手続きの流れ。交換時の 送料 と期間について。"}' >/dev/null
curl -s -X POST localhost:9200/docs/_refresh >/dev/null
echo 'ES seeded'