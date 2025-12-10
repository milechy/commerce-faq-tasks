# TUNING_TEMPLATES_SPEC.md

AI 営業（Clarify / Propose / Recommend / Close）のテンプレートを外部化するための仕様。

## データモデル（Notion）

TuningTemplates DB の 1 行は以下のプロパティを持つ：

| プロパティ名  | 型           | 説明                                  |
| ------------- | ------------ | ------------------------------------- |
| `Phase`       | select       | Clarify / Propose / Recommend / Close |
| `Intent`      | text         | intent slug（例：level_diagnosis）    |
| `PersonaTags` | multi_select | ["初心者", "社会人"] 等               |
| `Template`    | rich_text    | 実際に返す文章                        |

### Phase の意味

- Clarify：初期質問生成（例：レベル診断）
- Propose：提案文
- Recommend：比較・上位版案内
- Close：CTA（無料体験誘導）

## 読み込みフロー

起動時:

1. NotionSyncService が TuningTemplates を取得
2. Repository に保存
3. `registerNotionSalesTemplateProvider()` に mapped templates を渡す
4. SalesTemplateProvider が `getSalesTemplate()` を解決可能になる

## マッチングロジック

`getSalesTemplate({ phase, intent, personaTags })`:

1. phase を case-insensitive で一致させる
2. intent が一致するテンプレがあれば優先
3. personaTags は部分一致でスコアリング
4. 最終的に最適テンプレを返す（fallback なしの場合 null）

## 使用例

```
const tmpl = getSalesTemplate({
  phase: "clarify",
  intent: "level_diagnosis",
  personaTags: ["初心者"]
});
```

---

## Propose Phase — Intent / Template Spec (Phase14)

英会話領域の SalesFlow 強化に伴い、Propose フェーズ向けに以下の intent を追加する。

### 意図一覧（ProposeIntent）

| Intent slug                    | 用途                 | 説明                                                 |
| ------------------------------ | -------------------- | ---------------------------------------------------- |
| `trial_lesson_offer`           | 初回提案             | 体験レッスンを案内するための提案文                   |
| `propose_monthly_plan_basic`   | プラン提案（初級）   | 週 1〜2 回・無理なく続けられるベーシックプランの案内 |
| `propose_monthly_plan_premium` | プラン提案（集中的） | 週 3〜5 回の短期集中・手厚いフィードバックプラン案内 |
| `propose_subscription_upgrade` | 既存ユーザー向け提案 | 現行プランから一つ上のプランへのアップグレード提案   |

### Notion TuningTemplates に登録する例

| Phase   | Intent                         | PersonaTags         | Template（例）                               |
| ------- | ------------------------------ | ------------------- | -------------------------------------------- |
| Propose | `trial_lesson_offer`           | ["beginner"]        | 「一度体験レッスンを受けてみませんか？」など |
| Propose | `propose_monthly_plan_basic`   | ["beginner","busy"] | ベーシックプランの案内文                     |
| Propose | `propose_monthly_plan_premium` | ["business"]        | プレミアムプランの案内文                     |
| Propose | `propose_subscription_upgrade` | ["existing_user"]   | アップグレード提案文                         |

### 運用ルール

- Intent の slug は **`docs/INTENT_TAXONOMY_SALES_EN.md`** に定義されたものを使用する。
- PersonaTags は任意で、Notion 側とアプリ側で文字列一致する必要がある。
- Template は基本的に **LLM に渡す最終文面** を想定し、改行・箇条書きを含んでよい。

---
