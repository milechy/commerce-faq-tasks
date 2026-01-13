# Phase23: KPI & SLA Definitions

## 目的

Phase22 で確立した「制御可能性」を基盤に、**本番運用レベルの KPI・SLA 定義と計測手順**を標準化する。

Phase23 では新規ランタイム機能を追加せず、**既存ログとスクリプトを活用した軽量な監視フレームワーク**を構築する。

---

## スコープ

### In Scope（実施すること）

- MVP KPI セットの定義と計測式
- SLA ゲート閾値の明文化
- 日次チェック手順の標準化
- インシデント対応フロー（Kill Switch 優先）
- ローカル計測コマンドの整備

### Out of Scope（Phase24 以降）

- リアルタイムダッシュボード構築
- 自動アラート配信（Datadog / PagerDuty 統合）
- 長期トレンド分析・予測モデル
- マルチリージョン対応 SLA
- カスタマーごとの SLA カスタマイズ

---

## MVP KPI セット

### 1. Conversation Completion Rate（会話完了率）

**定義**: 正常完了で終わった会話の割合

**計測式**:

```
Completion Rate = (completed_count / total_terminal_count) × 100
```

**ログソース**:

```bash
# completed: 正常完了
grep 'phase22.flow.terminal_reached' logs/app.log \
  | jq -r 'select(.meta.flow.terminalReason=="completed")' \
  | wc -l

# total_terminal: 全終端
grep 'phase22.flow.terminal_reached' logs/app.log | wc -l
```

**目標値**:

- MVP: ≥ 70%
- 理想: ≥ 85%

**アラート条件**:

- < 60% が 1 時間継続 → Kill Switch 検討

---

### 2. Loop Detection Rate（ループ検出率）

**定義**: ループが検出された会話の割合

**計測式**:

```
Loop Rate = (loop_detected_count / total_terminal_count) × 100
```

**ログソース**:

```bash
# loop_detected
grep 'phase22.flow.loop_detected' logs/app.log | wc -l

# total_terminal
grep 'phase22.flow.terminal_reached' logs/app.log | wc -l
```

**目標値**:

- MVP: < 10%
- 理想: < 5%

**アラート条件**:

- > 15% が 30 分継続 → Kill Switch 発動

---

### 3. Avatar Fallback Rate（アヴァターフォールバック率）

**定義**: アヴァターが要求されたがフォールバックした割合

**計測式**:

```
Fallback Rate = (fallback_count / requested_count) × 100
```

**ログソース**:

```bash
# requested
grep 'phase22.avatar.requested' logs/app.log | wc -l

# fallback + failed + disabled (アヴァター無効化全般)
grep 'phase22.avatar' logs/app.log \
  | jq -r 'select(.event | test("fallback|failed|disabled"))' \
  | wc -l
```

**目標値**:

- MVP: < 30%
- 理想: < 15%

**アラート条件**:

- > 50% が 15 分継続 → Kill Switch 発動
- PII 導線による forced_off は除外（正常動作）

---

### 4. /search Endpoint Latency（検索レイテンシ）

**定義**: `/search` エンドポイントの p95 レイテンシ

**計測式**:

```bash
# logs/perf/*.json からの計測
jq -r '.latency.p95 // .latency.p97_5 // 0' logs/perf/*.json \
  | awk '{sum+=$1; n++} END {print sum/n}'
```

**目標値（MVP）**:

- p95: ≤ 1500ms（本番 SLA）
- p90: ≤ 15ms（CI/CD ゲート、既存値を継承）

**関連メトリクス（app logs）**:

```bash
# dialog.rag.finished から searchMs / rerankMs を抽出
grep 'dialog.rag.finished' logs/app.log \
  | jq -r '[.searchMs, .rerankMs, .totalMs] | @tsv' \
  | awk '{
      sum_search+=$1; sum_rerank+=$2; sum_total+=$3; n++
    } END {
      print "search p50/p95:", sum_search/n;
      print "rerank p50/p95:", sum_rerank/n;
      print "total p50/p95:", sum_total/n
    }'
```

**アラート条件**:

