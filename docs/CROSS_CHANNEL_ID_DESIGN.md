# クロスチャネル ID 設計

**作成日:** 2026-04-06
**ステータス:** 設計のみ（将来実装）
**実装タイムライン:** 2027 H2〜2028（LINE 連携が最初の候補）

---

## 1. 概要

Web チャット、LINE、電話、実店舗など複数チャネルにまたがる顧客行動を統合し、一貫したパーソナライズ体験を提供するための ID 設計。

**提供価値:**
- Web で見ていた車種を LINE でフォローアップできる
- 「3日前にWebで問い合わせた○○さんですね」と店舗スタッフが認識できる
- チャネルをまたいだ転換率・離脱ポイントを分析できる

---

## 2. 統合 ID 体系

### 2.1 unified_visitor_id

- **形式:** UUID v4
- **生成タイミング:** Web での初回チャット開始時
- **保存場所:** `localStorage` + `visitor_profiles.unified_visitor_id`

### 2.2 チャネル紐づけ構造

```json
{
  "web": {
    "visitor_id": "v_550e8400-e29b-41d4-a716-446655440000",
    "cookie_id": "c_abc123"
  },
  "line": {
    "line_user_id": "U4af4980629..."
  },
  "phone": {
    "phone_hash": "sha256(090xxxxxxxx + salt)"
  },
  "store": {
    "member_id": "M_00123456"
  },
  "email": {
    "email_hash": "sha256(user@example.com + salt)"
  }
}
```

---

## 3. 紐づけトリガー

### 3.1 Web → LINE

```
チャットウィジェット内の「LINEで続ける」ボタン
  → LINE ログイン OAuth 起動
  → 認可後: line_user_id を取得
  → visitor_profiles.channel_ids['line'] に追記
  → LINE 側でもセッション継続
```

**UI 配置:** チャット終了時または「相談の続きはLINEで」促進メッセージに表示

### 3.2 Web → 電話

```
チャットウィジェット内の「電話で相談」ボタン
  → テナントの電話番号を表示 + 入力フォーム（任意）
  → ユーザーが電話番号を入力した場合:
     SHA-256(電話番号 + tenant_salt) → phone_hash を生成
     visitor_profiles.channel_ids['phone'] に追記
```

### 3.3 Web → 実店舗

**方法 A: 会員カード番号入力**
```
チャットウィジェット内の「会員証を持っている方はこちら」
  → 会員番号入力フォーム
  → member_id を channel_ids に追記
```

**方法 B: QR コードスキャン**
```
店舗で QR コードを提示 → スキャン → 店舗アプリが unified_visitor_id を取得
```

---

## 4. データベーススキーマ

### 4.1 visitor_profiles テーブル拡張

```sql
-- 将来マイグレーション（docs/migrations/cross_channel_id.sql）
ALTER TABLE visitor_profiles
  ADD COLUMN unified_visitor_id UUID,
  ADD COLUMN channel_ids JSONB DEFAULT '{}',
  ADD COLUMN first_channel TEXT DEFAULT 'web',
  ADD COLUMN cross_channel_linked_at TIMESTAMPTZ,
  ADD COLUMN consent_cross_channel BOOLEAN DEFAULT false;

-- unified_visitor_id のユニークインデックス
CREATE UNIQUE INDEX ON visitor_profiles (unified_visitor_id)
  WHERE unified_visitor_id IS NOT NULL;

-- LINE user_id の検索インデックス
CREATE INDEX ON visitor_profiles ((channel_ids->>'line_user_id'));
CREATE INDEX ON visitor_profiles ((channel_ids->>'member_id'));
```

### 4.2 cross_channel_links テーブル（監査用）

```sql
CREATE TABLE cross_channel_links (
  id SERIAL PRIMARY KEY,
  unified_visitor_id UUID NOT NULL REFERENCES visitor_profiles(unified_visitor_id),
  channel TEXT NOT NULL, -- 'line' / 'phone' / 'store' / 'email'
  linked_at TIMESTAMPTZ DEFAULT now(),
  link_method TEXT, -- 'oauth_line' / 'manual_input' / 'qr_scan'
  consent_obtained BOOLEAN DEFAULT false
);
```

---

## 5. プライバシー設計

