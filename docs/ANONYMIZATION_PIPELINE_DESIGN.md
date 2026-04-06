# 匿名化パイプライン設計

**作成日:** 2026-04-06
**ステータス:** 設計のみ（将来実装）
**実装タイムライン:** テナント5社以上で着手（2027 H1 目標）

---

## 1. 目的

クロステナント学習を実現するための前提となる匿名化パイプライン。テナント間でデータを共有するために個人情報（PII）を除去し、業種タグ付きの学習データに変換する。

**ゴール:**
- テナント個別データ → 業種別パターンとして統合
- 競合他社のデータから学習しつつ、PII は一切共有しない
- GDPR / APPI 準拠のデータ取り扱い

---

## 2. PII 除去ルール

### 2.1 識別子のハッシュ化

```
visitor_id → SHA-256(tenant_id || ":" || visitor_id || ":" || salt)
session_id → SHA-256(tenant_id || ":" || session_id || ":" || salt)
```

- `tenant_id` を salt に含めることで、異なるテナント間での同一 visitor のクロス追跡を防止
- 同一テナント内では同一 visitor を時系列で追跡可能（行動分析のため）

### 2.2 メッセージコンテンツの PII マスキング

| PII 種別 | 検出パターン | 処理 |
|---|---|---|
| 電話番号 | `0[0-9]{9,10}` | `[電話番号]` に置換 |
| メールアドレス | RFC 5322 準拠 regex | `[メールアドレス]` に置換 |
| 氏名 | NER (spaCy/GiNZA) で検出 | `[氏名]` に置換 |
| 住所 | 都道府県+市区町村パターン | `[住所]` に置換 |
| クレジットカード番号 | Luhn アルゴリズム | `[カード番号]` に置換 |

### 2.3 その他の除去対象

- IP アドレス: 除去（分析不使用）
- User-Agent: 除去（ブラウザ/OS は別途集計）
- Cookie 識別子: ハッシュ化

---

## 3. 業種タグ付け

### 3.1 tenants テーブル拡張

```sql
-- 将来マイグレーション
ALTER TABLE tenants ADD COLUMN industry TEXT DEFAULT 'other';
ALTER TABLE tenants ADD CONSTRAINT industry_check
  CHECK (industry IN (
    'used_car', 'beauty', 'real_estate', 'ec',
    'restaurant', 'medical', 'education', 'other'
  ));

COMMENT ON COLUMN tenants.industry IS
  '業種区分: used_car/beauty/real_estate/ec/restaurant/medical/education/other';
```

### 3.2 業種マスター

| コード | 業種 | 代表テナント想定 |
|---|---|---|
| `used_car` | 中古車販売 | R2C 初期テナント |
| `beauty` | 美容室/エステ | 近接業種 |
| `real_estate` | 不動産 | 高単価商材 |
| `ec` | EC・通販 | 汎用商品販売 |
| `restaurant` | 飲食/予約 | 予約特化 |
| `medical` | 医療/クリニック | 問診・誘導 |
| `education` | 教育/英会話 | 現行 RAJIUCE 主要業種 |
| `other` | その他 | デフォルト |

---

## 4. パターン集約スキーマ

### 4.1 変換フロー

```
conversion_attributions (個別会話)
  ↓ 匿名化処理
  ↓ PII除去 + visitor_id ハッシュ化
  ↓ 業種タグ付与 (JOIN tenants.industry)
  ↓
anonymized_patterns (中間テーブル)
  ↓ 日次バッチ集計
  ↓
psychology_effectiveness (集約テーブル)
```

### 4.2 anonymized_patterns (中間テーブル)

```sql
CREATE TABLE anonymized_patterns (
  id SERIAL PRIMARY KEY,
  industry TEXT NOT NULL,
  objection_type TEXT,
  psychology_principle TEXT,
  converted BOOLEAN NOT NULL,
  judge_score NUMERIC(5,2),
  temp_score_range TEXT, -- 'low'/'medium'/'high' (0-33/34-66/67-100)
  message_count_range TEXT, -- '1-3'/'4-7'/'8+'
  processed_at TIMESTAMPTZ DEFAULT now(),
  source_date DATE NOT NULL
);

-- visitor_id 等の元識別子は保持しない
```

---

## 5. psychology_effectiveness テーブル設計

```sql
CREATE TABLE psychology_effectiveness (
  id SERIAL PRIMARY KEY,
  psychology_principle TEXT NOT NULL,
  industry TEXT NOT NULL,
  objection_type TEXT,               -- NULL = 業種全体の集計
  sample_count INTEGER NOT NULL DEFAULT 0,
  conversion_rate NUMERIC(5,4),      -- 0.0000 - 1.0000
  avg_judge_score NUMERIC(5,2),      -- 0.00 - 100.00
  avg_temp_score INTEGER,            -- 0 - 100
  confidence_level TEXT DEFAULT 'low', -- low/medium/high (sample_count基準)
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(psychology_principle, industry, COALESCE(objection_type, ''))
);

-- confidence_level の基準
-- low: sample_count < 30
-- medium: 30 <= sample_count < 100
-- high: sample_count >= 100

CREATE INDEX ON psychology_effectiveness (industry, psychology_principle);
CREATE INDEX ON psychology_effectiveness (conversion_rate DESC);
```

---

## 6. バッチ処理フロー

### 6.1 日次バッチ（想定: 毎朝 3:00 JST）

```
1. conversion_attributions から前日データを取得
   SELECT * FROM conversion_attributions
   WHERE created_at >= NOW() - INTERVAL '1 day';

2. PII 除去処理
   - visitor_id ハッシュ化
   - メッセージコンテンツの PII マスク

3. 業種タグ付与
   JOIN tenants ON tenant_id

4. anonymized_patterns に INSERT

5. psychology_effectiveness を UPSERT
   INSERT INTO psychology_effectiveness (...) VALUES (...)
   ON CONFLICT (psychology_principle, industry, ...)
   DO UPDATE SET
     sample_count = psychology_effectiveness.sample_count + EXCLUDED.sample_count,
     conversion_rate = (重み付き平均),
     updated_at = now();
```

### 6.2 48時間ルール

収集したデータは **48時間以内** に LLM コンテキスト（psychology_effectiveness テーブル）に反映する。これにより：
- 最新の市場動向をプロンプトに反映
- データ鮮度と学習速度のバランスを維持

---

## 7. プライバシー設計の原則

### 7.1 データ最小化
- 匿名化後の中間データのみを共有
- 元の会話内容は共有しない
- visitor_id → ハッシュ変換後、元 ID は匿名化テーブルに保存しない

### 7.2 テナント分離
- 各テナントは自社データのみ閲覧可能
- `psychology_effectiveness` への集約後、どのテナントのデータか特定不可

### 7.3 監査ログ
- 匿名化バッチの実行ログを保持（処理件数、エラー件数）
- 個別レコードの処理ログは保持しない（プライバシー保護）

---

## 8. 実装タイムライン

| フェーズ | 条件 | 内容 |
|---|---|---|
| フェーズ A | テナント5社以上 | anonymized_patterns テーブル作成、バッチ処理実装 |
| フェーズ B | テナント10社以上 | psychology_effectiveness 集計、Benchmark API と連携 |
| フェーズ C | テナント20社以上 | 信頼度 high のパターンをプロンプトに自動反映 |

**現在のステータス:** テナント1〜3社 → 設計のみ、実装未着手

---

*関連ドキュメント: BENCHMARK_API_DESIGN.md / DATA_RETENTION_POLICY.md*
