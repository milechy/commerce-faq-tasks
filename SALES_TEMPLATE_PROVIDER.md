

# SALES_TEMPLATE_PROVIDER.md

Sales Template Provider の仕様。

## 目的

Notion（TuningTemplates）をテンプレの唯一の真実のソース（SSOT）にし、  
AI 営業は `getSalesTemplate()` だけでテンプレを取得できるようにする。

## 登場コンポーネント

### registerNotionSalesTemplateProvider
Notion から同期したテンプレを Provider として登録。

### getSalesTemplate(options)

```
getSalesTemplate({
  phase: "clarify",
  intent: "level_diagnosis",
  personaTags: ["初心者"]
});
```

戻り値：テンプレ or null

## マッチング仕様

1. phase（case-insensitive）
2. intent（完全一致）
3. personaTags の一致度による順位付け

## フォールバック

Clarify に関しては buildClarifyPrompt が fallback 文面を持つ。  
Propose/Recommend/Close は Phase14 で fallback 実装予定。
