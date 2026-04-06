# PageIndex 評価

**作成日:** 2026-04-06
**ステータス:** 評価済み（実装は低優先度）
**結論:** Phase55-58 の行動データ基盤が先。テナント要望があれば着手。

---

## 1. PageIndex とは

### 1.1 定義

Web サイトのページ構造（URL 階層、内部リンク、コンテンツタイプ）をインデックス化する技術・概念。

**主な手法:**
- `sitemap.xml` パース → ページ URL リスト生成
- クローリングベースのページマップ作成
- JSON-LD / Open Graph / meta タグからのコンテンツ分類
- 内部リンク構造の解析（どのページからどのページへリンクしているか）

### 1.2 代表的なユースケース

- SEO 最適化: インデックスされていないページの発見
- コンテンツ戦略: ページカテゴリ別の閲覧動向分析
- RAG 強化: ページコンテキストを AI チャットに注入

---

## 2. R2C への適用可能性

### 2.1 ユースケース A: ページカテゴリ別 FAQ 最適化

```
訪問者がいる URL: /cars/toyota/prius/2023
  ↓ PageIndex でカテゴリ分類
  → category: "product_detail", sub_category: "used_car_toyota"
  ↓ チャットウィジェットのコンテキスト注入
  → "プリウスについてお調べですか？よくある質問: ..."
```

**効果:** ページコンテキストを理解したより精度の高い初回メッセージ

### 2.2 ユースケース B: behavioral_events との組み合わせ

```
behavioral_events.page_url: "/cars/toyota/prius/2023"
  ↓ pageindex でカテゴリ付与
  → { page_category: "product_detail", brand: "toyota", model: "prius" }
  ↓ 集計
  → 「プリウス詳細ページ閲覧後の転換率は35%（全体平均 3.4%の10倍）」
```

### 2.3 ユースケース C: RAG クエリの改善

```
ユーザーメッセージ: "このクルマについて教えて"
  ↓ ページコンテキストなしの場合
  → 曖昧なクエリ → 汎用的な回答

  ↓ PageIndex コンテキストありの場合
  → 「このクルマ = プリウス (2023年式)」と解釈
  → より精度の高い FAQ 検索
```

---

## 3. 実装アプローチ候補

### 3.1 アプローチ A: テナントが sitemap.xml を提供

**フロー:**
```
テナントが sitemap.xml URL を Admin UI で登録
  → バックグラウンドでクローリング（日次更新）
  → page_categories テーブルに URL → カテゴリ のマッピングを保存
```

**メリット:** テナント側の作業最小（sitemap.xml はほぼ全サイトが持つ）
**デメリット:** テナントのサイト構造を推測する必要がある

### 3.2 アプローチ B: widget.js がページ情報を自動収集

**フロー:**
```javascript
// widget.js 内での自動収集
const pageContext = {
  url: window.location.href,
  title: document.title,
  description: document.querySelector('meta[name="description"]')?.content,
  ogType: document.querySelector('meta[property="og:type"]')?.content,
  jsonLd: JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent || '{}'),
  h1: document.querySelector('h1')?.textContent,
};
// チャット開始時に API に送信
```

**メリット:** テナント側作業ゼロ、リアルタイム
**デメリット:** widget.js のサイズ増加、ページ構造が読み取れないケースあり

### 3.3 アプローチ C: テナントが Admin UI でページカテゴリを手動設定

**フロー:**
```
Admin UI の「ページ設定」画面
  → URL パターン登録: `/cars/**` → category: "product_detail"
  → `/cart/**` → category: "checkout"
```

**メリット:** 最も正確なカテゴリ分類
**デメリット:** テナントの手動作業が必要

---

## 4. page_categories テーブル設計

```sql
-- 将来実装用スキーマ
CREATE TABLE page_categories (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  url_pattern TEXT NOT NULL, -- glob パターン: /cars/**, /cart
  category TEXT NOT NULL,    -- product_detail / listing / cart / checkout / lp / other
  sub_category TEXT,         -- brand / model など業種別サブカテゴリ
  priority INTEGER DEFAULT 0, -- パターンマッチの優先順位（高いほど先にマッチ）
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, url_pattern)
);

-- behavioral_events へのカテゴリ付与ビュー
CREATE VIEW behavioral_events_categorized AS
SELECT
  be.*,
  pc.category AS page_category,
  pc.sub_category AS page_sub_category
FROM behavioral_events be
LEFT JOIN LATERAL (
  SELECT category, sub_category
  FROM page_categories pc
  WHERE pc.tenant_id = be.tenant_id
    AND be.page_url LIKE replace(pc.url_pattern, '**', '%')
  ORDER BY pc.priority DESC
  LIMIT 1
) pc ON true;
```

---

## 5. 評価と結論

### 5.1 メリット

| メリット | 重要度 |
|---|---|
| ページコンテキスト理解によるチャット精度向上 | 中 |
| 行動データの意味付け（URL → カテゴリ） | 中 |
| ファネル分析の精度向上 | 中 |
| テナントの LP 最適化支援 | 低 |

### 5.2 デメリット・課題

| 課題 | 重大度 |
|---|---|
| テナントのサイト構造が多様で汎化が難しい | 高 |
| sitemap.xml がない or 不完全なテナントの対応 | 中 |
| クローリングによるサーバー負荷（テナント側） | 中 |
| widget.js のサイズ増加（ユーザー体験への影響） | 中 |

### 5.3 結論

**現時点では実装しない。**

理由:
1. **Phase55-58 の行動データ基盤（conversion_attributions、behavioral_events）が優先** — PageIndex は行動データの「意味付け」を改善するが、まず行動データ自体の収集を安定させる必要がある
2. **テナント多様性の問題** — 中古車、美容室、EC など業種ごとにサイト構造が大きく異なり、汎用的な実装が困難
3. **テナント要望が出たら着手** — 特定テナントからの強い要望があれば、アプローチ C（手動設定）から始める

**代替案（短期）:** `behavioral_events.page_url` から正規表現でカテゴリを推論するシンプルなルールエンジンをテナント管理 UI に追加（PageIndex の軽量版）

---

## 6. 関連技術の参考実装

- [sitemap-stream-parser](https://github.com/nicktacular/node-sitemap-stream-parser) — Node.js での sitemap.xml パース
- [crawlee](https://crawlee.dev/) — クローリングフレームワーク（Node.js）
- Schema.org JSON-LD — 商品ページの構造化データ標準
- [Google Search Console API](https://developers.google.com/webmaster-tools) — ページインデックス状況の取得

---

*関連ドキュメント: PHASE_ROADMAP.md（Phase55-58）*
