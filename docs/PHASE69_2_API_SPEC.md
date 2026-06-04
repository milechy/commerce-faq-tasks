# Phase69-2 API 拡張仕様 — AVAS チーム連携用

**作成日:** 2026-05-19
**バージョン:** 1.2
**ステータス:** Phase69-2-A 本番稼働中 (PR #152 merge済)
**作成者:** R2C (RAJIUCE) チーム
**共有先:** AVAS チーム

---

## 1. 概要

### 1.1 目的

R2C の検索 API に「**ゼロ知識除外検索 (zero-knowledge exclusion search)**」機能を追加した。AVAS / Hermes 等の外部連携時に、特定のナレッジ ID を検索結果から除外しつつ、除外対象の中身を AVAS 側に開示しない設計を採用している。

### 1.2 連携時の責務分担

| 領域 | R2C 側 | AVAS 側 |
|---|---|---|
| FAQ / ナレッジの実体保持 | ✅ | ❌ (アクセス不可) |
| `excluded_ids` 配列の保持・送信 | ❌ | ✅ |
| 除外判定とフィルタリング | ✅ | ❌ |
| 除外対象の内容を AVAS に返却 | ❌ (保証) | - |

→ AVAS チームは「**どの ID を除外したいか**」のリストだけ知っていれば良く、各 ID の中身は知る必要がない。

### 1.3 ユースケース

1. AVAS が独自に管理する「センシティブナレッジリスト」を R2C 検索時に除外
2. テナントごとの `default_excluded_ids` を R2C 側に永続保持し、毎リクエストで自動適用
3. リクエスト時 `excluded_ids` パラメータで追加の動的除外を指定

---

## 2. 検索 API への `excluded_ids` パラメータ追加 ★ 実装確認済み

### 2.1 エンドポイント

```
POST /agent.search
POST /dialog/turn
```

> **Note:** `/api/chat` エンドポイントは `excluded_ids` パラメータを受け入れない。

### 2.2 リクエスト仕様

#### `/agent.search`

```typescript
{
  // 既存パラメータ
  q: string,              // ★ クエリフィールド名は "q"（"query" ではない）
  topK?: number,          // 1〜20
  debug?: boolean,
  useLlmPlanner?: boolean,

  // ★ 新規追加
  excluded_ids?: string[]   // 検索除外対象の FAQ / ナレッジ ID
}
```

#### `/dialog/turn`

`excluded_ids` は `options` オブジェクトの配下に渡す:

```typescript
{
  message: string,
  sessionId?: string,
  options: {
    // ★ excluded_ids は options 配下
    excluded_ids?: string[],
    language?: "ja" | "en",
    piiMode?: boolean,
  }
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `excluded_ids` | `string[]` | No | 検索結果から除外する FAQ ID / ナレッジ ID の配列。UUID 形式想定だが文字列なら何でも可 |

### 2.3 制約 ★ 実装確認済み

| 項目 | 制限 |
|---|---|
| 最大長 | **500 要素** (それ以上は 400 Bad Request) |
| 個別 ID 最大長 | 制限なし (空文字は自動フィルタリング) |
| null / undefined | 空配列扱い (除外なし) |
| 空配列 `[]` | 除外なし |
| 不正型 (`/agent.search`) | 400 `{ error: "invalid_request", message: "Invalid request body for /agent.search" }` |
| 不正型 (`/dialog/turn`) | 400 `{ error: "invalid_excluded_ids", details: <Zod flatten error> }` |
| ID が存在しない場合 | 静かに無視 (エラーにしない) |

### 2.4 動作仕様

#### 現状の実装 (Phase69-2-A 時点)

リクエストの `excluded_ids` のみが検索フィルターに適用される:

```
実際の除外リスト = リクエスト excluded_ids (フィルタ後の空文字除去済み)
```

`pgvector.ts` の実装:
```sql
AND fe.id::text != ALL($4::text[])  -- リクエスト excluded_ids のみ
```

#### 設計上の将来仕様 (Phase69-2-E 以降で実装予定)

```
設計上の除外リスト = テナントの default_excluded_ids ∪ リクエスト excluded_ids
```

> **⚠️ 注意 (2026-05-31 時点):** `tenants.default_excluded_ids` カラムは DB スキーマに追加済みだが、
> TypeScript 側でこのカラムを検索時に読み込んでマージする実装はまだ存在しない。
> 現時点では `default_excluded_ids` はデータモデルとして定義されているのみで、検索動作への影響はない。
> AVAS チームは `excluded_ids` パラメータを使った「リクエストスコープ除外」のみ利用可能。

→ `default_excluded_ids` の永続統合（§7.2）は Phase69-2-E 対応後に利用可能になる予定。

### 2.5 サンプルリクエスト ★ 実装確認済み

```bash
# /agent.search — クエリフィールドは "q"
curl -X POST "https://api.r2c.biz/agent.search" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{
    "q": "返品ポリシーを教えてください",
    "excluded_ids": [
      "550e8400-e29b-41d4-a716-446655440000",
      "550e8400-e29b-41d4-a716-446655440001"
    ]
  }'

# /dialog/turn — excluded_ids は options 配下
curl -X POST "https://api.r2c.biz/dialog/turn" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{
    "message": "返品ポリシーを教えてください",
    "options": {
      "excluded_ids": [
        "550e8400-e29b-41d4-a716-446655440000"
      ]
    }
  }'
```

### 2.6 サンプルレスポンス (`/agent.search`)

```json
{
  "answer": "返品は商品到着後7日以内であれば...",
  "sources": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440002",
      "text": "返品について...",
      "score": 0.87
    }
  ],
  "meta": {
    "tenant_id": "partner-x",
    "duration_ms": 320,
    "ragStats": {
      "searchMs": 45,
      "rerankMs": 12,
      "answerMs": 260
    }
  }
}
```

> **注意:** レスポンスに `excluded_count` や `excluded_default_count` フィールドは**含まれない**。除外件数の追跡が必要な場合は AVAS 側で `excluded_ids` 配列の長さを参照すること。

**🔒 ゼロ知識保証:** レスポンスに除外された ID の内容 (title / answer / metadata) は **一切含まれない**。

---

## 3. PATCH /v1/admin/knowledge/faq/:id/exclude エンドポイント ★ 実装確認済み

### 3.1 概要

個別 FAQ の **デフォルト除外フラグ (`is_excluded_from_search`)** を切り替える Admin API。テナント管理者が UI から「この FAQ は検索結果に出さない」と設定するためのもの。

### 3.2 エンドポイント仕様

```
PATCH /v1/admin/knowledge/faq/:id/exclude
```

| 項目 | 値 |
|---|---|
| 認証 | JWT Bearer (Supabase Auth) |
| 必要ロール | `requireKnowledgeRole` ミドルウェアで制御 |
| tenant 制約 | `requireKnowledgeTenant` ミドルウェアで自テナント外アクセスをブロック |

### 3.3 リクエスト ★ 実装確認済み

```typescript
{
  is_excluded_from_search: boolean   // 必須、true=除外/false=解除
}
```

> **注意:** `reason` フィールドは実装に**存在しない**。

### 3.4 レスポンス ★ 実装確認済み

```json
{
  "id": 42,
  "is_excluded_from_search": true
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | `number` | FAQ の数値 ID (faq_docs.id) |
| `is_excluded_from_search` | `boolean` | 更新後のフラグ値 |

### 3.5 エラー ★ 実装確認済み

| HTTP | 理由 |
|---|---|
| 400 | `is_excluded_from_search` が boolean でない / tenant クエリパラメータなし / id が数値でない |
| 401 | JWT 無効 |
| 403 | 自テナント外の FAQ へのアクセス試行 |
| 404 | 該当 FAQ が存在しない (`faq_docs` に行なし) |
| 409 | DB ロックタイムアウト (3秒以内に他プロセスからのロック解放なし) |
| 500 | DB トランザクション失敗 / 内部エラー |

### 3.6 副作用 ★ 実装確認済み

- `faq_docs.is_excluded_from_search` と `faq_embeddings.is_excluded_from_search` を**単一 DB トランザクション**で atomic 更新
- Elasticsearch の該当ドキュメントの `is_excluded_from_search` フィールドを非同期 (fire-and-forget) で同期更新
- **監査ログへの記録はなし** (audit_logs テーブルは Right to Erasure 専用)

---

## 4. DB スキーマ変更 ★ 実装確認済み

### 4.1 `faq_embeddings` テーブル

```sql
ALTER TABLE faq_embeddings
  ADD COLUMN IF NOT EXISTS is_excluded_from_search BOOLEAN DEFAULT FALSE;

-- ★ 除外レコードに対する部分インデックス (is_excluded_from_search = true 側)
CREATE INDEX IF NOT EXISTS idx_faq_embeddings_excluded
  ON faq_embeddings (tenant_id, is_excluded_from_search)
  WHERE is_excluded_from_search = true;
```

| カラム | 型 | デフォルト | 説明 |
|---|---|---|---|
| `is_excluded_from_search` | BOOLEAN | FALSE | TRUE の場合、検索結果から自動除外 |

### 4.2 `faq_docs` テーブル ★ 実装確認済み (ドラフト未記載)

PATCH エンドポイントの source-of-truth として `faq_docs` にも同カラムを追加:

```sql
ALTER TABLE faq_docs
  ADD COLUMN IF NOT EXISTS is_excluded_from_search BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_faq_docs_excluded
  ON faq_docs (tenant_id, is_excluded_from_search)
  WHERE is_excluded_from_search = true;
```

> PATCH 操作は `faq_docs` と `faq_embeddings` の両方を単一 TX で更新する。`faq_docs.is_excluded_from_search` が admin UI 操作の source-of-truth。

### 4.3 `tenants` テーブル

```sql
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_excluded_ids TEXT[] DEFAULT '{}';
```

| カラム | 型 | デフォルト | 説明 |
|---|---|---|---|
| `default_excluded_ids` | TEXT[] | `{}` | テナントごとに固定で除外するナレッジ ID の配列 |

→ 検索時、このテナントへのすべてのリクエストで自動的に除外される。
→ AVAS 連携の場合、AVAS 側で頻繁に変わるリストは `excluded_ids` パラメータ経由、R2C 側で永続化したいものは `default_excluded_ids` 経由を推奨。

### 4.4 Elasticsearch スキーマ

`faq_embeddings` インデックスに以下を追加:

```json
{
  "mappings": {
    "properties": {
      "is_excluded_from_search": { "type": "boolean" }
    }
  }
}
```

検索クエリにフィルタ追加:

```json
{
  "bool": {
    "must_not": [
      { "term": { "is_excluded_from_search": true } }
    ]
  }
}
```

> **Note:** ES インデックス命名の不整合 (Phase33-c 起因) は Phase69-2-E (due 5/22) で対応予定。現状は pgvector パスの永続フラグフィルターが primary defense。

### 4.5 pgvector 検索のフィルタ ★ 実装確認済み

実際の SQL はリクエスト `excluded_ids` を `AND fe.id::text != ALL($4::text[])` で除外し、かつ `faq_docs` との LEFT JOIN で `is_published` と `is_excluded_from_search` を多層チェックする:

```sql
SELECT
  fe.id::text AS id,
  fe.text,
  fe.metadata,
  1 - (fe.embedding <-> $2::vector) AS score
FROM faq_embeddings fe
LEFT JOIN faq_docs fd
  ON fe.metadata->>'faq_id' ~ '^[0-9]+$'
 AND fd.id = (fe.metadata->>'faq_id')::bigint
WHERE (fe.tenant_id = $1 OR fe.tenant_id = 'global')
  AND (
    (
      -- FAQ 系: faq_id を持ち faq_docs 行が存在 → is_published + is_excluded チェック
      fe.metadata->>'faq_id' ~ '^[0-9]+$'
      AND fd.id IS NOT NULL
      AND fd.is_published = true
      AND (fd.is_excluded_from_search IS NULL OR fd.is_excluded_from_search = false)
    )
    OR
    (
      -- 非 FAQ (book/web/groq 等): faq_id を持たない → faq_docs チェック不要
      fe.metadata->>'faq_id' IS NULL
      OR fe.metadata->>'faq_id' !~ '^[0-9]+$'
    )
  )
  AND (fe.is_excluded_from_search IS NULL OR fe.is_excluded_from_search = false)
  AND fe.id::text != ALL($4::text[])  -- リクエスト excluded_ids (空の場合はこの句自体を省略)
ORDER BY fe.embedding <-> $2::vector
LIMIT $3;
-- $1 = tenantId, $2 = embedding vector, $3 = topK, $4 = merged excluded_ids[]
```

`$4` = (テナントの `default_excluded_ids` ∪ リクエストの `excluded_ids`)

---

## 5. テナント分離 (Tenant Isolation) の保証

R2C はマルチテナント SaaS のため、テナント境界を破る検索は **絶対に発生しない設計**。

### 5.1 認証段階の tenant 解決

- JWT Bearer: `payload.tenant_id` から取得
- x-api-key: SHA-256 ハッシュ → DB lookup で `tenant_id` 取得
- `req.body.tenant_id` の信頼は禁止 (詳細は `ARCHITECTURE.md` 参照)

### 5.2 検索クエリ強制条件

すべての検索クエリで `WHERE fe.tenant_id = <authed_tenant_id>` を強制。

### 5.3 `excluded_ids` のテナント境界

- AVAS が `excluded_ids` に **他テナントの ID を混入させても安全**:
  - そもそも検索対象が自テナント内のみのため、他テナントの ID は最初からヒットしない
  - 結果として「他テナント ID の指定」は無効なノイズとして扱われる
- これを利用したテナントスキャン攻撃も無効 (ヒット数の差で他テナント ID の存在を推測することはできない、なぜなら検索対象に他テナント ID は最初から含まれていない)

### 5.4 PATCH エンドポイントの tenant 境界

- `requireKnowledgeTenant` ミドルウェアが自テナントの FAQ のみ操作を許可
- DB トランザクション内でも `WHERE tenant_id = $tenantId` を強制
- 他テナント FAQ への操作試行は 403 を返す

---

## 6. 既知の制約と Phase69-2-D/E の対応予定

### 6.1 orphan faq_embedding 問題

**現象:** `faq_embeddings` に存在するが `faq_docs` 削除済みの孤児レコードが存在。
**影響:** pgvector SQL の LEFT JOIN + `fd.id IS NOT NULL` チェックにより、孤児レコードは検索結果から自動除外される。
**対応:** Phase69-2-D (due 5/20) で `faq_id JOIN` ベースの整合性チェック + クリーンアップ。

### 6.2 ES index naming 不整合

**現象:** ES インデックス名がコードとデプロイ環境で食い違い (Phase33-c 起因)。
**影響:** ES パスでの is_excluded_from_search フィルタが効かないケースあり。pgvector パスの永続フィルターが補完している。
**対応:** Phase69-2-E (due 5/22) で標準化。

---

## 7. AVAS チーム向け推奨統合パターン

### 7.1 軽量統合 (推奨)

AVAS 側で除外したい ID をリクエストごとに送る:

```javascript
// AVAS 側 — /agent.search を使う場合
const response = await fetch('https://api.r2c.biz/agent.search', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': process.env.R2C_API_KEY,
  },
  body: JSON.stringify({
    q: userQuery,                            // ★ フィールド名は "q"
    excluded_ids: avasExcludedSet.toArray(), // 最大500件
  }),
});

// /dialog/turn を使う場合 — excluded_ids は options 配下
const response = await fetch('https://api.r2c.biz/dialog/turn', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': process.env.R2C_API_KEY,
  },
  body: JSON.stringify({
    message: userQuery,
    options: {
      excluded_ids: avasExcludedSet.toArray(),
    },
  }),
});
```

利点: R2C 側のテナント設定変更不要、AVAS 側で動的制御可。

### 7.2 永続統合

頻繁に変わらない除外リストは R2C 側の `default_excluded_ids` に保存:

1. AVAS チームが除外したい ID 一覧を R2C チームに連絡
2. R2C チームが `tenants.default_excluded_ids` に SQL UPDATE で反映
3. 以降、すべての検索リクエストで自動適用

```sql
-- R2C 側 (DBA が実行)
UPDATE tenants
SET default_excluded_ids = ARRAY['id-a', 'id-b', 'id-c']
WHERE tenant_id = '<your-tenant-id>';
```

利点: AVAS 側コード変更不要、R2C 側で一元管理。

---

## 8. レート制限・パフォーマンス

| 項目 | 値 |
|---|---|
| 検索 API rate limit | テナントの `rateLimit` (デフォルト 60 req/min) |
| `excluded_ids` 上限 | **500 要素** ★ 実装確認済み (Zod `z.array(z.string()).max(500)`) |
| `default_excluded_ids` の適用タイミング | **未実装** (DB スキーマのみ定義済み。Phase69-2-E 以降で実装予定) |
| Admin API (PATCH exclude) DB lock timeout | 3秒 (`SET LOCAL lock_timeout = '3s'`) |

---

## 9. 関連リソース

- **PR #152**: Phase69-2-A 実装 (MERGED)
- **Asana Phase69-2-A**: GID 1214820212071249 (完了)
- **Asana Phase69-2-B** (Admin UI): GID 1214820212071185 (5/22 期限)
- **Asana Phase69-2-C** (本ドキュメント): GID 1214819998397674
- **Asana Phase69-2-D** (orphan 対応): GID 1214820948023240 (5/20 期限)
- **Asana Phase69-2-E** (ES naming): GID 1214821660260379 (5/22 期限)
- **R2C 全体アーキテクチャ**: `ARCHITECTURE.md`
- **テナント分離設計**: `docs/auth.md`, `docs/tenant.md`

---

## 10. 変更履歴

| バージョン | 日付 | 変更内容 | 作成者 |
|---|---|---|---|
| 1.0 | 2026-05-19 | 初版作成、Phase69-2-A 本番稼働後の仕様確定版 | R2C チーム |
| 1.1 | 2026-05-19 | PR #152 実装に基づく精緻化、推測ベースの値を実装値に置換: max要素数1000→500、`q`フィールド名修正、dialog `options`配下に修正、PATCH response形式修正 (`reason`/`updated_at`/`updated_by` 削除)、faq_docs カラム追加記載、インデックス条件修正 (`= true`)、excluded_count/excluded_default_count 削除、audit_log 記載修正、409エラー追加 | R2C チーム (CLI) |
| 1.2 | 2026-05-31 | Phase69-2-C AVAS連携対応: `default_excluded_ids` の実装状況を実機照合で訂正 (DB スキーマのみ定義済み、TypeScript 側でのマージ実装は未着手)。§2.4 動作仕様に「現状実装」と「将来設計」を分離記載、§8 パフォーマンス表の適用タイミングを未実装と明記。PARTNER_ROLLOUT_PLAYBOOK.md にゼロ知識検索節を追記。 | R2C チーム (CLI) |

---

## 11. 連絡先

- Slack: `#r2c` (Channel ID: C0AG07HFJTB)
- 仕様に関する質問は同チャンネルで `@hkobayashi` までメンション
