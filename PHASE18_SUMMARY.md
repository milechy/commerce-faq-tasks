# Phase18 Summary – UI / Cross-Encoder (CE) 実装フェーズ

## 目的

Phase18 は、Phase17 で設計・計測基盤を整えた RAG パイプラインに対して、

- Cross-Encoder (CE) による rerank を「実運用可能な形」で組み込む
- エンジン状態・失敗時フォールバックを API とテストで明確化する
- パートナー検証用に最小 UI（/ui）を提供する

ことを目的としたフェーズである。

本フェーズ終了時点で、本システムは **社内 / 限定公開レベルでのローンチが可能** な状態に到達している。

---

## 実装サマリ

### 1. Cross-Encoder (CE) 実装とエンジン管理

対象ファイル:

- `src/search/ceEngine.ts`
- `src/search/rerank.ts`

#### 対応内容

- CE エンジンを以下のモードで切替可能にした：
  - `dummy`（無効 / テスト用）
  - `onnx`（本番想定）
- 環境変数による制御：
  - `CE_ENGINE`
  - `CE_MODEL_PATH`
  - `CE_VOCAB_PATH`
- ONNX モデルは **明示的 warmup** でロードされる設計とした。

#### ステータス API

- `GET /ce/status`

  ```json
  {
    "onnxLoaded": true,
    "onnxError": null,
    "engine": "onnx"
  }
  ```

- `POST /ce/warmup`
  ```json
  {
    "ok": true,
    "engine": "onnx",
    "model": "/path/to/model.onnx"
  }
  ```

---

### 2. rerank ロジックの安定化（gating / fallback）

対象ファイル:

- `src/search/rerank.ts`

#### 仕様整理

- rerank の実行条件：
  - CE が `onnx` で有効
  - モデルロード成功済み
- 例外発生時：
  - 自動で heuristic にフォールバック
  - `engine = "ce+fallback"` を返却

#### rerank 結果の一貫した出力

```ts
{
  items: RankedItem[],
  engine: "ce" | "ce+fallback" | "heuristic",
  ce_ms: number
}
```

---

### 3. API レスポンス仕様の確定（Phase19 互換）

対象:

- `/search.v1`
- `/agent/search`

#### 決定事項

- **公式 ragStats は `meta.ragStats`**
- top-level `ragStats` は deprecated（互換ヘッダ付きでのみ返却）
- `rerankEngine` を必ず `meta.ragStats` に含める

```jsonc
"meta": {
  "ragStats": {
    "searchMs": 659,
    "rerankMs": 56,
    "totalMs": 715,
    "rerankEngine": "ce"
  },
  "flags": ["v1", "validated", "ce:active"]
}
```

> 補足（Phase19）:
> Phase19 では、診断性向上のため `engine` / `ce_ms` を
> top-level に加えて `meta.engine` / `meta.ce_ms` にも正規化して露出している。
> これは Phase18 の設計を否定するものではなく、
> 実挙動を UI / curl の双方から説明可能にするための過渡的措置である。

---

### 4. CE API ラッパーの整備とテスト

対象ファイル:

- `src/search/ceApi.test.ts`
- `src/search/rerank.ce.test.ts`

#### 内容

- `warmupCE`, `ceStatus` の仕様をテストで固定
- エラー時の engine 表示ルールを明確化
- rerank の CE / fallback / heuristic 分岐をテストで保証

→ Phase18 時点で **CE 関連テストは全件 PASS**。

---

### 5. パートナー検証用 UI の追加

対象ファイル:

- `public/ui/index.html`

#### UI の位置付け

- 本番 UI ではなく **検証専用 UI**
- URL:
  ```
  http://localhost:3100/ui/
  ```
  Phase19 では、この UI を「完成 UI」ではなく、
  `/agent.search` と `/search.v1` の挙動差・メタデータを
  人間が比較診断するための **診断サーフェス**として再定義している。

#### 提供機能

- Query 入力
- Answer 表示
- RAG 動作確認（実質的な blackbox テスト）

→ 「UI がない」状態をあえて避け、  
**パートナーが Query → Answer を即座に試せる** ことを優先。

---

## 動作確認（Phase18 完了状態）

```bash
curl http://localhost:3100/ce/status
curl -X POST http://localhost:3100/ce/warmup
curl -X POST http://localhost:3100/search.v1 -d '{"q":"初期不良 送料 負担"}'
```

結果例:

```json
{
  "engine": "ce",
  "flags": ["v1", "validated", "ce:active"],
  "ce_ms": 106,
  "rerankEngine": "ce"
}
```

---

## フェーズ完了判定

Phase18 は以下を満たして **完了** とする。

- [x] CE (onnx) が warmup → rerank まで実動
- [x] rerank fallback が安全に機能
- [x] ragStats / engine 表示が一貫
- [x] テスト全件 PASS
- [x] パートナーが触れる UI が存在

---

## Phase19 への引き継ぎ

- API / UI の完成ではなく、**実挙動とメタデータの整合・可視化**を最優先する。
- パートナー心理学（PSYCHOLOGY_CORE）を用いた Answer 制御
- UI の「埋め込み前提」設計（AaaS 導入視点）
- フィードバックログ → 設計改善ループの確立

技術的な基盤整備フェーズは Phase18 で完了している。
