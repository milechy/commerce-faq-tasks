# データ保持ポリシー

**作成日:** 2026-04-06
**ステータス:** ポリシー策定済み（部分実装、段階的展開）
**GDPR 同意バナー:** 本番リリース前に必須
**データライフサイクル管理:** テナント10社以上で着手

---

## 1. データ分類と保持期間

| データ | Hot (アクティブ) | Warm (集約) | Cold (アーカイブ) |
|---|---|---|---|
| `behavioral_events` | 0-90日 (PostgreSQL) | 90日-1年 (日次集約テーブル) | 1年+ (月次集約 → S3) |
| `chat_messages` | 全量保持（永久） | — | — |
| `conversation_evaluations` | 全量保持（永久） | — | — |
| `conversion_attributions` | 全量保持（永久） | — | — |
| `visitor_embeddings` | 90日 (pgvector) | クラスター centroid に集約 | 削除 |
| `faq_embeddings` | 全量保持（永久） | — | — |
| `usage_logs` | 90日 | 月次集約 | 年次集約 |
| `session_events` | 90日 | 日次集約 | 削除 |

### 保持期間の根拠

| データ | 理由 |
|---|---|
| `chat_messages` | ユーザーへのサポート継続性、Judge 評価の基底データ |
| `conversion_attributions` | ROI 分析、課金根拠、永続的に必要 |
| `behavioral_events` | 90日で行動パターンが出揃う。長期保持はコスト非効率 |
| `visitor_embeddings` | 90日超の訪問者は「新規」とみなして再学習の方が精度向上 |

---

## 2. GDPR / APPI 対応

### 2.1 適用法令

| 法令 | 適用条件 | R2C への影響 |
|---|---|---|
| GDPR (EU) | EU 域内の個人データ処理 | EU 展開時に適用 |
| APPI (日本) | 日本国内の個人情報取扱 | **現在適用中** |
| CCPA (California) | カリフォルニア州民のデータ | 米国展開時に適用 |

### 2.2 データ削除リクエスト対応フロー

```
ユーザーリクエスト
  → テナント経由でリクエスト受付
  → /v1/admin/privacy/deletion-request エンドポイント（Super Admin）
  → 対象: visitor_id に紐づく全テーブルを特定
  → 削除対象テーブル:
     - behavioral_events (visitor_id)
     - chat_messages (session_id → visitor_id を逆引き)
     - visitor_profiles (visitor_id)
     - visitor_embeddings (visitor_id)
  → 72時間以内に完了（GDPR 要件）
  → 削除完了通知をテナントに送信
```

### 2.3 同意管理

**同意レベル:**

| レベル | 内容 | 必須 |
|---|---|---|
| `essential` | チャット機能に必須のデータ（session_id、会話内容） | 必須（同意不要） |
| `analytics` | 行動データ収集（behavioral_events、page_url、scroll_depth） | オプション |
| `marketing` | クロステナント学習（匿名化後のパターン共有） | オプション |

**テナントごとのデフォルト設定:**

```sql
-- tenants テーブル拡張（将来マイグレーション）
ALTER TABLE tenants ADD COLUMN consent_analytics BOOLEAN DEFAULT true;
ALTER TABLE tenants ADD COLUMN consent_marketing BOOLEAN DEFAULT false;
```

### 2.4 同意取得 UI の設計

```
┌─────────────────────────────────────────────────────────┐
│ このチャットサービスを利用するにあたり、以下のデータを収集します。 │
│                                                         │
│ [✓] 必須 — 会話内容・セッション情報（変更不可）         │
│ [ ] 任意 — サービス改善のための利用統計                 │
│                                                         │
│ 詳細設定 ▸                                              │
│                           [同意して開始] [必須のみで開始] │
└─────────────────────────────────────────────────────────┘
```

**実装箇所:** `public/widget.js` — 初回表示時にバナーを表示、`localStorage` に同意状態を保存

---

