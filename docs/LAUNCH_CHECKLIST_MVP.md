# Launch Checklist: MVP Readiness

## 目的

本番環境またはステージング環境へのデプロイ前に、**30分以内**で実行可能な最小限のチェックリストです。

Phase22（制御可能性）とPhase23（KPI/SLA）の要件を満たしていることを確認します。

---

## 実行時間の目安

- **Preconditions**: 5分
- **Smoke Checks**: 3分
- **Performance Checks**: 10分
- **Reliability Checks**: 5分
- **Observability Checks**: 5分
- **Go/No-Go 判定**: 2分

**合計**: 約30分

---

## 1. Preconditions（前提条件）

### 1.1 必須環境変数

```bash
# .env または環境変数として設定
export PORT=3000
export ES_URL=http://localhost:9200
export DATABASE_URL=postgres://postgres:pass@127.0.0.1:5434/faq
export LOG_LEVEL=info

# Phase22 Flow Control（オプション、デフォルト値あり）
export PHASE22_MAX_TURNS=12
export PHASE22_MAX_SAME_STATE_REPEATS=3
export PHASE22_MAX_CLARIFY_REPEATS=2
export PHASE22_MAX_CONFIRM_REPEATS=2
export PHASE22_LOOP_WINDOW_TURNS=6

# Phase22 Avatar Control（オプション）
export FF_AVATAR_ENABLED=false              # 初回は無効推奨
export FF_AVATAR_FORCE_OFF=false
export KILL_SWITCH_AVATAR=false
export AVATAR_READINESS_TIMEOUT_MS=1500

# Groq API（必須、実際のキーに置き換え）
export GROQ_API_KEY=your_groq_api_key_here
```

**確認コマンド**:
```bash
# 必須変数のチェック
for var in PORT ES_URL DATABASE_URL GROQ_API_KEY; do
  if [ -z "${!var}" ]; then
    echo "❌ Missing: $var"
  else
    echo "✓ $var is set"
  fi
done
```

### 1.2 Docker スタック起動

```bash
# Elasticsearch + PostgreSQL を起動
pnpm run stack:up

# 起動待機（最大60秒）
pnpm run stack:wait

# 確認
docker ps | grep -E 'es-dev|pg-dev'
```

**期待結果**:
```
es-dev    ... Up ... 9200/tcp
pg-dev    ... Up ... 5434/tcp
```

### 1.3 データベース初期化

```bash
# Elasticsearch にサンプルデータをシード
pnpm run stack:seed:es

# PostgreSQL にサンプルデータをシード
pnpm run stack:seed:pg
```

**確認**:
```bash
# ES確認
curl -s http://localhost:9200/docs/_count | jq '.count'
# 期待: >= 3

# PG確認
PGPASSWORD=pass psql postgres://postgres:pass@127.0.0.1:5434/faq \
  -tAc "SELECT COUNT(*) FROM docs"
# 期待: >= 2
```

### 1.4 アプリケーションビルド

```bash
# TypeScript コンパイル
pnpm run build

# 確認
ls -l dist/index.js
```

---

## 2. Smoke Checks（基本動作確認）

### 2.1 ヘルスチェック

```bash
# /health エンドポイント
curl -s http://localhost:3000/health | jq .
```

**期待結果**:
```json
{
  "status": "ok",
  "timestamp": "2026-01-13T..."
}
```

**❌ 失敗時**:
- アプリが起動していない → `pnpm dev` または `pnpm start`
- ポートが使用中 → `lsof -ti:3000 | xargs kill -9`

### 2.2 検索エンドポイント

```bash
# /search エンドポイント
curl -s -X POST http://localhost:3000/search \
  -H 'Content-Type: application/json' \
  -d '{"q":"返品 送料"}' \
  | jq '{items: .items | length, sources: [.items[].source] | unique}'
```

**期待結果**:
```json
{
  "items": 5,
  "sources": ["es", "pgvector"]
}
```

**最小要件**: `items >= 1`

**❌ 失敗時**:
- `items: 0` → データがシードされていない → 1.3 を再実行
- `sources` に `es` がない → Elasticsearch ダウン → `docker ps` 確認

### 2.3 対話エンドポイント（オプション）

