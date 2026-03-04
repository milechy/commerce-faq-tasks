

# CLARIFY_FLOW.md

Phase13 の Clarify ロジック仕様。

## 目的

Clarify（不足情報ヒアリング）を外部テンプレで駆動し、AI 営業 Planner の第一ステップとして利用可能にする。

## Intent

Phase13 で扱う ClarifyIntent は次の2つ：

- `level_diagnosis`
- `goal_setting`

## Clarify テンプレ生成フロー

Clarify 質問文は次の優先順で決まる：

1. Notion（TuningTemplates）の Clarify テンプレ
2. fallback（buildClarifyPrompt 内の固定文面）

### buildClarifyPrompt

```
buildClarifyPrompt({
  intent: "level_diagnosis",
  personaTags: ["初心者"]
});
```

返り値：実際の Clarify 用質問文（Notion または fallback）

## デバッグ API

```
POST /sales/debug/clarify
```

入力:

```
{
  "intent": "level_diagnosis",
  "personaTags": ["初心者"]
}
```

出力:

- Notion のテンプレ or fallback 文面

## 将来（Phase14）

- Clarify → Propose へ遷移する Planner を外部化
- intent taxonomy 拡張
- Clarify 回答→スコアリング→コース選択へ接続