## 3. 1st Party データのみ設計

### 3.1 データ収集ポリシー

| 手法 | 方針 |
|---|---|
| Cookie | **1st party のみ** （`Secure; SameSite=Strict`） |
| localStorage | visitor_id の永続化（cookie 代替） |
| 3rd party cookie | **使用しない** |
| Tracking pixel | **使用しない** |
| IP アドレス | ログ目的のみ（分析クエリには使用しない） |
| User-Agent | ブラウザ/OS 分類のみ（個人特定には使用しない） |

### 3.2 visitor_id の管理

```javascript
// widget.js での visitor_id 生成（1st party）
function getOrCreateVisitorId() {
  let id = localStorage.getItem('r2c_visitor_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('r2c_visitor_id', id);
  }
  return id;
}
```

---

## 4. バックアップ・リストア

### 4.1 現在の実装状況

| 対象 | 方法 | 頻度 | 保持期間 |
|---|---|---|---|
| PostgreSQL | `pg_dump` (VPS cron) | 日次 | 7日 |
| Elasticsearch | — | 未実装 | — |
| ファイルストレージ | Supabase Storage 内蔵 | — | — |

### 4.2 将来の拡張計画

```bash
# PostgreSQL 日次バックアップ（VPS cron 想定）
0 2 * * * pg_dump $DATABASE_URL | gzip > /backup/pg_$(date +%Y%m%d).sql.gz

# 7日以上古いバックアップを削除
0 3 * * * find /backup -name "pg_*.sql.gz" -mtime +7 -delete
```

**Cold Storage（将来）:**
- Hetzner Object Storage または AWS S3 Glacier
- 月次スナップショット → 1年保持
- コスト試算: ~$2-5/月（Hetzner Object Storage）

### 4.3 Elasticsearch スナップショット（将来）

```bash
# Elasticsearch snapshot API
PUT /_snapshot/my_backup
{
  "type": "fs",
  "settings": { "location": "/mnt/backup/elasticsearch" }
}

# 日次スナップショット
PUT /_snapshot/my_backup/snapshot_$(date +%Y%m%d)
```

---

## 5. データライフサイクル管理の自動化

### 5.1 behavioral_events の Hot → Warm 移行

```sql
-- 日次バッチ: 90日以上経過した behavioral_events を集約テーブルに移動
INSERT INTO behavioral_events_daily_summary
SELECT
  date_trunc('day', occurred_at) AS event_date,
  tenant_id,
  event_type,
  COUNT(*) AS event_count,
  COUNT(DISTINCT visitor_id_hash) AS unique_visitors
FROM behavioral_events
WHERE occurred_at < NOW() - INTERVAL '90 days'
GROUP BY 1, 2, 3;

-- 元データ削除
DELETE FROM behavioral_events
WHERE occurred_at < NOW() - INTERVAL '90 days';
```

### 5.2 visitor_embeddings の期限切れ削除

```sql
-- 90日以上アクティビティのない visitor の embedding を削除
DELETE FROM visitor_embeddings
WHERE visitor_id NOT IN (
  SELECT DISTINCT visitor_id FROM behavioral_events
  WHERE occurred_at >= NOW() - INTERVAL '90 days'
);
```

---

## 6. 実装タイムライン

| 優先度 | タスク | 条件 |
|---|---|---|
| **P0（必須）** | チャットウィジェットの GDPR 同意バナー実装 | **本番リリース前** |
| P1 | データ削除リクエスト API | テナント10社+ |
| P2 | behavioral_events 自動アーカイブ | テナント10社+ |
| P2 | visitor_embeddings 自動削除 | テナント10社+ |
| P3 | Cold Storage (Hetzner Object Storage) 連携 | テナント50社+ |
| P3 | Elasticsearch スナップショット | テナント50社+ |

---

*関連ドキュメント: ANONYMIZATION_PIPELINE_DESIGN.md / CROSS_CHANNEL_ID_DESIGN.md*
