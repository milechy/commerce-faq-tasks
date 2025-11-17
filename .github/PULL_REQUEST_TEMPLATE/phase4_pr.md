

# Phase4 PR — Agent Orchestration / Safety / Performance

この PR は **Phase4（Agent Orchestration & Performance）** に関連する変更を含みます。

---

## 1. 変更概要（Summary）

### この PR でやったこと
- [ ] LangGraph Orchestrator の導入 / 修正
- [ ] Planner（Groq 20B/120B）のルーティング調整
- [ ] Safety / requiresSafeMode のロジック変更
- [ ] RAG Search（ES + pgvector + Cross-encoder）の挙動変更
- [ ] Fast-path（Planner スキップ）の挙動変更
- [ ] 長期履歴 summary / context budget の変更
- [ ] /agent.dialog レスポンス / ログフォーマットの変更
- [ ] スクリプト / テスト（SCRIPTS/*.js）の追加・更新
- [ ] ドキュメント（ARCHITECTURE.md / AGENTS.md / PHASE4_SUMMARY.md）の更新
- [ ] その他（下に記載）

### 変更の要約
（1〜3行程度で簡潔に）

---

## 2. 影響範囲（Impact）

### API / 互換性
- [ ] `/agent.dialog` の **入出力スキーマは変更していない**（後方互換）
- [ ] レスポンスに **フィールド追加のみ**（既存クライアントは動作継続）
- [ ] Breaking Change の可能性あり（下に詳細を記載）

### 性能・リソース
- [ ] LLM 呼び出し回数に変化あり（増減）
- [ ] Groq 側 TPM / RPM に影響あり
- [ ] DB / Elasticsearch 負荷に影響あり
- [ ] Cross-encoder の負荷に影響あり

---

## 3. 動作確認（How to Test）

### 基本テスト
```bash
# TypeScript ビルド
npm run build

# サーバー起動
npm start

# 対話エージェント動作確認
node SCRIPTS/testDialogScenarios.js
```

### ロードテスト（任意）
```bash
# /agent.dialog の p50 / p95 チェック
node SCRIPTS/loadTestDialogGraph.js
```

### テスト観点
- [ ] Clarify → Follow-up → Search → Answer の一連の流れが動作する
- [ ] safety モード（暴力/虐待など）で 120B + 慎重回答になる
- [ ] Fast-path（2ターン目 shipping など）で Planner がスキップされる
- [ ] Phase3 相当の RAG 検索結果と大きく乖離していない

---

## 4. ログ / メトリクス確認

### /agent.dialog ログ（pino）
- [ ] `durationMs` が出ている
- [ ] `route`（20b/120b）が出ている
- [ ] `plannerReasons` が付与されている
- [ ] `safetyTag` / `requiresSafeMode` が期待どおり
- [ ] `orchestratorMode` が `langgraph` もしくは `local` として出ている

### Groq エラー / fallback
- [ ] rate limit / API エラー時に `meta.langgraphError` が埋まる
- [ ] fallback（local dialogAgent）に切り替わることを確認

---

## 5. 性能（Performance）

テスト結果（例）:

```text
count = XX
min   = XXXX ms
p50   = XXXX ms
p95   = XXXX ms
max   = XXXX ms
```

- [ ] Clarify（1ターン目）: 1.7〜2.7s 程度
- [ ] Followup fast-path: 1.3〜1.8s 程度
- [ ] Safety（120B）は 2.7〜4.0s 程度
- [ ] fallback(local) は 3.0〜3.8s 程度

（※ 大きく外れる場合はコメントで理由や前提条件を明記してください）

---

## 6. Regression / 既存機能への影響

- [ ] Phase3 相当のシナリオ（送料 / 返品 / 決済 / 在庫）が破綻していない
- [ ] Phase3 と比較して回答品質が極端に劣化していない
- [ ] 既存の API クライアント（フロントエンドなど）が動作する

必要に応じて、Phase3 時点の挙動との差分をコメントで説明してください。

---

## 7. リスク / 注意点

- Groq のレートリミット（TPM/RPM）に近づく可能性
- 120B 使用量の増加（費用面）
- fallback が頻発した場合の p95 劣化

その他あれば記載：

---

## 8. レビュワー向けメモ

（レビュワーに見てほしいポイント / 設計意図 / TODO などあれば）

---

## 9. チェックリスト（最後に）

- [ ] ローカルでビルド & テストを実行済み
- [ ] 変更点を PHASE4_SUMMARY.md / ARCHITECTURE.md / AGENTS.md に反映済み
- [ ] Phase4 Review Issue へのリンクをコメントに貼った
- [ ] マージ後の運用上の注意点を共有済み（必要に応じて）