```bash
# /agent.dialog エンドポイント
curl -s -X POST http://localhost:3000/agent.dialog \
  -H 'Content-Type: application/json' \
  -d '{"message":"こんにちは","locale":"ja"}' \
  | jq '{text: .text | . [:50], route: .route}'
```

**期待結果**:
```json
{
  "text": "こんにちは！ご質問をお聞かせください。",
  "route": "20b"
}
```

**最小要件**: `text` が存在し、空でない

---

## 3. Performance Checks（パフォーマンス確認）

### 3.1 自動パフォーマンステスト

```bash
# アプリを起動（別ターミナル）
pnpm dev

# パフォーマンステスト実行（10秒 × 10並列）
pnpm run perf:save:auto
```

**実行時間**: 約2分（起動待機 + ベンチマーク）

### 3.2 パフォーマンス予算チェック

```bash
# 厳格な閾値でチェック（MVP要件）
RPS_MIN=5000 P90_MAX=15 pnpm run perf:budget
```

**期待出力**:
```
✓ PERF OK: RPS=5343 P90=11 ERR=0
```

**判定基準**:
- ✅ **PASS**: RPS ≥ 5000 AND P90 ≤ 15ms AND ERR = 0
- ❌ **FAIL**: 上記のいずれかを満たさない

### 3.3 結果の確認

```bash
# 最新のパフォーマンスログを表示
pnpm run perf:report
```

**期待結果例**:
```
report: logs/perf/20260113-123456.json
2026-01-13T12:34:56.789Z  2026-01-13T12:35:06.789Z  0  5343  628  11  0
```

**解釈**:
- フィールド: `start`, `finish`, `errors`, `RPS`, `p50`, `p90`, `p97_5`
- RPS: リクエスト/秒（5000以上が目標）
- p50/p90: レイテンシ（ms）
- errors: エラー数（0が目標）

---

## 4. Reliability Checks（Phase22 制御確認）

### 4.1 Avatar Kill Switch

**テスト**: Kill Switch を有効化してアヴァターが無効化されることを確認

```bash
# Kill Switch 発動
export KILL_SWITCH_AVATAR=true
export KILL_SWITCH_REASON="Launch checklist test"

# アプリ再起動（環境変数を反映）
# Ctrl+C で停止 → pnpm dev

# ログで確認（別ターミナル）
tail -f logs/app.log | grep 'phase22.avatar.disabled_by_kill_switch'
```

**期待結果**: アヴァター要求時に `disabled_by_kill_switch` イベントがログに出力

**テスト後のクリーンアップ**:
```bash
unset KILL_SWITCH_AVATAR
unset KILL_SWITCH_REASON
# アプリ再起動
```

### 4.2 Feature Flag

**テスト**: Feature Flag でアヴァターを無効化

```bash
# Flag で無効化
export FF_AVATAR_ENABLED=false

# または強制無効化
export FF_AVATAR_FORCE_OFF=true

# ログで確認
tail -f logs/app.log | grep 'phase22.avatar.disabled_by_flag'
```

**期待結果**: `disabled_by_flag` イベントがログに出力

**クリーンアップ**:
```bash
unset FF_AVATAR_ENABLED
unset FF_AVATAR_FORCE_OFF
```

### 4.3 PII Fallback

**テスト**: PII導線でアヴァターが自動無効化されることを確認

```bash
# PII を含むメッセージ（支払い情報）
curl -s -X POST http://localhost:3000/agent.dialog \
  -H 'Content-Type: application/json' \
  -d '{"message":"クレジットカードで支払いたい","locale":"ja"}' \
  | jq .

# ログで確認
grep 'phase22.avatar.forced_off_pii' logs/app.log | tail -1 | jq .
```

**期待結果**: 
- レスポンスは正常に返る（会話は継続）
- ログに `forced_off_pii` イベントが記録される

### 4.4 Flow Budget Enforcement

**テスト**: ターン数上限で会話が終了することを確認

```bash
# 厳格な予算で起動（テスト用）
export PHASE22_MAX_TURNS=3

# アプリ再起動

# 3ターン以上の会話を試行（手動またはスクリプト）
# ターン数が上限を超えたら terminal に到達することを確認

# ログで確認
grep 'phase22.flow.terminal_reached' logs/app.log | tail -1 | jq .
```

