# Phase69-3 Pre-Investigation: Kill-switch 1分SLA Enforcement

**Asana:** 1214468044271468 (子タスク) / 親: 1214250247468775  
**調査日:** 2026-05-03  
**調査担当:** Claude Code CLI  
**目的:** Phase69-3 実装前の現状把握。実装なし、ドキュメント化のみ。

---

## 1. 既存実装サマリ

### 関連ファイル

| ファイル | 役割 | Phase |
|---|---|---|
| `src/agent/avatar/avatarPolicy.ts` | Avatar kill-switch ポリシー判定 | Phase22 |
| `src/agent/http/presentation/lemonSliceAdapter.ts` | kill-switch 時の avatar 無効化 (`kill_switch:{reason}`) | Phase22 |
| `src/agent/orchestrator/langGraphOrchestrator.ts` | `avatarDecision.status === 'disabled_by_kill_switch'` 処理 | Phase22 |
| `src/agent/observability/phase22EventLogger.ts` | `avatar.disabled_by_kill_switch` イベントログ | Phase22 |
| `src/lib/metrics/kpiDefinitions.ts` | `KILL_SWITCH_ACTIVE: "rajiuce_kill_switch_active"` Prometheus metric定義 | Phase24 |
| `src/lib/metrics/promExporter.ts` | `killSwitchGauge` (Gauge metric) | Phase24 |
| `src/lib/metrics/metricsCollector.ts` | `killSwitchGauge.set()` 呼び出し | Phase24 |
| `src/lib/alerts/alertRules.ts` | `kill_switch_active` アラートルール | Phase24 |
| `src/lib/alerts/alertEngine.ts` | killSwitch Map 集計 + Slack Alert | Phase24 |
| `src/api/admin/monitoring/routes.ts` | `killSwitchActive` KPI API (現状: **常時 false**)  | Phase24 |
| `src/api/admin/tenants/routes.ts` | `PATCH /v1/admin/tenants/:id` → `is_active` 更新 | Phase31 |
| `src/ui/adapter/adapterTypes.ts` | `"disabled"` ステータス (kill-switch/flag/pii 等) | Phase22 |
| `admin-ui/src/components/admin/TenantSlaTable.tsx` | UI: `killSwitchOff: boolean` 表示 (緊急停止スイッチ) | Phase24 |
| `admin-ui/src/pages/admin/monitoring/index.tsx` | 監視ダッシュボード: `killSwitchActive` 表示 | Phase24 |

### DB スキーマ

**現状の `tenants` テーブル関連カラム** (`src/api/admin/tenants/migration.sql`)：

```sql
tenants:
  id TEXT PRIMARY KEY,
  name TEXT,
  plan TEXT CHECK (plan IN ('starter', 'growth', 'enterprise')),
  is_active BOOLEAN NOT NULL DEFAULT true,   -- テナント有効/無効の唯一のフラグ
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
```

**不在のカラム（Phase69-3で追加が必要）：**
- `kill_switch_activated_at TIMESTAMPTZ` — kill-switch 発動タイムスタンプ
- `kill_switch_reason TEXT` — 発動理由
- `kill_switch_enforced_at TIMESTAMPTZ` — 実際に遮断が確認されたタイムスタンプ
- `kill_switch_latency_ms INTEGER` — SLA計測用: 発動→遮断の所要時間

### 現状の kill-switch スコープ

**Phase22 kill-switch はアバター機能専用**:
- `avatarPolicy.ts` の `killSwitch: { enabled: boolean, reason?: string }` は request-time の policy input
- DB に永続化されていない（毎リクエスト orchestrator が渡す値）
- **テナント全体の遮断とは別物**

**テナント全体停止の現状**:
- `is_active = false` を PATCH で設定すれば即時遮断（`GET /api/widget` で `is_active` チェック）
- ただし「いつ発動したか」「何秒で反映されたか」を記録する仕組みなし

### Admin UI 現状

