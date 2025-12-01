

# TUNING_TEMPLATES_SPEC.md

AI 営業（Clarify / Propose / Recommend / Close）のテンプレートを外部化するための仕様。

## データモデル（Notion）

TuningTemplates DB の 1 行は以下のプロパティを持つ：

| プロパティ名 | 型 | 説明 |
|--------------|------|------|
| `Phase` | select | Clarify / Propose / Recommend / Close |
| `Intent` | text | intent slug（例：level_diagnosis） |
| `PersonaTags` | multi_select | ["初心者", "社会人"] 等 |
| `Template` | rich_text | 実際に返す文章 |

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