**期待結果**: 
- `terminalReason: "aborted_budget"` で終了
- 無限ループに陥らない

**クリーンアップ**:
```bash
unset PHASE22_MAX_TURNS  # デフォルトの12に戻る
```

---

## 5. Observability Checks（可観測性確認）

### 5.1 Phase22 イベント確認

**テスト**: Phase22 の全イベント型がログに出力可能か確認

```bash
# Phase22 イベント一覧（直近100行）
tail -100 logs/app.log | jq -r 'select(.event | startswith("phase22.")) | .event' | sort | uniq -c
```

**期待結果**（例）:
```
   5 phase22.avatar.disabled_by_flag
   2 phase22.flow.enter_state
   2 phase22.flow.exit_state
   1 phase22.flow.terminal_reached
```

**最小要件**: 少なくとも `flow.terminal_reached` が1件以上

### 5.2 Flow イベント確認

```bash
# Flow イベントの詳細
grep 'phase22.flow' logs/app.log | tail -5 | jq '{event, meta}'
```

**確認ポイント**:
- `flow.enter_state`: 状態遷移開始
- `flow.exit_state`: 状態遷移終了
- `flow.terminal_reached`: 終端到達
- `flow.loop_detected`: ループ検出（発生していれば）

### 5.3 Avatar イベント確認

```bash
# Avatar イベントの詳細
grep 'phase22.avatar' logs/app.log | tail -5 | jq '{event, meta}'
```

**確認ポイント**:
- `avatar.requested`: アヴァター要求
- `avatar.disabled_by_flag`: Flag無効化
- `avatar.forced_off_pii`: PII導線無効化

### 5.4 RAG Latency 確認

```bash
# dialog.rag.finished から searchMs を抽出
grep 'dialog.rag.finished' logs/app.log \
  | jq -r '[.searchMs, .rerankMs, .totalMs] | @tsv' \
  | awk '{
      if ($3 > 1500) slow++; total++
    } END {
      print "RAG総計:", total, "件"
      print "1.5秒超過:", slow, "件", "(" (slow/total*100) "%)"
    }'
```

**期待結果**:
- 1.5秒超過が 10% 未満（MVP要件）

### 5.5 Hybrid Search 確認（オプション）

```bash
# searchMs（hybrid_ms相当）が1500ms超過のクエリを検出
grep 'dialog.rag.finished' logs/app.log \
  | jq -r 'select(.searchMs > 1500) | {timestamp: .time, searchMs, tenantId}'
```

**期待結果**: 該当なし、または少数（< 5%）

---

## 6. Go/No-Go 判定基準

### 判定テーブル

| チェック項目 | 合格基準 | 重要度 | 判定 |
|-------------|---------|-------|------|
| **1. Preconditions** | 全環境変数が設定済み | 🔴 必須 | ☐ |
| **1. Preconditions** | Docker スタック起動 | 🔴 必須 | ☐ |
| **1. Preconditions** | データがシード済み | 🔴 必須 | ☐ |
| **2. Smoke Checks** | /health が OK を返す | 🔴 必須 | ☐ |
| **2. Smoke Checks** | /search が結果を返す | 🔴 必須 | ☐ |
| **3. Performance** | RPS ≥ 5000 | 🔴 必須 | ☐ |
| **3. Performance** | P90 ≤ 15ms | 🔴 必須 | ☐ |
| **3. Performance** | Errors = 0 | 🔴 必須 | ☐ |
| **4. Reliability** | Kill Switch が動作 | 🟡 推奨 | ☐ |
| **4. Reliability** | Feature Flag が動作 | 🟡 推奨 | ☐ |
| **4. Reliability** | PII Fallback が動作 | 🟡 推奨 | ☐ |
| **5. Observability** | Phase22 イベント出力 | 🟡 推奨 | ☐ |
| **5. Observability** | RAG 1.5s超過 < 10% | 🟢 推奨 | ☐ |

### Go/No-Go 判定ロジック

**✅ GO（本番デプロイ可）**:
- 🔴 必須項目: **すべて合格**
- 🟡 推奨項目: **80%以上合格**（5/6以上）