| コンポーネント | 表示内容 | CRUD |
|---|---|---|
| `TenantSlaTable.tsx` | `killSwitchOff` フラグを表示 | 読取のみ |
| `monitoring/index.tsx` | `killSwitchActive` を「稼働中/停止中」表示 | 読取のみ |
| テナント詳細 | `is_active` トグルあり（super_admin） | 更新可 |

**Kill-switch を直接トリガーする UI ボタンは存在しない。**  
`killSwitchActive` は API から取得するが、現状 API は常時 `false` を返す。

---

## 2. 既存テスト

### ユニットテスト (kill / suspend / kill-switch 関連)

| ファイル | テスト数 | 内容 |
|---|---|---|
| `tests/agent/avatar/killSwitch.test.ts` | 13件 | Avatar kill-switch 発動・優先順位・環境変数統合 |
| `tests/agent/avatar/avatarIntegration.test.ts` | ~5件 | `disabled_by_kill_switch` ステータス確認 |
| `tests/agent/observability/phase22Logging.test.ts` | ~5件 | `avatar.disabled_by_kill_switch` イベントログ |

**合計: ユニットテスト 約23件**（全て Phase22 Avatar kill-switch 専用）

### E2E テスト (Playwright)

`tests/e2e/` 配下: `responsive.spec.ts`, `admin-login.spec.ts`, `widget-fab-avatar.spec.ts`, `avatar-test-button.spec.ts`, `phase65-demo.spec.ts`, `widget.spec.ts`, `health.spec.ts`

**kill / suspend / SLA enforcement に関するE2Eテストは存在しない。**

---

## 3. VPS現状

> ⚠️ SSH コマンドは deploy_guard.py によりブロックされるため、CLI からの直接確認不可。  
> Gate 4b / Gate 5 でのブラウザ・手動確認が必要。

### PM2 status
- 確認方法: `! ssh root@65.108.159.161 "pm2 list"` をターミナルで実行
- rajiuce-api の起動時間・restarts 件数は手動確認要

### 停止中テナント件数
- 確認クエリ (VPS の psql で実行):
  ```sql
  SELECT COUNT(*) FROM tenants WHERE is_active = false;
  ```

### Cloudflare Workers

| Worker | Cron | Kill-switch endpoint |
|---|---|---|
| `r2c-analytics-worker` | `*/10 * * * *` | **なし** |

- `handlers/errorNotifyHandler.ts`: VPS → Worker への通知用 POST エンドポイント
- `handlers/ga4HealthCheckHandler.ts`: GA4 ヘルスチェック
- Kill-switch トリガー・確認用のエンドポイントは**現時点で存在しない**

---

## 4. SLA計測

### 既存の latency 計測

| 計測箇所 | 計測内容 | 精度 |
|---|---|---|
| `src/index.ts:268-282` | RAG 全体 (`duration_ms`) + 検索/rerank 個別 | Date.now() |
| `src/agent/http/agentSearchRoute.ts:73-90` | agent.search エンドポイント (`durationMs`) | Date.now() |
| `src/agent/orchestrator/llmCalls.ts:283-301` | LLM 生成 (`latencyMs`) → PostHog 送信 | Date.now() |
| `src/agent/llm/groqClient.ts:261-278` | Groq API 試行単位 (`latencyMs`) | Date.now() |
| `src/api/admin/monitoring/routes.ts:132` | `searchP95Ms: 500` — **ハードコード固定値**（実計測なし） | N/A |

**「Kill-switch 発動 → 実遮断」の往復計測は存在しない。**

### 1分SLA の計測に必要なタイムスタンプ取得ポイント（提案）

```
T0: kill_switch_activated_at  ← 管理者が PATCH /tenants/:id を叩いた瞬間
T1: kill_switch_enforced_at   ← 次のリクエストで is_active=false を DB から読んだ瞬間
SLA = T1 - T0 ≤ 60,000ms
```

Prometheus metric 案:
```
rajiuce_kill_switch_enforce_latency_ms (Gauge/Histogram)
  labels: tenant_id, reason
```

