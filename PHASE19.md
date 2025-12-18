# Phase19 — Launch UI + CE Visibility + Partner Verification

## Phase Goal (One Sentence)

Phase19 のゴールは、**クライアント導入前に「Sales 回答が業務で使えるか」を人間が評価できるローンチ最小 UI と、CE の挙動可視化を完成**させること。

---

## A / B / C（Phase19 でやることはこれ）

### A. Launch UI（最小ローンチ UI）

- `/ui/` で Query → Answer を叩ける
- metadata を必ず表示できる（CE/flags/rerankEngine）

### B. Partner Verification（人間検証の導線）

- パートナーが “普段の聞き方” で質問できる
- Yes/No チェック + 「一言フィードバック」を残せる

### C. CE Observability（CE 可視化 & 失敗時の透明性）

- `/ce/status` が UI/運用で使える
- `/ce/warmup` の結果が UI/運用で確認できる
- CE が落ちた/スキップされた/フォールバックした、が隠れない

---

## Definition of Done（完了条件）

### UI

- [ ] `http://localhost:3100/ui/`（または `/ui/`）にアクセス可能
- [ ] Query 入力 → 回答表示が動作
- [ ] metadata panel に以下が表示される：
  - [ ] `meta.ragStats.rerankEngine`
  - [ ] `ce_ms`
  - [ ] `meta.flags`
- [ ] Evidence（上位 FAQ）を表示できる（推奨）

### Partner 検証

- [ ] チェックリスト（Yes/No）が UI に存在
- [ ] 「一言フィードバック」を残す導線が存在（暫定実装 OK）

### CE

- [ ] `/ce/status` が JSON を返す
- [ ] `/ce/warmup` が JSON を返す
- [ ] `search.v1` が `ce:active/ce:skipped` を flags に反映する
- [ ] CE 失敗時に `rerankEngine` が `ce+fallback` 等で識別できる

---

## Constraints（Phase19 で守ること）

- Phase19 は「検証 UI」であり、UX 改善やオシャレ UI は不要。
- **見えない最適化は禁止**（CE/フォールバック/根拠が隠れるのは NG）。
- フェーズ外（課金、クライアント別 UI、ダッシュボード等）には着手しない。

---

## Edit Discipline（必須ルール）

### “編集前宣言”ルール

コード/ドキュメントを編集する前に、必ず次を宣言する：

1. 変更対象ファイル
2. 変更理由（Phase19 のどの完了条件に効くか）
3. 影響範囲（UI/CE/API/テスト）

---

## Primary Files（Phase19 の主戦場）

- `public/ui/index.html`
- `src/index.ts`
- `src/agent/http/agentSearchRoute.ts`
- `src/search/rerank.ts`
- `src/search/ceEngine.ts`
- `src/search/ceApi.test.ts`
- `src/search/rerank.ce.test.ts`

---

## Non-Goals（Phase19 ではやらない）

- 課金（クライアント課金/利用量課金/請求 UI）
- エラー通知（Slack 等の通知導線）
- クライアント別の高度カスタム UI
- 分析ダッシュボード/管理画面強化
- 多段会話 UI（履歴/スレッド/チャット UI）

---

## Verification Commands（手動確認）

```bash
# UI
open http://localhost:3100/ui/

# CE
curl -sS http://localhost:3100/ce/status | jq
curl -sS -X POST http://localhost:3100/ce/warmup | jq

# Search
curl -sS -X POST http://localhost:3100/search.v1 \
  -H "Content-Type: application/json" \
  -d '{"q":"初期不良 送料 負担"}' \
| jq '{engine:.engine, flags:.meta.flags, ce_ms:.ce_ms, rerankEngine:.meta.ragStats.rerankEngine}'
```
