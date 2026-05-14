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

#### (d) 除外対象スコープ (Round 3, Codex Adversarial #1 対応)

Phase69-2 の `PATCH /v1/admin/knowledge/faq/:id/exclude` および
`pgvector.ts` の source 分岐は **FAQ 系 embedding のみが対象**:

| source | スコープ | exclusion 経路 |
|---|---|---|
| `scrape` / `text` / `faq` | **FAQ 系** (Phase69-2 対象) | `faq_docs.is_excluded_from_search` + `faq_embeddings.is_excluded_from_search` (両更新) |
| `book` / `book:pdf:qwen-ocr` | 非 FAQ 系 (書籍 PDF) | 将来 Phase で UI 化予定 |
| `carnation:web` | 非 FAQ 系 (web scrape) | 将来 Phase で UI 化予定 |
| `groq/compound-mini` | 非 FAQ 系 (LLM 自動生成) | 将来 Phase で UI 化予定 |
| `NULL` | 非 FAQ 系扱い (defensive default) | 将来 Phase で対応 |

参考: 2026-05-15 時点の VPS DB 実態 (`faq_embeddings` 全 147 件):
- FAQ 系: scrape 41 + text 10 + faq 2 = **53 件** (全件 `metadata.faq_id` 保持)
- 非 FAQ 系: book 40 + book:pdf:qwen-ocr 29 + carnation:web 22 + groq/compound-mini 3 = **94 件** (`faq_id` NULL)
- orphan (faq_id 持つが faq_docs に対応なし): **1 件** → 別タスク (Phase69-2-D) で対処予定

`pgvector.ts` の WHERE 句は以下の構造で source を判定:

```sql
-- FAQ 系: faq_docs 厳格チェック (legacy 未連携 embedding は FAQ 検索結果から除外)
fe.metadata->>'source' IN ('scrape', 'text', 'faq')
AND fd.id IS NOT NULL
AND fd.is_published = true
AND (fd.is_excluded_from_search IS NULL OR fd.is_excluded_from_search = false)
-- OR
-- 非 FAQ 系: faq_docs チェックをスキップ (faq_embeddings レイヤーのみで判定)
(fe.metadata->>'source' IS NULL OR fe.metadata->>'source' NOT IN ('scrape', 'text', 'faq'))
```

加えて `fe.is_excluded_from_search` フィルターは全 source 共通で適用される (二重防御)。

orphan 検出 SQL (運用確認用):

```sql
-- orphan: faq_id を持つが faq_docs に対応行なし
SELECT fe.id, fe.tenant_id, fe.metadata->>'faq_id' AS faq_id
FROM faq_embeddings fe
LEFT JOIN faq_docs fd ON fd.id = (fe.metadata->>'faq_id')::bigint
WHERE fe.metadata->>'faq_id' ~ '^[0-9]+$' AND fd.id IS NULL;
```
