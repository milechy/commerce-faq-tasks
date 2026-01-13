

# Rule-based Planner 仕様（Phase12確定版）

## 🎯 目的
LLM Planner の呼び出しを最小化し、  
高速・安定・予測可能な Clarify → Fallback を実現する。

Phase12 では以下の intent に対応した：

- shipping
- returns
- product-info

---

# 1. intentHint によるルート分岐

以下の intent の場合のみ Rule-based Planner を実行する：

| intentHint | 対応 | 説明 |
|------------|------|------|
| shipping | 対応 | 商品×地域 |
| returns | 対応 | 注文ID×商品×理由 |
| product-info | 対応 | 商品×観点 |
| others | 対応しない | nullを返す（→ LLM Plannerへ） |

---

# 2. shipping の missing 判定

### 入力フィールド
- `product`
- `region`

### missing条件と Clarify 質問
```
missing.product → 「どの商品（またはカテゴリ）についての配送・送料を知りたいですか？」
missing.region → 「お届け先の都道府県（または国）を教えてください。」
```

### 両方揃っている → fallback  
→ Rule-based Planner は **null** を返し、LLM Planner に渡す。

---

# 3. returns の missing 判定

### 入力フィールド
- `orderId`
- `item`
- `reason`

### Clarify 質問
```
orderId: ご注文番号を教えていただけますか？
item: 返品したい商品の名前または型番（SKU）を教えてください。
reason: 返品を希望される理由（サイズ違い・イメージ違い・不良品など）を教えてください。
```

### 全部揃っている → fallback  
→ Rule-based Planner は **null** を返す。

---

# 4. product-info の missing 判定

### 入力フィールド
- `product`
- `aspect`（サイズ感 / 色 / 在庫 / 素材など）

### Clarify 質問
```
product: どの商品についてのご質問でしょうか？（商品名や型番を教えてください）
aspect: どのような点について知りたいですか？（サイズ感・色・素材など）
```

### 両方揃っている → fallback  
→ Rule-based Planner は **null** を返す。

---

# 5. Rule-based Planner の返却形式

missing が存在する場合は：

```
{
  needsClarification: true,
  clarifyingQuestions: [...],
  steps: [],
  followupQueries: [],
  confidence: "low",
  language: "ja",
  raw: {
    intentHint,
    ruleBased: true,
    missing: { ... }
  }
}
```

missing がない場合は：

```
null
```

---

# 6. ログ出力（必須）
```
dialog.planner.rule-based
  intentHint
  route=20b
  reasons=["rule-based:shipping"]
```

---

# 7. 今後の拡張（Phase14〜）
英会話教材版では：
- level_diagnosis
- goal_setting
- compare_course

などに拡張し、Notion DB から Clarify を読み込む構造になる。