- p95 > 2000ms が 10 分継続 → 調査開始
- p95 > 3000ms → インシデント

**注意**:

- `hybrid_ms` は `/search` の内部メトリクスとして `meta.ragStats.searchMs` にログ出力される
- `searchMs` = ES + pgvector のハイブリッド検索時間
- `rerankMs` = Cross-Encoder 再ランク時間

---

### 5. Timeout / Error Rate（タイムアウト・エラー率）

**定義**: HTTP 5xx エラー、タイムアウト、予期しない例外の割合

**計測式**:

```
Error Rate = (error_count / total_requests) × 100
```

**ログソース**:

```bash
# HTTP 500/503 エラー（Express ログから）
grep '"status":5' logs/app.log | wc -l

# Total requests (dialog.run.start を起点とする)
grep 'dialog.run.start' logs/app.log | wc -l
```

**目標値**:

- MVP: < 1%
- 理想: < 0.5%

**アラート条件**:

- > 3% が 5 分継続 → インシデント
- > 5% → Kill Switch 検討

---

### 6. Kill Switch Activations（Kill Switch 発動回数）

**定義**: 運用による Kill Switch 発動の累積回数

**計測式**:

```bash
# Kill switch による無効化
grep 'phase22.avatar.disabled_by_kill_switch' logs/app.log | wc -l
```

**目標値**:

- MVP: 月次 < 5 回
- 理想: 月次 < 2 回

**トラッキング**:

- 発動理由を必ず記録（`KILL_SWITCH_REASON` 環境変数）
- 発動後 24 時間以内に根本原因を特定

---

## SLA ゲート定義

### デフォルト閾値

| メトリクス          | CI/CD ゲート | 本番 SLA | 備考                   |
| ------------------- | ------------ | -------- | ---------------------- |
| **RPS**             | ≥ 5000       | ≥ 3000   | `/search` ベンチマーク |
| **P90 Latency**     | ≤ 15ms       | ≤ 50ms   | `/search` ベンチマーク |
| **P95 Latency**     | -            | ≤ 1500ms | 本番対話フロー全体     |
| **Error Rate**      | = 0          | < 1%     | HTTP 5xx               |
| **Completion Rate** | -            | ≥ 70%    | 会話終端               |
| **Loop Rate**       | -            | < 10%    | ループ検出             |
| **Fallback Rate**   | -            | < 30%    | アヴァター             |

### リグレッション判定

以下のいずれかに該当する場合、**リグレッション**とみなす：

1. **CI/CD ゲート違反**

   - RPS < 5000 または P90 > 15ms
   - Error > 0

2. **本番 SLA 違反（連続）**

   - P95 > 1500ms が 30 分以上継続
   - Error Rate > 1% が 10 分以上継続
   - Completion Rate < 60% が 1 時間以上継続

3. **緊急停止条件**
   - Loop Rate > 15% が 30 分継続
   - Fallback Rate > 50% が 15 分継続
   - Error Rate > 5% が 5 分継続

---

## 運用キャデンス

### 日次 5 分チェック（推奨）

**朝会前チェック（5 分）**:

```bash
# 1. 前日の会話完了率
echo "=== Completion Rate (last 24h) ==="
grep 'phase22.flow.terminal_reached' logs/app.log \
  | jq -r '.meta.flow.terminalReason' \
  | sort | uniq -c

# 2. ループ検出
echo "=== Loop Detection ==="
grep 'phase22.flow.loop_detected' logs/app.log | wc -l

# 3. アヴァター状態
echo "=== Avatar Status ==="
grep 'phase22.avatar' logs/app.log \
  | jq -r '.event' | sort | uniq -c

# 4. 最新 perf ログ
echo "=== Latest Perf ==="
pnpm run perf:report

# 5. Kill Switch 状態
echo "=== Kill Switch ==="
echo "KILL_SWITCH_AVATAR=${KILL_SWITCH_AVATAR:-false}"
echo "KILL_SWITCH_REASON=${KILL_SWITCH_REASON:-none}"
```

**週次レビュー（30 分）**:

- Perf summary の推移確認: `pnpm run perf:summary`
- Loop / Fallback の根本原因分析
- Kill Switch 発動履歴のレビュー

