# VPS 運用ガイド

VPS: Hetzner `root@65.108.159.161` / `/opt/rajiuce`

---

## 1. デプロイ手順

```bash
bash SCRIPTS/deploy-vps.sh
```

`deploy-vps.sh` は以下を一括実行する:
1. VPS ファイル所有者正規化（root:root）
2. rsync でソース同期（`.env`, `venv/`, `node_modules/` は除外）
3. `pnpm install --frozen-lockfile`
4. `pnpm build`
5. **avatar-agent Python venv 更新**（`requirements.txt` に従って `pip install`）
6. PM2 `startOrRestart`（rajiuce-api, rajiuce-avatar）
7. Nginx リロード
8. ポスト・スモークテスト（`post-deploy-smoke.sh`）

> ⚠️ `ssh root@... "git pull && pm2 restart"` などの個別コマンドは禁止。

---

## 2. rsync 除外対象

`deploy-vps.sh` の rsync は以下を VPS に転送しない:

| 除外パス | 理由 |
|---|---|
| `node_modules/`, `admin-ui/node_modules/` | VPS で pnpm install により生成 |
| `dist/`, `admin-ui/dist/` | VPS で pnpm build により生成 |
| `.env`, `.env.*` | VPS の本番シークレットを保持（上書き禁止） |
| `avatar-agent/venv/` | VPS で pip install により生成 |
| `docs/investigation/` | ローカル調査メモ（VPS 不要 + Guard 4-B 誤検知防止） |
| `.wolf/` | OpenWolf ローカルキャッシュ（VPS 不要） |
| `.git/`, `logs/`, `*.log`, `.DS_Store` | ビルド生成物・ローカル専用 |

> **Guard 4-B について**: rsync 除外漏れで VPS にローカル専用ファイルが転送されると
> `git status --porcelain` に untracked として表示され Guard 4-B がブロックする。
> `deploy-vps.sh` は deploy 前に `docs/investigation/` と `.wolf/` を VPS から自動削除する。

---

## 3. avatar-agent 運用

### プロセス管理

```bash
# 状態確認
ssh root@65.108.159.161 "pm2 describe rajiuce-avatar"

# ログ確認（直近100行）
ssh root@65.108.159.161 "pm2 logs rajiuce-avatar --lines 100 --nostream"

# 手動再起動
ssh root@65.108.159.161 "pm2 restart rajiuce-avatar"
```

### Python venv 管理

`avatar-agent/venv/` は rsync 除外のため VPS にのみ存在する。`deploy-vps.sh` の [3.5/5] ステップで自動更新される。

手動で再構築が必要な場合:

```bash
ssh root@65.108.159.161
cd /opt/rajiuce/avatar-agent
rm -rf venv
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
pm2 restart rajiuce-avatar
```

### 依存パッケージ

`avatar-agent/requirements.txt` の直接依存（バージョン固定済み、2026-04-21 pip freeze より）:

| パッケージ | バージョン | 用途 |
|---|---|---|
| `livekit-agents[lemonslice,openai]` | 1.5.5 | LiveKit Agent SDK |
| `fish-audio-sdk` | 1.3.0 | Fish Audio TTS |
| `groq` | 1.2.0 | Groq LLM SDK |
| `httpx` | 0.28.1 | HTTP クライアント |
| `python-dotenv` | 1.2.2 | `.env` 読み込み |
| `aiohttp` | 3.13.5 | 非同期 HTTP（Groq API, Fish Audio, 内部API呼び出し） |

#### バージョン更新手順

```bash
# 1. VPS 上でアップグレード
ssh root@65.108.159.161
cd /opt/rajiuce/avatar-agent
source venv/bin/activate
pip install -U livekit-agents  # 更新したいパッケージ
pip freeze > /tmp/freeze.txt

# 2. ローカルに requirements.txt を更新
# 直接依存（上記6パッケージ）のバージョンを pip freeze 出力に合わせて書き換え
```

