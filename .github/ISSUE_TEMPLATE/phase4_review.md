

# Phase4 Review Checklist — Agent Orchestration / Safety / Performance

この Issue は **Phase4 の最終レビュー & マージ判定** に使用します。  
レビュー対象は、Orchestrator（LangGraph）、Routing（20B/120B）、Safety、RAG Search、性能、ログの全領域です。

---

## 1. 機能レビュー（Architecture）

### □ Orchestrator（LangGraph）
- [ ] ContextBuilder（RAG + summary）が動作している
- [ ] Planner Node（20B/120B）が Clarify / Search / Answer を生成
- [ ] Decision Router が正しくステップ分岐している
- [ ] Answer Node が短文テンプレ & safety トーン反映

### □ Safety / Routing
- [ ] safetyTag / requiresSafeMode が入力に応じて正しく設定
- [ ] safety=true のとき 120B に昇格
- [ ] plannerReasons に根拠が記録されている
- [ ] 暴力 / 違法 / 虐待 / 自殺 などで慎重回答になる

### □ Fast-path（Planner スキップ）
- [ ] history>0 & intent 判定により Planner が省略される
- [ ] 2ターン目のレイテンシが短縮（1.3〜1.8s）
- [ ] safety が true の場合は無効

### □ Summary（長期履歴）
- [ ] history が長い場合 summary が生成される
- [ ] summary + 直近2ターンのみを使用
- [ ] context budget が 1500〜1600 tokens に収まっている

---

## 2. RAG / Search Integration

### □ Phase3 RAG
- [ ] hybridSearch（ES + pgvector + re-rank）が利用されている
- [ ] Planner の Search ステップが RAG に接続されている
- [ ] 検索結果が Answer Node に正しく渡る

---

## 3. ログ / 観測性

### □ `/agent.dialog` ログ
- [ ] durationMs が記録される
- [ ] route（20b/120b）
- [ ] plannerReasons
- [ ] safetyTag / requiresSafeMode
- [ ] orchestratorMode（langgraph/local）
- [ ] ragContext（recall）  

### □ エラー時
- [ ] fallback local agent を正しく記録
- [ ] Groq エラー（429 など）を meta.langgraphError に記録

---

## 4. 性能（p50 / p95）

### テストコマンド
```
node SCRIPTS/loadTestDialogGraph.js
```

### □ 代表値
- [ ] Clarify（1ターン目）: **1.7〜2.7s**
- [ ] Followup fast-path: **1.3〜1.8s**
- [ ] Safety（120B）: **2.7〜4.0s**
- [ ] 全体 p95 ≈ **3.6s**
- [ ] fallback(local) は 3.0〜3.8s の範囲

### □ 性能結果の貼り付け
```
p50:
p95:
max:
fallback_count:
```

---

## 5. Regression チェック（Phase3 → Phase4）

- [ ] 既存の Clarify / Search / Answer の挙動が壊れていない
- [ ] Phase3 の API 互換性（入出力 schema）が維持されている
- [ ] /agent.dialog のレスポンス構造が後方互換を保つ

---

## 6. マージ可否

- [ ] LGTM（開発）
- [ ] LGTM（レビュー）
- [ ] Safety / Legal チーム確認（任意）
- [ ] 本番 / staging 反映後テスト済み

---

## 備考・メモ
（自由記述）