# 本番 Elasticsearch 耐久化 — kuromoji 焼き込み + データ永続化 + 再発防止

**作成:** 2026-06-06 / 24h 自走調査
**対象:** VPS 本番 ES コンテナ `es-commfaq`（`docker.elastic.co/elasticsearch/elasticsearch:8.15.0`、port 9200、single-node、security 無効）
**きっかけ:** kuromoji 導入タスク (GID 1215263804996770) 実施中に `faq_*` インデックスが全消失（`read_me` のみ）していたのを発見し、再 sync で carnation:63 / demo:2 を復旧した。

---

## 1. 調査結論（根本原因）

| 観測 | 事実 |
|---|---|
| `docker inspect es-commfaq --format '{{json .Mounts}}'` | **`[]`** = **永続 volume / bind mount が一切無い** |
| `RestartPolicy` | **`no`**（VPS 再起動・クラッシュ時に自動復帰しない） |
| `Created` | 2025-11-21（同一コンテナを再作成せず運用、`docker restart` のみ） |
| index 削除経路（repo 全走査） | `SCRIPTS/sync-es.ts` の `syncTenant()` が **DELETE→CREATE→bulk の順**（`deleteIndex` L94 / L225）。これ以外に `faq_<tenant>` を消す経路は無し |
| `SCRIPTS/deploy-vps.sh` | ES に一切触れない（デプロイは無実） |
| 関連移行 | #247 (c6a6054) Phase69-2-E で write index を `faq_${tenantId}` に統一。移行後は populate sync が必須 |
| 既往 | cerebrum に 2026-05-31 の同種消失→再 sync 復旧（carnation 63/demo 2）記録あり＝**再発** |

### 何が起きたか

- **今日の `docker restart` は無実**: `docker restart` は同一コンテナの stop+start で writable layer を保持する。データ消失は起こさない。
- index は**今日より前に ES API 経由で DELETE** された。最有力は **`sync-es.ts --all` が DELETE 後に CREATE/populate を完了できず中断**したケース（プロセス kill / ES 一時エラー / kuromoji 不在での fallback 失敗等）。`syncTenant` は delete-first のため、途中失敗で index が「消えたまま」になる。

### 構造的な時限爆弾（最重要）

**永続 volume が無いため、コンテナを一度でも再作成（`docker rm` → `docker run` / `docker compose up` での置換）または VPS 再起動後に手動再作成すると、FAQ インデックスが恒久消失する。** `RestartPolicy=no` で自動復帰もしない。kuromoji プラグインも writable layer 上にあるため同様に消える。

---

## 2. 耐久化の方針（3点セット）

| # | 対策 | 解決する問題 |
|---|---|---|
| A | **data 永続 volume 化** | 再作成・再起動でのインデックス恒久消失を防ぐ |
| B | **kuromoji 焼き込みイメージ** | `docker exec` 導入の plugin が再作成で消えるのを防ぐ |
| C | **`restart: unless-stopped`** | VPS 再起動・クラッシュ時の自動復帰 |

> 補足: 現状 plugin は `docker exec ... install` で導入済みのため**今すぐ消えるわけではない**（restart では保持）。本手順は「次に再作成が必要になったとき/再起動耐性を持たせたいとき」の恒久化。緊急ではないが、時限爆弾の解除として早期実施を推奨。

---

## 3. 成果物

### 3.1 `Dockerfile.es`（kuromoji 焼き込み）

```dockerfile
# 本番 ES のバージョンに固定（実機 es-commfaq = 8.15.0）
FROM docker.elastic.co/elasticsearch/elasticsearch:8.15.0
RUN bin/elasticsearch-plugin install --batch analysis-kuromoji
```

### 3.2 `docker-compose.prod-es.yml`（data 永続 + restart + 焼き込みイメージ）

```yaml
# VPS 本番 ES 専用。既存 es-commfaq を置き換える。
services:
  es-commfaq:
    build:
      context: .
      dockerfile: Dockerfile.es
    image: es-commfaq-kuromoji:8.15.0
    container_name: es-commfaq
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false      # 現行 es-commfaq に合わせる（localhost:9200 無認証で稼働中）
      - ES_JAVA_OPTS=-Xms2g -Xmx2g         # 実機メモリに合わせて調整
    ports:
      - "9200:9200"
    restart: unless-stopped                # ← VPS 再起動・クラッシュ時に自動復帰
    volumes:
      - esdata:/usr/share/elasticsearch/data   # ← データ永続化（最重要）

volumes:
  esdata:
```