**❌ NO-GO（デプロイ延期）**:
- 🔴 必須項目: **1つでも不合格**
- 🟡 推奨項目: **50%未満合格**（3/6未満）

**⚠️ CONDITIONAL（条件付きGO）**:
- 🔴 必須項目: **すべて合格**
- 🟡 推奨項目: **50-80%合格**（3-4/6）
- 条件: 不合格項目のリスクが限定的であること

---

## 7. No-Go 時の対応

### 7.1 よくある失敗と修正方法

#### ❌ 1. Elasticsearch がダウン

**症状**:
```bash
curl http://localhost:9200
# curl: (7) Failed to connect
```

**修正**:
```bash
# Docker コンテナ確認
docker ps -a | grep es-dev

# 起動していない場合
docker start es-dev

# 完全に削除して再作成
docker rm -f es-dev
pnpm run stack:up
pnpm run stack:wait
pnpm run stack:seed:es
```

**検証**:
```bash
curl -s http://localhost:9200 | jq .
# 期待: cluster_name, version などが返る
```

---

#### ❌ 2. PostgreSQL 接続エラー

**症状**:
```bash
PGPASSWORD=pass psql postgres://postgres:pass@127.0.0.1:5434/faq -c 'SELECT 1'
# psql: error: connection to server ... failed
```

**修正**:
```bash
# Docker コンテナ確認
docker ps -a | grep pg-dev

# 起動していない場合
docker start pg-dev

# データベースが存在しない場合
pnpm run stack:seed:pg

# 完全に削除して再作成
docker rm -f pg-dev
pnpm run stack:up
pnpm run stack:wait
pnpm run stack:seed:pg
```

**検証**:
```bash
PGPASSWORD=pass psql postgres://postgres:pass@127.0.0.1:5434/faq -tAc "SELECT COUNT(*) FROM docs"
# 期待: >= 2
```

---

#### ❌ 3. パフォーマンス不安定（RPS < 5000 または P90 > 15ms）

**症状**:
```bash
pnpm run perf:budget
# ✗ RPS 4532 < 5000
# または
# ✗ P90 18 > 15
```

**修正**:

**A. Elasticsearch インデックス最適化**:
```bash
# インデックスリフレッシュ
curl -X POST http://localhost:9200/docs/_refresh

# インデックス統計確認
curl -s http://localhost:9200/docs/_stats | jq '.indices.docs'
```

**B. pgvector 無効化（一時的）**:
```bash
# pgvector を無効化してパフォーマンス改善
# src/agent/flow/searchAgent.ts の pgvector 呼び出しをコメントアウト
# または環境変数で制御（実装されている場合）
export DISABLE_PGVECTOR=true
pnpm run build
```

**C. 並列度調整**:
```bash
# より軽い負荷でテスト
BODY='{"q":"返品 送料"}' npx autocannon -d 10 -c 5 -p 2 \
  -m POST -H 'Content-Type: application/json' -b "$BODY" \
  http://localhost:3000/search
```

**D. ウォームアップ**:
```bash
# 初回リクエストは遅いため、ウォームアップしてから計測
for i in {1..10}; do
  curl -s -X POST http://localhost:3000/search \
    -H 'Content-Type: application/json' \
    -d '{"q":"test"}' > /dev/null
done

# 再度パフォーマンステスト
pnpm run perf:save:auto
RPS_MIN=5000 P90_MAX=15 pnpm run perf:budget
```

**検証**:
```bash
pnpm run perf:report
# RPS と P90 が基準内に収まることを確認
```

---

#### ❌ 4. ログが出力されない

**症状**:
```bash
grep 'phase22' logs/app.log
# (何も出力されない)
```

**修正**:

**A. ログディレクトリ確認**:
```bash
# ログディレクトリ作成
mkdir -p logs

# ログレベル確認
echo $LOG_LEVEL
# 期待: info または debug
```

**B. アプリ起動方法確認**:
```bash
# 正しい起動方法（ログファイルにリダイレクト）
pnpm start 2>&1 | tee logs/app.log

# または開発モード
pnpm dev 2>&1 | tee logs/app.log
```

**C. pino ロガー確認**:
```bash
# pino が正しくインストールされているか
npm list pino
# 期待: pino@10.1.0 または類似バージョン
```