> ⚠️ `>=` 制約は使わない。livekit-agents はマイナーバージョン間で破壊的変更があるため、
> バージョン未固定だと deploy 毎に異なるバージョンが入りサイレントな不具合が発生する。

---

## 4. インシデント記録

### [2026-04-21] avatar-agent venv 消失 → aiohttp 欠落

**症状**: rajiuce-avatar が起動後すぐクラッシュ。PM2 ログに `ModuleNotFoundError: No module named 'aiohttp'` が出力される。

**根本原因**:
1. VPS 上で `rm -rf venv` 後に手動再構築した際、`requirements.txt` に `aiohttp` が記載されておらず未インストール。
2. `deploy-vps.sh` に Python venv 更新ステップが存在しなかったため、デプロイ毎に venv が陳腐化していた。

**対処**:
- `avatar-agent/requirements.txt` に `aiohttp>=3.9.0` を追記。
- `deploy-vps.sh` に [3.5/5] ステップを追加（pip install 自動実行）。
- `post-deploy-smoke.sh` に rajiuce-avatar の PM2 オンライン確認を追加。

**再発防止**: デプロイ毎に pip install が走るため、今後 `requirements.txt` を更新すれば自動反映される。

---

## 5. PM2 プロセス一覧

| ID | Name | Script |
|---|---|---|
| 0 | rajiuce-api | `dist/src/index.js` (port 3100) |
| 1 | rajiuce-admin | `serve admin-ui/dist -l 5173` |
| 2 | slack-listener | `slack_listener.py` |
| 5 | rajiuce-avatar | `avatar-agent/agent.py` (LiveKit Agent) |

```bash
ssh root@65.108.159.161 "pm2 list"
```

---

## 6. Nginx 設定

- `api.r2c.biz` → `localhost:3100`
- `admin.r2c.biz` → Cloudflare Pages（VPS は admin UI をホストしない）
- SSL: Let's Encrypt（`certbot --nginx`、自動更新）

```bash
# 設定テスト
ssh root@65.108.159.161 "nginx -t"
# リロード
ssh root@65.108.159.161 "systemctl reload nginx"
```

---

## 7. Phase 別デプロイ後の手動運用手順

### Phase69-2: excluded_ids ゼロ知識検索

`deploy-vps.sh` 完了後、以下を **hkobayashi が手動で順次実行**。

#### (a) DB マイグレーション

```bash
ssh root@65.108.159.161 "cd /opt/rajiuce && psql \$DATABASE_URL -f src/migrations/phase69_2_excluded_ids.sql"
```

追加されるもの:
- `faq_embeddings.is_excluded_from_search BOOLEAN DEFAULT FALSE`
- `faq_docs.is_excluded_from_search BOOLEAN DEFAULT FALSE`
- `tenants.default_excluded_ids TEXT[] DEFAULT '{}'`
- 上記カラムへのインデックス

#### (b) Elasticsearch re-index

Phase69-2 で ES mapping に `is_published` / `is_excluded_from_search` を明示追加した。
既存インデックスは dynamic mapping のため、明示マッピングを反映するには re-index が必要。

> **ES write path の不整合は Phase69-2-E で解消済み**
> `upsertToEsAsync`（CRUD POST/PUT）・`syncIsExcludedToEsAsync`（/exclude PATCH）・`deleteFromEs`（DELETE）は
> いずれも `is_excluded_from_search` を含む doc を ES に伝搬する。
> **Phase69-2-E 以前は書き込み index が `ES_FAQ_INDEX || "faqs"`、検索 read path が `faq_<tenantId>` と
> 異なっており（Phase33-c 起因）、ES への除外同期が事実上機能していなかった。**
> Phase69-2-E で write path を read path と同じ `faq_<tenantId>` に統一した（後述の命名規則を参照）。
> なお pgvector 経由の除外フィルター（`WHERE fd.is_excluded_from_search = false`）は index 名に依存せず常に機能する。

##### ES index 命名規則（Phase69-2-E で確定）

