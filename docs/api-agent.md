

# Agent API – `/agent.search`

エンドユーザー（チャット UI 等）から呼ばれる、メインの QA / セールス回答 API。

- メソッド: `POST`
- パス: `/agent.search`
- 認証: `x-api-key` または Basic 認証
- レスポンス: LLM が生成した回答 + RAG のデバッグ情報

## リクエスト

### HTTP ヘッダ

```http
POST /agent.search HTTP/1.1
Host: localhost:3100
Content-Type: application/json
x-api-key: secret-123
```

### ボディ

```json
{
  "q": "送料について教えて",
  "topK": 5,
  "debug": true,
  "useLlmPlanner": false,
  "tenantId": "demo"
}
```

- `q` (string, required)
  - ユーザーの質問文
- `topK` (number, optional, default 5)
  - 何件の候補 FAQ を RAG に使うか
- `debug` (boolean, optional)
  - `true` の場合、`steps` や `ragStats` など詳細情報を返す
- `useLlmPlanner` (boolean, optional)
  - 将来的に LLM ベースの Planner を切り替えるフラグ（現状は rule-based）
- `tenantId` (string, optional)
  - テナント ID。省略時はデフォルトテナント（実装側の既定値）を使用

## レスポンス

典型的なレスポンス例:

```json
{
  "answer": "ご質問\"送料について教えて\"に対して、関連性の高いFAQから要点をまとめました...",
  "steps": [
    {
      "type": "plan",
      "message": "Rule-based Planner で検索クエリを生成しました。",
      "input": { "q": "送料について教えて" },
      "output": {
        "searchQuery": "送料",
        "topK": 5,
        "filters": {
          "category": "shipping",
          "categories": ["shipping"]
        }
      },
      "elapsed_ms": 0
    },
    {
      "type": "tool",
      "tool": "search",
      "message": "ハイブリッド検索（ES + PG）を実行しました。",
      "input": { "query": "送料", "tenantId": "demo" },
      "output": {
        "items": [
          { "id": "CiQSp...", "text": "送料は購入金額が5,000円以上の場合は無料になります。", "score": 0.33, "source": "es" },
          { "id": "12", "text": "当店の送料は全国一律500円です...", "score": 0.43, "source": "pgvector" }
        ],
        "ms": 640,
        "note": "pg_fts:disabled_phase7_use_pgvector | search_ms=640 es_hits=3 pg_hits=0 | pgvector:used | pgvector_ms=1891"
      },
      "elapsed_ms": 650
    },
    {
      "type": "tool",
      "tool": "rerank",
      "message": "上位候補を再ランキングしました (engine=heuristic).",
      "input": { "topK": 5 },
      "output": { "items": [...], "engine": "heuristic" },
      "elapsed_ms": 1
    },
    {
      "type": "synthesis",
      "tool": "synthesis",
      "message": "再ランキングされたFAQから要約応答を生成しました。",
      "input": { "docCount": 5 },
      "output": { "answer": "..." },
      "elapsed_ms": 0
    }
  ],
  "ragStats": {
    "plannerMs": 0,
    "searchMs": 650,
    "rerankMs": 1,
    "answerMs": 0,
    "totalMs": 3800,
    "rerankEngine": "heuristic"
  },
  "debug": {
    "query": { ... },
    "search": { ... },
    "rerank": { ... }
  }
}
```

### フィールド概要

- `answer` (string)
  - LLM が生成した最終回答
- `steps` (array)
  - RAG の内部ステップ（プランニング、検索、再ランキング、要約）
- `ragStats` (object)
  - 所要時間や rerank エンジン名などの統計情報
- `debug` (object, optional)
  - 検索候補など、デバッグ用途の詳細情報

## 認証

### API Key

- サーバー側 `.env` で設定された API キーと一致する必要がある
- ヘッダ名: `x-api-key`

```bash
curl -X POST 'http://localhost:3100/agent.search' \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: secret-123' \
  -d '{
    "q": "送料について教えて",
    "topK": 5,
    "debug": true,
    "useLlmPlanner": false,
    "tenantId": "demo"
  }'
```

### Basic 認証（オプション）

- `.env` に設定された BASIC_USER / BASIC_PASS と突き合わせる実装を想定
- こちらは外部サービス連携などで利用できる

```bash
curl -X POST 'http://localhost:3100/agent.search' \
  -u 'user:pass' \
  -H 'Content-Type: application/json' \
  -d '{ "q": "送料について教えて" }'
```

## 検索パイプラインとの関係

`/agent.search` 自体は **オーケストレーションのエントリーポイント** です。
詳細な検索ロジックは `docs/search-pipeline.md` を参照してください。

- Planner: クエリ正規化、カテゴリ判定、フィルタ生成
- Search Tool: ES + pgvector ハイブリッド検索
- Rerank Tool: 上位候補の並べ替え
- Synthesis Tool: LLM による回答生成