---

## インシデント対応フロー

### Phase22 原則: Kill Switch First

インシデント発生時は、**まず停止、次に調査**を徹底する。

#### ステップ 1: 即時対応（< 5 分）

**アヴァター関連**:

```bash
# Kill switch 発動
export KILL_SWITCH_AVATAR=true
export KILL_SWITCH_REASON="Fallback rate exceeded 50%"
# アプリ再起動不要、次リクエストから即座に無効化
```

**フロー異常**:

```bash
# 環境変数で予算を厳格化
export PHASE22_MAX_TURNS=8
export PHASE22_MAX_CLARIFY_REPEATS=1
export PHASE22_LOOP_WINDOW_TURNS=4
# 再起動必要
```

#### ステップ 2: ログ収集（< 10 分）

```bash
# 直近 1000 行の Phase22 イベントを抽出
tail -1000 logs/app.log \
  | jq 'select(.event | startswith("phase22."))' \
  > /tmp/phase22_incident_$(date +%Y%m%d_%H%M%S).json

# ターミナル理由の分布
jq -r '.meta.flow.terminalReason' /tmp/phase22_incident_*.json \
  | sort | uniq -c

# ループパターンの抽出
jq -r 'select(.event=="flow.loop_detected") | .meta.flow.pattern' \
  /tmp/phase22_incident_*.json
```

#### ステップ 3: 根本原因特定（< 30 分）

**チェックリスト**:

- [ ] Groq API のレート制限・障害
- [ ] Elasticsearch の遅延・ダウン
- [ ] pgvector 接続エラー
- [ ] 特定テナントの異常クエリ
- [ ] Planner のループ生成
- [ ] Lemon Slice の接続不良

#### ステップ 4: 恒久対策（< 24 時間）

- FAQ / Clarify Log の補強
- Planner ルールの調整
- 予算パラメータのチューニング
- 監視閾値の見直し

---

## ローカル計測方法

### 前提条件

- アプリケーションが起動済み（`pnpm dev`）
- ログが `logs/app.log` に出力されている
- Perf ログが `logs/perf/*.json` に存在する

### KPI 計測コマンド集

#### 1. Conversation Completion Rate

```bash
#!/bin/bash
# scripts/kpi_completion_rate.sh

completed=$(grep 'phase22.flow.terminal_reached' logs/app.log \
  | jq -r 'select(.meta.flow.terminalReason=="completed")' \
  | wc -l | tr -d ' ')

total=$(grep 'phase22.flow.terminal_reached' logs/app.log \
  | wc -l | tr -d ' ')

if [ "$total" -eq 0 ]; then
  echo "Completion Rate: N/A (no terminal events)"
else
  rate=$(awk -v c="$completed" -v t="$total" 'BEGIN {printf "%.1f", (c/t)*100}')
  echo "Completion Rate: ${rate}% (${completed}/${total})"

  # 閾値チェック（MVP: ≥70%）
  awk -v r="$rate" 'BEGIN {exit (r>=70)?0:1}' && echo "✓ OK" || echo "✗ BELOW TARGET"
fi
```

#### 2. Loop Detection Rate

```bash
#!/bin/bash
# scripts/kpi_loop_rate.sh

loops=$(grep 'phase22.flow.loop_detected' logs/app.log \
  | wc -l | tr -d ' ')

total=$(grep 'phase22.flow.terminal_reached' logs/app.log \
  | wc -l | tr -d ' ')

if [ "$total" -eq 0 ]; then
  echo "Loop Rate: N/A"
else
  rate=$(awk -v l="$loops" -v t="$total" 'BEGIN {printf "%.1f", (l/t)*100}')
  echo "Loop Rate: ${rate}% (${loops}/${total})"

  # 閾値チェック（MVP: <10%）
  awk -v r="$rate" 'BEGIN {exit (r<10)?0:1}' && echo "✓ OK" || echo "✗ ABOVE TARGET"
fi
```

#### 3. Avatar Fallback Rate