| 用途 | index 名 | 解決元 |
|------|----------|--------|
| FAQ 書き込み（upsert / delete / exclude 同期） | `faq_<tenantId>` | `src/search/langIndex.ts` の `resolveFaqWriteIndex(tenantId)` |
| FAQ 検索 read path（hybrid / langRouter） | `faq_<tenantId>_<lang>`（プライマリ）→ `faq_<tenantId>`（フォールバック） | `resolveFallbackIndices(tenantId, lang)` |
| reindex（全件再構築） | `faq_<tenantId>` | `SCRIPTS/sync-es.ts` の `syncTenant()` |

- **正典は `resolveFaqWriteIndex` / `sync-es.ts` で、いずれも `faq_<tenantId>`。** 環境変数 `ES_FAQ_INDEX` による FAQ index の上書きは廃止した。
- `ES_FAQ_INDEX` は book-pipeline（Phase44/47、`bookStructurizer.ts` / `embedAndStore.ts`）が暫定的に参照するのみ。FAQ 検索経路では一切使わない。
- global ナレッジの delete は `faq_global` ではなく、doc が書き込まれたテナントの `faq_<recordTenantId>` を対象にする（write 時と同じ index）。

```bash
ssh root@65.108.159.161 "cd /opt/rajiuce && pnpm ts-node SCRIPTS/sync-es.ts --all"
```

これにより全テナントの `faq_<tenantId>` インデックスが削除→再作成され、
新しい mapping (`is_excluded_from_search: { type: 'boolean' }`) で再構築される。

#### (c) 反映検証

```bash
# 1. テストテナントで FAQ を1件除外フラグ ON にする
curl -X PATCH https://api.r2c.biz/v1/admin/knowledge/faq/<faqId>/exclude \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"is_excluded_from_search": true}'

# 2. 該当 FAQ を含むクエリで hybrid 検索を実行し、結果に出ないことを確認
curl -X POST https://api.r2c.biz/agent.search \
  -H "x-api-key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"q": "<該当FAQに含まれる質問>", "topK": 10}'

# 3. ES 側でも除外されていることを直接確認（オプション）
ssh root@65.108.159.161 'curl -s "$ES_URL/faq_<tenantId>/_search" \
  -H "Content-Type: application/json" \
  -d "{\"query\":{\"term\":{\"is_excluded_from_search\":true}},\"_source\":[\"faq_id\",\"is_excluded_from_search\"]}"'
```

#### ロールバック手順

ES 同期失敗時:
- DB は source-of-truth なので、ES 不整合があれば `sync-es.ts --all` で再同期可能
- API は fire-and-forget で 5xx を返さないため、Admin UI 操作は成功扱い

DB マイグレーション失敗時:
- `phase69_2_excluded_ids.sql` は `IF NOT EXISTS` 付きなので冪等
- カラム追加失敗時は `ALTER TABLE ... DROP COLUMN is_excluded_from_search` で巻き戻し

#### (d) 除外対象スコープ — identity-based 判定 (Round 4, Codex Adversarial Round 3 #1 対応)

`pgvector.ts` の WHERE 句は **faq_id identity** で FAQ かどうかを判定する:
- **FAQ identity** = `metadata.faq_id` が数値文字列で、対応する `faq_docs` 行が存在する
- **非 FAQ** = `metadata.faq_id` が存在しない、または数値以外

##### 設計の変遷