**検証**:
```bash
# アプリを数リクエスト実行後
tail -10 logs/app.log | jq .
# JSON形式のログが出力されることを確認
```

---

#### ❌ 5. Avatar Readiness エンドポイントが応答しない

**症状**:
```bash
# LEMON_SLICE_READINESS_URL が設定されている場合
curl -s ${LEMON_SLICE_READINESS_URL}
# curl: (7) Failed to connect
```

**修正**:

**A. アヴァターを無効化して本体を起動**:
```bash
# MVP ローンチではアヴァターを無効化推奨
export FF_AVATAR_ENABLED=false

# アプリ再起動
pnpm dev
```

**B. Readiness URL 確認**:
```bash
# URL が正しいか確認
echo $LEMON_SLICE_READINESS_URL

# 未設定の場合はデフォルト動作（アヴァター無効）
unset LEMON_SLICE_READINESS_URL
```

**C. フォールバック動作確認**:
```bash
# アヴァターが失敗してもテキストUIにフォールバックすることを確認
curl -s -X POST http://localhost:3000/agent.dialog \
  -H 'Content-Type: application/json' \
  -d '{"message":"こんにちは","locale":"ja"}' \
  | jq '{text, meta: {adapter: .meta.adapter}}'

# meta.adapter.status が "fallback_to_text" または "disabled" であることを確認
```

**検証**:
```bash
# ログでフォールバック確認
grep 'phase22.avatar.fallback_to_text' logs/app.log | tail -1 | jq .
```

---

### 7.2 緊急時の最小構成

すべてのチェックが通らない場合、**最小構成で起動**して問題を切り分け：

```bash
# 1. アヴァター機能を完全無効化
export FF_AVATAR_ENABLED=false
export FF_AVATAR_FORCE_OFF=true

# 2. pgvector を無効化（実装による）
export DISABLE_PGVECTOR=true

# 3. ログレベルを debug に変更
export LOG_LEVEL=debug

# 4. シンプルな検索のみテスト
pnpm dev

# 別ターミナル
curl -s -X POST http://localhost:3000/search \
  -H 'Content-Type: application/json' \
  -d '{"q":"test"}' | jq .
```

**判定**:
- ✅ 検索が動作 → 追加機能を1つずつ有効化
- ❌ 検索も失敗 → 基盤（ES/PG/アプリ）の問題

---

### 7.3 エスカレーション

以下の場合、チームエスカレーションが必要：

1. **Groq API エラー**:
   ```bash
   grep 'Groq' logs/app.log | grep -i error
   ```
   → API キー確認、レート制限確認、Groq ステータスページ確認

2. **Docker リソース不足**:
   ```bash
   docker stats
   ```
   → メモリ/CPU が逼迫している場合、Docker Desktop 設定を調整

3. **TypeScript コンパイルエラー**:
   ```bash
   pnpm run build
   ```
   → エラーメッセージを確認、依存関係の再インストール（`pnpm install`）

4. **環境依存の問題**:
   - macOS バージョン
   - Node.js バージョン（20.x 推奨）
   - Docker Desktop バージョン

---

## 8. チェックリスト実行スクリプト

### 統合チェックスクリプト（推奨）

