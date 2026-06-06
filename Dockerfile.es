# 本番 ES — kuromoji 焼き込みイメージ
# バージョンは実機 es-commfaq に固定 (8.15.0)
# 参照: docs/ES_PROD_DURABILITY.md §3.1
FROM docker.elastic.co/elasticsearch/elasticsearch:8.15.0
RUN bin/elasticsearch-plugin install --batch analysis-kuromoji