### 5.1 明示的同意の要求

チャネル統合時に必ず同意を取得:

```
┌──────────────────────────────────────────────────────┐
│ LINE アカウントと紐づけますか？                       │
│                                                      │
│ Web でのチャット履歴を LINE でも引き継ぐことができます。│
│                                                      │
│ 注意: 紐づけ後は LINE のプロフィール情報も              │
│ このサービスで利用されます。                           │
│                                                      │
│              [紐づける] [紐づけない]                  │
└──────────────────────────────────────────────────────┘
```

### 5.2 同意撤回フロー

```
ユーザーが「LINE の紐づけを解除」をリクエスト
  → channel_ids['line'] を JSONB から削除
  → cross_channel_links に解除記録を追加
  → LINE 側の webhookSubscription を無効化
```

```sql
-- 特定チャネルの紐づけ解除
UPDATE visitor_profiles
SET channel_ids = channel_ids - 'line',
    cross_channel_linked_at = CASE
      WHEN channel_ids - 'line' = '{}' THEN NULL
      ELSE cross_channel_linked_at
    END
WHERE unified_visitor_id = $1;
```

### 5.3 データ分離

- `channel_ids` の電話番号・メールはハッシュのみ保存（元値は保持しない）
- LINE の `line_user_id` は PII のため暗号化保存（`KNOWLEDGE_ENCRYPTION_KEY` で AES 暗号化）

---

## 6. クロスチャネル分析クエリ

### 6.1 チャネル別転換率

```sql
SELECT
  first_channel,
  COUNT(*) AS visitor_count,
  COUNT(CASE WHEN jsonb_array_length(channel_ids::jsonb) > 1 THEN 1 END) AS cross_channel_count,
  COUNT(ca.id) AS converted_count,
  ROUND(COUNT(ca.id)::NUMERIC / COUNT(*), 4) AS conversion_rate
FROM visitor_profiles vp
LEFT JOIN conversion_attributions ca ON ca.visitor_id = vp.visitor_id
GROUP BY first_channel;
```

### 6.2 チャネル紐づけ後の転換率向上効果

```sql
-- 紐づけありと紐づけなしの転換率比較
SELECT
  CASE WHEN cross_channel_linked_at IS NOT NULL THEN 'cross_channel' ELSE 'single_channel' END AS segment,
  ROUND(COUNT(ca.id)::NUMERIC / COUNT(vp.id), 4) AS conversion_rate
FROM visitor_profiles vp
LEFT JOIN conversion_attributions ca ON ca.visitor_id = vp.visitor_id
GROUP BY 1;
```

---

## 7. チャネル別実装優先度

| チャネル | 優先度 | 理由 | 実装時期 |
|---|---|---|---|
| LINE | **P1** | 国内 DAU 9500万人、中古車/不動産で一般的 | 2027 H2 |
| メール | P2 | 既存の顧客データと統合容易 | 2027 H2 |
| 電話 | P2 | 中古車・不動産で重要なチャネル | 2028 Q1 |
| 実店舗 | P3 | 会員番号連携が必要 | 2028 H2 |

---

## 8. LINE 連携の詳細設計

### 8.1 LINE Login OAuth フロー

```
1. Widget 内「LINE で続ける」ボタン → LINE Login URL にリダイレクト
2. LINE 認証 → code パラメータ付きでコールバック
3. POST /api/line/auth { code } → access_token + line_user_id 取得
4. visitor_profiles.channel_ids にLINE情報を追記
5. LINE Messaging API で「Web の会話を引き継ぎました」メッセージ送信
```

### 8.2 LINE Webhook 受信

```typescript
// src/api/line/webhook.ts（将来実装）
router.post('/line/webhook', async (req, res) => {
  const { events } = req.body;
  for (const event of events) {
    if (event.type === 'message') {
      // line_user_id から unified_visitor_id を逆引き
      const visitor = await getVisitorByLineId(event.source.userId);
      // 既存のチャットコンテキストを引き継いでダイアログを継続
      await continueDialog(visitor.unified_visitor_id, event.message.text);
    }
  }
  res.json({ status: 'ok' });
});
```

---

*関連ドキュメント: DATA_RETENTION_POLICY.md / ANONYMIZATION_PIPELINE_DESIGN.md*