```bash
#!/bin/bash
# scripts/launch_checklist.sh

set -e
echo "=========================================="
echo "Launch Checklist: MVP Readiness"
echo "=========================================="
echo "Start: $(date)"
echo

# 1. Preconditions
echo "--- 1. Preconditions ---"
echo "Checking environment variables..."
for var in PORT ES_URL DATABASE_URL GROQ_API_KEY; do
  if [ -z "${!var}" ]; then
    echo "❌ Missing: $var"
    exit 1
  else
    echo "✓ $var is set"
  fi
done

echo "Checking Docker stack..."
docker ps | grep -E 'es-dev|pg-dev' || {
  echo "❌ Docker stack not running"
  exit 1
}
echo "✓ Docker stack is running"
echo

# 2. Smoke Checks
echo "--- 2. Smoke Checks ---"
echo "Checking /health..."
curl -sf http://localhost:3000/health > /dev/null || {
  echo "❌ /health failed"
  exit 1
}
echo "✓ /health OK"

echo "Checking /search..."
result=$(curl -sf -X POST http://localhost:3000/search \
  -H 'Content-Type: application/json' \
  -d '{"q":"test"}' | jq -r '.items | length')
if [ "$result" -ge 1 ]; then
  echo "✓ /search OK (items: $result)"
else
  echo "❌ /search failed (items: $result)"
  exit 1
fi
echo

# 3. Performance Checks
echo "--- 3. Performance Checks ---"
echo "Skipping perf:save:auto (run manually if needed)"
echo "Checking latest perf log..."
latest=$(ls -t logs/perf/*.json 2>/dev/null | head -n 1)
if [ -n "$latest" ]; then
  rps=$(jq -r '.requests.average' "$latest")
  p90=$(jq -r '.latency.p90 // .latency.p97_5 // 0' "$latest")
  echo "Latest perf: RPS=$rps P90=$p90"
  
  if awk -v r="$rps" 'BEGIN{exit (r>=5000)?0:1}' && \
     awk -v p="$p90" 'BEGIN{exit (p<=15)?0:1}'; then
    echo "✓ Performance OK"
  else
    echo "⚠️  Performance below target (RPS<5000 or P90>15)"
  fi
else
  echo "⚠️  No perf logs found (run pnpm run perf:save:auto)"
fi
echo

# 4. Reliability Checks
echo "--- 4. Reliability Checks ---"
echo "✓ Kill Switch: ${KILL_SWITCH_AVATAR:-false}"
echo "✓ Feature Flag: ${FF_AVATAR_ENABLED:-false}"
echo

# 5. Observability Checks
echo "--- 5. Observability Checks ---"
phase22_count=$(grep -c 'phase22\.' logs/app.log 2>/dev/null || echo 0)
if [ "$phase22_count" -gt 0 ]; then
  echo "✓ Phase22 events found: $phase22_count"
else
  echo "⚠️  No Phase22 events in logs"
fi
echo

echo "=========================================="
echo "Checklist completed at $(date)"
echo "=========================================="
echo
echo "Next steps:"
echo "1. Review any ⚠️  warnings above"
echo "2. Run manual performance test: pnpm run perf:save:auto"
echo "3. Check Go/No-Go criteria in docs/LAUNCH_CHECKLIST_MVP.md"
```

**使い方**:
```bash
# スクリプトに実行権限を付与
chmod +x scripts/launch_checklist.sh

# 実行
bash scripts/launch_checklist.sh

# ログに保存
bash scripts/launch_checklist.sh | tee logs/launch_check_$(date +%Y%m%d_%H%M%S).log
```

---

## 9. MVP ローンチ後の推奨アクション

### ローンチ直後（0-24時間）

```bash
# 1時間ごとにKPIチェック
bash scripts/phase23_daily_check.sh

# Phase22イベント監視
tail -f logs/app.log | grep 'phase22\.'

# エラー監視
tail -f logs/app.log | grep '"level":"error"'
```

### 初日終了時（24時間後）

```bash
# 1日分のKPI集計
bash scripts/phase23_daily_check.sh | tee logs/day1_kpi.log

# 会話完了率確認
bash scripts/kpi_completion_rate.sh

# ループ検出率確認
bash scripts/kpi_loop_rate.sh

# パフォーマンス推移確認
pnpm run perf:summary
```

### 1週間後

```bash
# 週次レビュー
- KPI 推移の確認
- Kill Switch 発動履歴のレビュー
- パフォーマンス回帰の有無
- ユーザーフィードバックの収集
```

---

## 関連ドキュメント

- [PHASE22.md](../PHASE22.md) - 制御可能性の確立
- [PHASE23.md](./PHASE23.md) - KPI & SLA 定義
- [PHASE22_IMPLEMENTATION.md](./PHASE22_IMPLEMENTATION.md) - Phase22 実装詳細
- [P95_METRICS.md](./P95_METRICS.md) - p95 計測ルール
- [LOGGING_SCHEMA.md](./LOGGING_SCHEMA.md) - ログスキーマ定義

---

## 記録

**作成日**: 2026-01-13  
**対象**: MVP ローンチ準備  
**実行時間**: 約30分  
**前提**: Phase22/23 完了済み

---

**Launch Checklist: MVP Readiness - 30分で本番準備完了**