---

## 5. Phase69-3 実装に必要なもの

### 新規 API エンドポイント

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/v1/admin/tenants/:id/kill-switch` | Kill-switch 即時発動（super_admin 限定） |
| `DELETE` | `/v1/admin/tenants/:id/kill-switch` | Kill-switch 解除 |
| `GET` | `/v1/admin/tenants/:id/kill-switch/status` | SLA達成確認（発動から何秒で反映されたか） |

### DB マイグレーション（新規カラム）

```sql
ALTER TABLE tenants
  ADD COLUMN kill_switch_activated_at TIMESTAMPTZ,
  ADD COLUMN kill_switch_reason TEXT,
  ADD COLUMN kill_switch_enforced_at TIMESTAMPTZ,
  ADD COLUMN kill_switch_latency_ms INTEGER;
```

> **注意:** `is_active = false` で遮断する既存動作を壊さないこと。  
> Kill-switch 発動時は `is_active = false` + `kill_switch_activated_at = NOW()` を同時更新。

### Workers Cron 改修

`r2c-analytics-worker` の `*/10 * * * *` Cron で以下を追加検討:
- VPS API: `GET /v1/admin/kill-switch/pending` を poll（発動済み・未計測のテナントを取得）
- `kill_switch_enforced_at` が null のテナントに対し、API の応答が 403 になることを確認
- 確認後 `kill_switch_enforced_at = NOW()` と `kill_switch_latency_ms` を VPS API に PATCH

### Monitor tool での測定スクリプト（Claude Code 2.1.120）

Phase69-3 実装後の SLA 測定に Monitor tool を活用できる:

```bash
# パターン1: pm2 logs を流して kill-switch イベントを監視
pm2 logs rajiuce-api --lines 0 --raw | grep "kill_switch"
# → Monitor tool で各ラインを通知 → T0/T1 タイムスタンプを抽出

# パターン2: DB ポーリングで SLA 達成確認
while true; do
  psql $DATABASE_URL -c "SELECT id, kill_switch_activated_at, kill_switch_enforced_at, kill_switch_latency_ms FROM tenants WHERE kill_switch_activated_at IS NOT NULL ORDER BY kill_switch_activated_at DESC LIMIT 5;"
  sleep 5
done
# → Monitor tool で未計測行を検知したら通知

# パターン3: curl で API 応答確認
curl -s -o /dev/null -w "%{http_code}" -H "x-api-key: $TEST_KEY" https://api.r2c.biz/api/chat
# → 403 返却を Monitor tool でポーリング確認
```

**最適な Monitor tool ターゲット: パターン1（pm2 logs ストリーミング）**  
理由: リアルタイム性が高く、kill-switch イベントのログ行がそのまま測定起点になる。

---

## 6. 実装リスクと注意点

| リスク | 影響 | 対策 |
|---|---|---|
| `is_active = false` による既存の遮断との二重管理 | テナントが kill-switch 解除後も is_active=false のまま停止 | kill-switch 解除時に is_active も true に戻す |
| Cloudflare Worker が VPS の is_active 変更を 10分後にしか拾えない | SLA が Cron 間隔 (10分) に依存 | Cron を `*/1 * * * *` に変更 or VPS → Worker の Push モデル導入 |
| `kill_switch_enforced_at` の計測タイミングが不明確 | SLA 数値の信頼性低下 | 「次のチャットリクエスト到達時」と定義し widget route で記録 |
| 既存 `killSwitchActive: false` のハードコード | monitoring/kpis が常時 false を返す | KPI API を DB 参照に差し替える |

---

## 参考ドキュメント

- `docs/PHASE22_IMPLEMENTATION.md` — Avatar Kill Switch 詳細仕様
- `docs/PHASE_A_CLOUDFLARE_WORKERS.md` — r2c-analytics-worker 構成
- `src/api/admin/tenants/migration.sql` — tenants テーブル DDL
- `src/types/contracts.ts` — TenantSla 型定義
