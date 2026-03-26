# Phase47 OpenViking知識基盤 導入検討レポート

作成日: 2026-03-26
担当: Stream C (wyr15943)
ブランチ: feature/stream-c-phase47-openviking-research

---

## 1. OpenVikingの概要と主要機能

### 概要

**OpenViking** はByteDance Volcano Engineチームが2026年1月にオープンソース化した**コンテキストデータベース**。
従来のフラットなベクトルDB（"ベクトルスープ"問題）を解決し、AIエージェントの記憶・リソース・スキルを**ファイルシステム型の階層構造**で管理する。

- **リポジトリ**: https://github.com/volcengine/OpenViking
- **ライセンス**: Apache 2.0（商用利用可、無料）
- **バージョン**: v0.1.x（2026年3月時点・早期段階）

### 階層コンテキスト設計（L0 → L1 → L2）

```
book/
├── L0: 原則名 + 1文要約（~100トークン）  ← ベクトル検索・初期フィルタ
├── L1: 状況・例・禁忌の概要（~1,000-2,000トークン）  ← 80-90%のクエリはここで完結
└── L2: フルオリジナルコンテンツ  ← 深い読み込みが必要な場合のみ（レアケース）
```

**プログレッシブロード**: L0で候補を絞り込み → L1で意思決定 → 必要時のみL2をオンデマンドロード

### 公式ベンチマーク（LoCoMo10長距離対話ベンチマーク）

| 指標 | 現行フラットRAG | OpenViking | 改善 |
|---|---|---|---|
| トークン消費 | 24.6M | 2.1M | **91%削減** |
| タスク完了率 | 35.65% | 51.23% | **+43.6%** |

---

## 2. RAJIUCEとの統合ポイント（現行構造との対応表）

### 現行 `faq_embeddings` フラット構造

```sql
-- 現行: 心理学書籍チャンクを1レベルのフラット構造で保存
SELECT metadata->>'principle', metadata->>'situation', metadata->>'example', metadata->>'contraindication'
FROM faq_embeddings
WHERE tenant_id = $1
  AND metadata->>'source' = 'book'
  AND metadata->>'principle' = ANY($2)
LIMIT 3
```

**問題**: 各クエリで全フィールド（situation, example, contraindication）を常に取得 → 不要なトークン消費。

### OpenViking階層構造への対応案

| 現行 | OpenViking L0 | OpenViking L1 | OpenViking L2 |
|---|---|---|---|
| `metadata->>'principle'` | `viking://book/{principle}/summary` (100 tok) | `viking://book/{principle}/overview` (1,000 tok) | `viking://book/{principle}/detail` (full) |
| 用途 | 原則存在確認・類似検索 | 状況判断・AIへのコンテキスト供給 | 深い解釈が必要な場合 |
| 取得頻度 | 全クエリ | 80-90%のクエリ | 5-10%（複雑な反論等） |

### 統合ポイント1: 書籍チャンクの階層化

```typescript
// src/agent/psychology/principleSearch.ts
// 現行: フラット取得（全フィールド常時ロード）
// OpenViking案: L0で絞り込み → L1で補完 → 必要時L2
```

**対象ファイル**: `src/agent/psychology/principleSearch.ts`
**改修内容**: `searchPrincipleChunks()` にOpenViking HTTPクライアントを差し込み、Feature Flagで切替可能にする

### 統合ポイント2: ハイブリッド検索のオーケストレーション層

```typescript
// src/search/hybrid.ts
// 現行: ES BM25 + pgvector cosine similarity → rerank
// OpenViking案: OpenViking上位層が階層ナビゲーションを担当し、
//               実際の埋め込みストレージは既存pgvectorを継続利用
```

**対象ファイル**: `src/search/hybrid.ts`
**改修内容**: 心理学書籍チャンクの検索パスをOpenViking経由に切り替え（FAQデータは現行継続）

### 統合ポイント3: Judge評価との連携（将来）

Phase45 Judge評価（`conversation_evaluations.score`）をOpenViking-RL的な報酬信号として活用し、書籍チャンクのL1/L2の優先度を動的に更新する自己改善ループ。
→ **Phase48以降での検討**とする（本Phaseではスコープ外）

---

## 3. 技術的課題とリスク

### 課題1: 言語・ランタイム不一致

| 項目 | RAJIUCE | OpenViking要件 |
|---|---|---|
| 言語 | Node.js / TypeScript | Python 3.10+, Go 1.22+, C++コンパイラ |
| 接続方法 | 直接ライブラリ呼び出し | HTTP API経由（Python SDKは直接使用不可） |

**対策**: OpenViking を独立プロセス（HTTP API モード）で起動し、Node.js TypeScript アダプタ経由で接続。Hetzner VPS上で追加プロセスとして管理（PM2）。