| Round | 判定方式 | 問題 |
|---|---|---|
| Round 2 (旧) | `fd.id IS NULL` でパススルー | legacy embedding が exclusion をすり抜ける (Codex Round 2 #1) |
| Round 3 (旧) | `source IN ('scrape','text','faq')` で FAQ 系を限定 | CRUD 経由 (`source='faq_crud'`) が非 FAQ branch に落ちて未公開 FAQ が漏れる (Codex Round 3 #1) |
| **Round 4 (現行)** | `faq_id` の有無 + `faq_docs` JOIN 成功で判定 | source 名のミスタイプ・列挙漏れに無敵 |

##### embedding source 別の挙動

| source | `faq_id` | identity 判定 | exclusion 経路 |
|---|---|---|---|
| `faq_crud` (CRUD POST/PUT) | 数値 | **FAQ 系** | `faq_docs.is_excluded_from_search` + `faq_embeddings.is_excluded_from_search` (両更新) |
| `scrape` / `text` / `faq` (旧 import) | 数値 | **FAQ 系** | 同上 |
| `book` / `book:pdf:qwen-ocr` (PDF) | NULL | 非 FAQ | `faq_embeddings.is_excluded_from_search` のみ (将来 UI 化) |
| `carnation:web` (web scrape) | NULL | 非 FAQ | 同上 |
| `groq/compound-mini` (LLM 生成) | NULL | 非 FAQ | 同上 |
| `NULL` | (任意) | `faq_id` で判定 | 同上 |
| orphan (`faq_id` 数値だが `faq_docs` 行なし) | 数値 | **どちらにもマッチせず除外** | 自動的に検索結果から除外 |

参考: 2026-05-15 時点の VPS DB 実態 (`faq_embeddings` 全 147 件):
- FAQ 系 (faq_id 数値持ち + faq_docs JOIN 成功): 53 件
- 非 FAQ (faq_id NULL): 94 件 (book 40 + book:pdf:qwen-ocr 29 + carnation:web 22 + groq/compound-mini 3)
- orphan: 1 件 → 別タスク (Phase69-2-D) で対処予定

##### pgvector.ts WHERE 句 (identity-based)

```sql
WHERE (fe.tenant_id = $1 OR fe.tenant_id = 'global')
  AND (
    -- FAQ identity branch: faq_docs を厳格チェック
    (
      fe.metadata->>'faq_id' ~ '^[0-9]+$'
      AND fd.id IS NOT NULL
      AND fd.is_published = true
      AND (fd.is_excluded_from_search IS NULL OR fd.is_excluded_from_search = false)
    )
    OR
    -- 非 FAQ branch: faq_docs を見ない
    (fe.metadata->>'faq_id' IS NULL OR fe.metadata->>'faq_id' !~ '^[0-9]+$')
  )
  AND (fe.is_excluded_from_search IS NULL OR fe.is_excluded_from_search = false)
```

`fe.is_excluded_from_search` フィルターは全 identity 共通で適用 (二重防御)。

##### /exclude エンドポイント — in-tx lock + rowCount assertion (Round 4)

`PATCH /v1/admin/knowledge/faq/:id/exclude` は以下のシーケンスで動作する:

1. `BEGIN`
2. `SET LOCAL lock_timeout = '3s'`
3. `SELECT id, tenant_id FROM faq_docs WHERE id = $1 FOR UPDATE` ← tx 内 precheck + 行ロック
4. rowCount=0 → 404 (`ROLLBACK`)、tenant 不一致 → 403 (`ROLLBACK`)
5. `UPDATE faq_docs SET is_excluded_from_search = $1 ...` ← rowCount=1 を assert (異常時 500 + `ROLLBACK`)
6. `UPDATE faq_embeddings SET is_excluded_from_search = $1 WHERE ... AND (metadata->>'faq_id') ~ '^[0-9]+$' AND (metadata->>'faq_id')::bigint = $3`
7. `COMMIT`
8. COMMIT 後に ES へ partial update を fire-and-forget 同期

これにより precheck → UPDATE 間のレース (削除/移動) でも 200 success を返さない。

##### orphan 検出 SQL (運用確認用)

```sql
-- orphan: faq_id を持つが faq_docs に対応行なし
SELECT fe.id, fe.tenant_id, fe.metadata->>'faq_id' AS faq_id
FROM faq_embeddings fe
LEFT JOIN faq_docs fd ON fd.id = (fe.metadata->>'faq_id')::bigint
WHERE fe.metadata->>'faq_id' ~ '^[0-9]+$' AND fd.id IS NULL;
```

orphan は Round 4 の identity-based 判定で自動的に検索結果から除外される
(FAQ identity branch には `fd.id IS NOT NULL` が必須、非 FAQ branch には `faq_id IS NULL` が必須)。
