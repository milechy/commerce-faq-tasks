

# CLARIFY_LOG_SPEC.md

Clarify Log → Notion 書き戻し仕様。

## 目的

Clarify（不足情報ヒアリング）が発生した際、その記録を Notion に保存し、  
パートナーが改善サイクルに使えるようにする。

## データモデル（Clarify Log DB）

必要プロパティ：

| プロパティ名 | 型 | 説明 |
|--------------|------|------|
| `Title` | title | 自動生成（Clarify [intent] preview） |
| `Original` | text | 元の質問 |
| `Clarify` | text | Clarify 質問 |
| `Missing` | text | 不足情報メモ |
| `Intent` | text | ClarifyIntent |
| `TenantId` | text | テナント識別子 |

## API

```
POST /integrations/notion/clarify-log
```

### Request

```
{
  "originalQuestion": "...",
  "clarifyQuestion": "...",
  "missingInfo": "...",
  "intent": "level_diagnosis",
  "tenantId": "demo-1"
}
```

### Response

```
{ "ok": true }
```

## Writer 仕様

`ClarifyLogWriter.createLog(input)`：

- Notion ページを作成
- Title は自動生成
- property が存在しない場合は validation_error を返す

## n8n との併用

Clarify Log DB は複数インテグレーションを接続可能。  
Phase13 では `commerce-faq-phase13` を追加接続するだけで n8n を壊さない。