### 課題2: v0.1.x 早期段階

- API仕様が変更される可能性
- 既存pgvector/ESとの明示的な統合ガイド未整備

**対策**: Feature Flag (`OPENVIKING_ENABLED=1`) でON/OFF可能にし、フォールバックを現行実装に向ける。

### 課題3: データ移行

- 現行 `faq_embeddings` の書籍チャンクをOpenViking形式（L0/L1/L2）に変換するETLスクリプトが必要
- 心理学原則7種 × 3階層 = 21レコードの変換（小規模なので管理可能）

### 課題4: ベクトル化コスト

- OpenVikingはEmbedding Model API（OpenAIなど）を外部依存として要求
- **対策**: 現行Groq APIをそのまま使用。OpenAI互換APIとして設定可能か要確認。

---

## 4. コスト試算（月$27-48制約との整合性）

| コスト項目 | 現行 | OpenViking導入後 | 差分 |
|---|---|---|---|
| OpenViking本体 | - | $0（Apache 2.0 無料） | $0 |
| Hetzner VPS | 既存 | 同一VPS上で追加プロセス | $0 |
| Embedding API | Groq使用量ベース | 書籍チャンク変換時のみ一回限り | 初回のみ+数$程度 |
| LLM推論（Groq） | トークン全量消費 | L1で80%完結→トークン削減 | **-$3〜-10/月（推定）** |

**判定**: 月$27-48制約の範囲内。むしろLLMトークン削減によりランニングコスト低減が見込める。

---

## 5. ベンチマーク計画（aceda9zeと連携）

### 比較条件

| 条件 | 内容 |
|---|---|
| **(B) 現行** | pgvector + ES ハイブリッド検索（Phase44実装）|
| **(B') OpenViking** | L0→L1→L2 プログレッシブロード + 既存pgvector embedding保持 |

### 計測指標

1. **タスク成功率**: Judge評価（`conversation_evaluations.score`）の平均値（B vs B'）
2. **トークン消費量**: `principleSearch.ts` 経由のRAGコンテキスト文字数
3. **レイテンシ**: `principleSearch` の応答時間（ms）

### テストセット

- aceda9zeが作成する20-50件の営業会話テストセット使用
- テナント: carnation（中古車）限定
- 期間: 2週間

### 成功基準（導入検討基準との対応）

| 基準 | 目標値 | 測定方法 |
|---|---|---|
| タスク成功率 | 現行比 +20%以上 | Judge score平均の比較 |
| トークン削減 | 現行比 50%以上 | RAGコンテキスト文字数比較 |

---

## 6. PoC実装計画（carnation限定2週間テスト）

### フェーズ1: インフラセットアップ（3日）

1. HetznerVPS上にOpenViking HTTP APIサーバーを起動（PM2管理）
2. 書籍チャンクL0/L1/L2変換スクリプト作成（`SCRIPTS/seed-openviking.ts`）
3. 心理学原則7種のコンテキストをOpenVikingにインポート

### フェーズ2: アダプタ実装（3日）

```
src/search/openviking/
├── openVikingClient.ts    # HTTP APIクライアント（Fetch wrapper）
├── openVikingAdapter.ts   # principleSearch互換インタフェース
└── index.ts               # Feature Flag + フォールバック
```

Feature Flag: `OPENVIKING_ENABLED=1` かつ `OPENVIKING_URL=http://localhost:8080`

### フェーズ3: carnationテナント有効化（1日）

```typescript
// src/agent/psychology/principleSearch.ts
const useOpenViking = process.env.OPENVIKING_ENABLED === '1' && tenantId === 'carnation';
```

### フェーズ4: ベンチマーク実施（2週間）

- aceda9zeのテストセットで自動計測
- Judge評価スコアとトークン消費量を日次で記録

### ロールバック手順

1. `OPENVIKING_ENABLED` 環境変数を削除または `0` に設定
2. PM2でOpenVikingプロセスを停止: `pm2 stop openviking`
3. 影響範囲: carnationテナントのprincipleSearch経路のみ → 他テナントは無影響

---

## 7. 総合判定

**判定: 有望 → 段階的導入推奨**

| 観点 | 評価 |
|---|---|
| トークン削減効果 | ★★★★★（公式91%削減、月コスト削減見込み） |
| タスク成功率向上 | ★★★★☆（+43.6%のベンチマーク実績） |
| 導入難易度 | ★★☆☆☆（Python/Go/C++依存、HTTP API経由で解決可能） |
| 安定性リスク | ★★★☆☆（v0.1.x早期段階、Feature Flagで緩和） |
| コスト影響 | ★★★★★（制約内、むしろ削減） |

**推奨アクション**: carnationテナント限定PoCで2週間ベンチマーク後、成功基準達成で全テナント展開。