```bash
#!/bin/bash
# scripts/kpi_avatar_fallback.sh

requested=$(grep 'phase22.avatar.requested' logs/app.log \
  | wc -l | tr -d ' ')

# fallback + failed + disabled（PII 除外）
fallback=$(grep 'phase22.avatar' logs/app.log \
  | jq -r 'select(.event | test("fallback|failed|disabled_by_flag|disabled_by_kill_switch"))' \
  | wc -l | tr -d ' ')

if [ "$requested" -eq 0 ]; then
  echo "Fallback Rate: N/A (avatar not used)"
else
  rate=$(awk -v f="$fallback" -v r="$requested" 'BEGIN {printf "%.1f", (f/r)*100}')
  echo "Fallback Rate: ${rate}% (${fallback}/${requested})"

  # 閾値チェック（MVP: <30%）
  awk -v rt="$rate" 'BEGIN {exit (rt<30)?0:1}' && echo "✓ OK" || echo "✗ ABOVE TARGET"
fi
```

#### 4. Search Latency (from perf logs)

```bash
#!/bin/bash
# scripts/kpi_search_latency.sh

latest=$(ls -t logs/perf/*.json | head -n 1)

if [ -z "$latest" ]; then
  echo "Search Latency: N/A (no perf logs)"
  exit 1
fi

p50=$(jq -r '.latency.p50 // 0' "$latest")
p90=$(jq -r '.latency.p90 // .latency.p97_5 // 0' "$latest")
p95=$(jq -r '.latency.p95 // .latency.p97_5 // 0' "$latest")

echo "Search Latency (from $latest):"
echo "  p50: ${p50}ms"
echo "  p90: ${p90}ms"
echo "  p95: ${p95}ms"

# CI/CD ゲート（P90 ≤ 15ms）
awk -v p="$p90" 'BEGIN {exit (p<=15)?0:1}' && echo "✓ CI/CD OK" || echo "✗ CI/CD FAIL"

# 本番 SLA（P95 ≤ 1500ms - 将来の dialog 全体）
echo "(Note: 本番 SLA 1500ms は dialog 全体を対象とし、/search 単体は参考値)"
```

#### 5. RAG Latency (from app logs)

```bash
#!/bin/bash
# scripts/kpi_rag_latency.sh

grep 'dialog.rag.finished' logs/app.log \
  | jq -r '[.searchMs // 0, .rerankMs // 0, .totalMs // 0] | @tsv' \
  > /tmp/rag_metrics.tsv

if [ ! -s /tmp/rag_metrics.tsv ]; then
  echo "RAG Latency: N/A (no rag logs)"
  exit 0
fi

awk '{
  search[NR]=$1; rerank[NR]=$2; total[NR]=$3; n=NR
}
END {
  asort(search); asort(rerank); asort(total);
  p50_idx=int(n*0.5);
  p95_idx=int(n*0.95);
  printf "RAG Latency (N=%d):\n", n
  printf "  searchMs p50/p95: %.0f / %.0f ms\n", search[p50_idx], search[p95_idx]
  printf "  rerankMs p50/p95: %.0f / %.0f ms\n", rerank[p50_idx], rerank[p95_idx]
  printf "  totalMs p50/p95: %.0f / %.0f ms\n", total[p50_idx], total[p95_idx]
}' /tmp/rag_metrics.tsv
```

#### 6. Error Rate

```bash
#!/bin/bash
# scripts/kpi_error_rate.sh

errors=$(grep '"status":5' logs/app.log | wc -l | tr -d ' ')
total=$(grep 'dialog.run.start' logs/app.log | wc -l | tr -d ' ')

if [ "$total" -eq 0 ]; then
  echo "Error Rate: N/A"
else
  rate=$(awk -v e="$errors" -v t="$total" 'BEGIN {printf "%.2f", (e/t)*100}')
  echo "Error Rate: ${rate}% (${errors}/${total})"

  # 閾値チェック（MVP: <1%）
  awk -v r="$rate" 'BEGIN {exit (r<1)?0:1}' && echo "✓ OK" || echo "✗ ABOVE TARGET"
fi
```

#### 7. Kill Switch Status