---

## 4. 安全な cutover 手順（VPS 手作業 — hkobayashi 実行）

⚠️ **現コンテナを置き換えると揮発層のデータは失われる**が、`faq_docs`(DB) が source-of-truth なので **再 sync で完全復元できる**（実証済: carnation 63 / demo 2）。

```bash
# 0. 現状の件数を控える（復元突合用）
curl -s "localhost:9200/_cat/indices/faq_*?h=index,docs.count"

# 1. 上記 Dockerfile.es / docker-compose.prod-es.yml を VPS 上の作業ディレクトリに配置
#    （例: /opt/rajiuce-infra/es/）。Dockerfile.es と同じ階層で compose を置く。

# 2. 焼き込みイメージをビルド
cd /opt/rajiuce-infra/es
docker compose -f docker-compose.prod-es.yml build

# 3. 旧コンテナを停止・削除（揮発データはここで失われる→手順5で復元）
docker stop es-commfaq && docker rm es-commfaq

# 4. 永続 volume 付きの新コンテナを起動
docker compose -f docker-compose.prod-es.yml up -d

# 5. ES 復帰待ち → kuromoji 焼き込み確認
until curl -s localhost:9200/_cluster/health >/dev/null 2>&1; do sleep 5; done
curl -s localhost:9200/_cat/plugins        # analysis-kuromoji が出ること

# 6. DB から全テナント再 sync（永続 volume 上に kuromoji index を再構築）
cd /opt/rajiuce
DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-) \
  ES_URL=http://localhost:9200 \
  node_modules/.bin/ts-node SCRIPTS/sync-es.ts --all
#    → "created (analyzer: kuromoji)" を確認

# 7. 検証（件数 + 形態素解析 + 永続性）
curl -s -XPOST "localhost:9200/faq_carnation/_refresh" >/dev/null
curl -s "localhost:9200/_cat/indices/faq_*?v&h=index,docs.count"     # carnation 63 / demo 2
docker restart es-commfaq && sleep 20
curl -s "localhost:9200/_cat/indices/faq_*?v&h=index,docs.count"     # ← 再起動後も件数が残れば永続化成功
```

> ⚠️ `.env` を `source` しないこと。プレースホルダ行（`FAL_KEY=<...>`）で構文が崩壊し**秘密鍵が echo 漏洩**する（2026-06-06 に OpenAI キー露出事故）。上記のように**必要な変数だけ `grep` で抽出**する。

---

## 5. 再発防止（コード側フォローアップ — 別タスク候補）

1. **`sync-es.ts` を delete-first から alias swap 方式へ**
   - 現状: `DELETE faq_<tenant>` → `CREATE` → bulk。中断で index 消失。
   - 改善: `faq_<tenant>_<timestamp>` に新規作成 → bulk 完了後に alias `faq_<tenant>` を atomic に張り替え → 旧 index 削除。**失敗しても現行 index が生き残る**。
2. **デプロイ後 sync の自動化 + 健全性監視**
   - `faq_<tenant>` の docs.count を定期チェックし、0 件 / index 不在を検知したら Slack 通知（消失の早期検出）。`#247` 教訓「merge→deploy→sync の順序厳守」をスクリプト化。
3. **`.env` 衛生**: `FAL_KEY=<your-fal-key>` 等のプレースホルダ未設定行を解消（コメントアウト or 実値）。source 事故の温床。

---

## 6. 一切しないこと

- 本手順の VPS 実行（コンテナ置換・再 sync）は hkobayashi が手動で行う（不可逆寄りの本番 ES 操作）。
- 移行前に必ず `faq_docs`(DB) にデータがあることを確認（sync の源）。本調査時点で carnation 63 / demo 2 を確認済み。

---

*本ドキュメントは 2026-06-06 の kuromoji 導入時に発見した「永続 volume 不在 + delete-first sync」による FAQ インデックス消失の恒久対策。実機 `docker inspect es-commfaq` の Mounts=[] / RestartPolicy=no を根拠とする。*