```bash
#!/bin/bash
# scripts/kpi_kill_switch.sh

activations=$(grep 'phase22.avatar.disabled_by_kill_switch' logs/app.log \
  | wc -l | tr -d ' ')

echo "Kill Switch Activations: ${activations}"
echo "Current Status:"
echo "  KILL_SWITCH_AVATAR=${KILL_SWITCH_AVATAR:-false}"
echo "  KILL_SWITCH_REASON=${KILL_SWITCH_REASON:-none}"

if [ "${KILL_SWITCH_AVATAR:-false}" = "true" ]; then
  echo "⚠️  Kill Switch is ACTIVE"
else
  echo "✓ Kill Switch is inactive"
fi
```

---

## 統合チェックスクリプト（推奨）

```bash
#!/bin/bash
# scripts/phase23_daily_check.sh

echo "=========================================="
echo "Phase23 Daily KPI Check"
echo "=========================================="
echo "Date: $(date)"
echo

echo "--- 1. Conversation Completion Rate ---"
bash scripts/kpi_completion_rate.sh
echo

echo "--- 2. Loop Detection Rate ---"
bash scripts/kpi_loop_rate.sh
echo

echo "--- 3. Avatar Fallback Rate ---"
bash scripts/kpi_avatar_fallback.sh
echo

echo "--- 4. Search Latency ---"
bash scripts/kpi_search_latency.sh
echo

echo "--- 5. RAG Latency ---"
bash scripts/kpi_rag_latency.sh
echo

echo "--- 6. Error Rate ---"
bash scripts/kpi_error_rate.sh
echo

echo "--- 7. Kill Switch Status ---"
bash scripts/kpi_kill_switch.sh
echo

echo "=========================================="
echo "Check completed at $(date)"
echo "=========================================="
```

**使い方**:

```bash
# 日次チェック実行
bash scripts/phase23_daily_check.sh

# ログに保存
bash scripts/phase23_daily_check.sh | tee logs/phase23_check_$(date +%Y%m%d).log
```

---

## 既存スクリプトとの統合

Phase23 は既存のパフォーマンススクリプトを補完する位置づけです。

### 既存スクリプト

| スクリプト                      | 用途           | Phase23 での位置づけ             |
| ------------------------------- | -------------- | -------------------------------- |
| `pnpm run perf:budget`          | CI/CD ゲート   | そのまま利用（RPS/P90 チェック） |
| `pnpm run perf:summary`         | Perf ログ要約  | 週次レビューで利用               |
| `SCRIPTS/perf_summary.sh`       | サマリー生成   | そのまま利用                     |
| `SCRIPTS/analyze-agent-logs.ts` | Agent ログ分析 | RAG/Planner/Answer の p95 算出   |

### Phase23 新規スクリプト

上記「ローカル計測方法」で定義した 7 つの KPI 計測スクリプトを `scripts/` ディレクトリに配置することを推奨。

---

## Phase24 への引き継ぎ

Phase23 で定義した KPI・SLA は、Phase24 以降で次のように拡張される予定：

- **リアルタイムダッシュボード**: Grafana / Datadog 統合
- **自動アラート**: PagerDuty / Slack 連携
- **予測アラート**: p95 悪化の事前検知
- **カスタム SLA**: テナント別・地域別の SLA 設定
- **長期トレンド分析**: 月次・四半期レポート

---

## 関連ドキュメント

- [PHASE22.md](../PHASE22.md) - 制御可能性の確立（Phase22 設計）
- [PHASE22_IMPLEMENTATION.md](./PHASE22_IMPLEMENTATION.md) - Phase22 実装詳細
- [LOGGING_SCHEMA.md](./LOGGING_SCHEMA.md) - ログスキーマ定義
- [P95_METRICS.md](./P95_METRICS.md) - p95 計測ルール
- [AGENTS.md](../AGENTS.md) - Issue/PR 運用ガイド

---

## 記録

**作成日**: 2026-01-13  
**ステータス**: ✅ 完了  
**次フェーズ**: Phase24（Dashboard & Alerting）

---

**Phase23: KPI & SLA Definitions - 軽量監視フレームワークの確立**
